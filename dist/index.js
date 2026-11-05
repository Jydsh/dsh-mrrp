import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { installRpc } from './rpc.js';
import { MrrpConfigStore } from './store.js';
import { makeLayaDecide } from './decision.js';
import { makeImReader } from './dshim.js';
import { createImRouting, pruneRouteLogDir, pruneRouteLogFile, routeLogPathFor } from './route-engine.js';
import { readDingtalkBridgeSessions } from './dingtalk-bridge.js';
import { createRouteAdapter } from './route-adapter.js';
import { checkLatestVersion, getCurrentVersion, isAtLeast } from './updater.js';
/**
 * dsh-mrrp: MRRP（Model Routing & Resource Planning）控制台插件。
 *
 * host 侧职责：
 *   - 通过 DSH 的 llm 服务只读发现已注册的模型提供方与模型列表；
 *   - 在 ~/.dsh/integrations/dsh-mrrp/config.json 持久化模型分类 / 路由配置 / 角色部门 / 用户 / 决策模型提供方；
 *   - 通过 POST /api/mrrp RPC 通道把这些能力暴露给 MRRP 控制台（client）；
 *   - 注册 laya_decide 工具：调用本地 laya-server 决策模型（TypeSafe Jev 协议，POST /v1/systemone）；
 *   - dsh-im 集成：只读扫描 dsh-im 群历史库（sender_id / sender_name），首次出现的发送者自动创建用户
 *     （id = senderId 唯一标识），并可通过 users.resolve / users.syncIm RPC 按 senderId 解析姓名；
 *   - 决策模型路由（新方案）：通过 ctx.llm.registerAdapter 把「MRRP 智能路由」作为虚拟模型暴露到
 *     DSH 对话的模型选择器；对话选中后，adapter 按会话发送者（会话事件观测映射）解析用户，
 *     取用户（单独角色 + 所属部门角色）绑定的模型分类并去重，候选多个时用内置判定问题请
 *     laya 决策模型选一个，随后代理该模型（ctx.llm.stream）生成回复。
 *
 * 原则：绝不注册任何 hook / 中间件拦截 DSH 主链路——adapter 是宿主正规的「提供方」扩展点，
 * 事件观测只读建立会话→发送者映射；dsh-im 同步为后台只读轮询（默认 60s，可配置关闭）。
 * tools 注入是可选能力：运行时不提供 tools 时仅跳过工具注册，不影响控制台与 DSH 启动。
 */
export const name = 'dsh-mrrp';
export const inject = ['connection', 'llm'];
function makeLogger(ctx) {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('dsh-mrrp') : ctx?.logger;
    const safe = logger && typeof logger === 'object' ? logger : console;
    return {
        info: (...args) => safe.info?.(...args),
        warn: (...args) => safe.warn?.(...args),
        error: (...args) => safe.error?.(...args),
        debug: (...args) => safe.debug?.(...args),
    };
}
/** 路由诊断日志器：写当天按天日志文件（route-decision-YYYY-MM-DD.log，append JSON 行）并透传宿主 logger。
 *  供会话发送者观测（im-route）使用，与 adapter 的路由决策日志共用同一文件（按天分文件）。 */
function makeRouteLogger(logDir, host) {
    const emit = (level, args) => {
        let message = '';
        for (const arg of args) {
            message += (message ? ' ' : '')
                + (typeof arg === 'string' ? arg : safeJson(arg));
        }
        const line = JSON.stringify({ ts: new Date().toISOString(), scope: 'im-route', level, message });
        try {
            appendFileSync(routeLogPathFor(logDir), `${line}\n`, 'utf8');
        }
        catch { /* 写失败不阻塞主链路 */ }
        try {
            host?.[level]?.(`[dsh-mrrp:im-route]`, ...args);
        }
        catch { /* ignore */ }
    };
    return {
        info: (...args) => emit('info', args),
        warn: (...args) => emit('warn', args),
        error: (...args) => emit('error', args),
        debug: (...args) => emit('debug', args),
    };
}
function safeJson(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
export async function apply(ctx, config = {}) {
    const logger = makeLogger(ctx);
    const store = new MrrpConfigStore(config.configPath);
    // 路由决策日志目录：与 config.json 同目录，按天分文件（route-decision-YYYY-MM-DD.log，append JSON 行）
    const routeLogDir = dirname(store.path);
    // 会话发送者观测日志：写当天日志文件（与 adapter 共用），宿主 logger 透传。
    const routeLogger = makeRouteLogger(routeLogDir, logger);
    try {
        await store.load();
        // 启动时清理一次路由决策日志（删除超过保留天数的历史按天文件 + 当天文件内过期行；失败静默不影响启动）
        try {
            const retention = store.get().logRetentionDays || 30;
            pruneRouteLogDir(routeLogDir, retention);
            pruneRouteLogFile(routeLogPathFor(routeLogDir), retention);
        }
        catch { /* ignore */ }
    }
    catch (error) {
        logger.error?.('[dsh-mrrp] failed to load config, using defaults:', error?.message ?? error);
    }
    // 模型发现只读使用 DSH 的 llm 服务（注入后可通过 ctx.llm 访问）。
    const llm = ctx?.llm;
    const rpcConfig = config;
    // im 读取器：测试 / 定制场景可注入（config.im 或 config.imDbPath），默认读 ~/.dsh 的 dsh-im 库。
    const im = rpcConfig?.im ?? makeImReader(typeof rpcConfig?.imDbPath === 'string' ? rpcConfig.imDbPath : undefined);
    // IM 消息路由引擎：常驻订阅 DSH 会话事件 + 只读 dsh-dingtalk 桥会话映射，
    // 建立「会话 → 发送者」映射，供决策模型路由 adapter 解析用户。只观测不拦截，异常静默降级。
    const imRouting = createImRouting(ctx, {
        getConfig: () => store.get(),
        logger: routeLogger,
        dingtalkBridge: { readSessions: () => readDingtalkBridgeSessions() },
    });
    try {
        imRouting.start();
    }
    catch (error) {
        logger.error?.('[dsh-mrrp] 会话发送者映射启动失败：', error?.message ?? error);
    }
    // 决策模型路由 adapter：把「MRRP 智能路由」虚拟模型暴露到对话模型选择器。
    // 注册失败不影响管理控制台与其它能力，仅记录原因。
    let adapterRegistration = null;
    if (llm && typeof llm.registerAdapter === 'function') {
        try {
            const adapter = createRouteAdapter({
                getConfig: () => store.get(),
                registry: imRouting,
                host: { llm, logger },
                logger,
                // 路由决策日志：与 config.json 同目录，按天分文件（append JSON 行）
                logDir: routeLogDir,
            });
            adapterRegistration = llm.registerAdapter(['mrrp'], adapter);
            logger.info?.('[dsh-mrrp] 决策模型路由 adapter 已注册：对话模型列表可选中「MRRP 智能路由」');
        }
        catch (error) {
            logger.error?.('[dsh-mrrp] 决策模型路由 adapter 注册失败：', error?.message ?? error);
        }
    }
    else {
        logger.warn?.('[dsh-mrrp] 当前 DSH 运行时无 ctx.llm.registerAdapter，无法暴露决策模型路由虚拟模型');
    }
    const rpc = installRpc(ctx, {
        store, llm, logger, im,
        imRoutingStatus: () => imRouting.status(),
        logDir: routeLogDir,
        updater: { current: getCurrentVersion, check: checkLatestVersion, isAtLeast },
    });
    try {
        rpc.install();
    }
    catch (error) {
        logger.error?.('[dsh-mrrp] 管理接口注册失败：', error?.message ?? error);
    }
    // dsh-im 自动同步：轮询只读扫描 dsh-im 的发送者，首次出现的 senderId 自动建用户。
    // 不注册任何 hook / 中间件，不写 dsh-im 数据；可通过 config.autoSyncIm=false 关闭。
    const autoSyncIm = rpcConfig?.autoSyncIm !== false;
    const syncIntervalMs = Math.max(10_000, Math.min(600_000, Number(rpcConfig?.imSyncIntervalSec) || 60) * 1000);
    let syncTimer = null;
    if (autoSyncIm && typeof rpc.syncImUsers === 'function') {
        syncTimer = setInterval(() => {
            rpc.syncImUsers().catch(() => { });
        }, syncIntervalMs);
    }
    const dispose = () => {
        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
        }
        try {
            if (typeof adapterRegistration === 'function')
                adapterRegistration();
            else if (typeof adapterRegistration?.dispose === 'function')
                adapterRegistration.dispose();
        }
        catch { /* ignore */ }
        try {
            imRouting.stop();
        }
        catch { /* ignore */ }
        try {
            rpc.dispose();
        }
        catch { /* ignore */ }
    };
    if (typeof ctx?.effect === 'function') {
        ctx.effect(() => dispose, 'dsh-mrrp: management RPC');
    }
    if (typeof ctx?.provide === 'function') {
        ctx.provide('dshMrrpClient', Object.freeze({
            version: 1,
            status: () => ({ config: store.get() }),
            openPage: () => undefined,
        }));
    }
    // laya_decide 工具：优先使用控制台里配置并启用的 laya 提供方；
    // 未配置时回退到 cordis.patch.yml 的 config.laya = { baseUrl, apiKey, endpoint? } 覆盖项。
    const resolveLaya = () => {
        const provider = store.get().decisionProviders.find((item) => item.format === 'laya' && item.enabled && item.baseUrl);
        if (provider)
            return { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '', endpoint: provider.endpoint };
        const overlay = config?.laya;
        if (overlay && typeof overlay.baseUrl === 'string' && overlay.baseUrl.trim()) {
            return {
                baseUrl: overlay.baseUrl.trim(),
                apiKey: typeof overlay.apiKey === 'string' ? overlay.apiKey : '',
                endpoint: overlay.endpoint === 'decisions' ? 'decisions' : 'systemone',
            };
        }
        return null;
    };
    const registerTools = (toolsCtx) => {
        const target = (toolsCtx && typeof toolsCtx === 'object' ? toolsCtx : {});
        const tools = target.tools ?? target.get?.('tools') ?? ctx.tools ?? ctx.get?.('tools');
        if (!tools) {
            logger.warn?.('[dsh-mrrp] 运行时不提供 tools，跳过 laya_decide 工具注册（控制台功能不受影响）');
            return;
        }
        const spec = {
            description: '调用本地 laya-server 决策模型（TypeSafe Jev 协议，POST /v1/systemone）。根据 state 文本回答 choice / score / noul 类型问题。',
            params: {
                type: 'object',
                properties: {
                    state: { type: 'string', description: '待判断的文本（必填）' },
                    questions: {
                        type: 'object',
                        description: '问题定义（选填，默认给一个简单 choice 测试问题）。格式：{ 问题名: { type: choice|score|noul, instructions, criteria } }。choice 的 criteria 为至少两个选项的对象；score 的 criteria 为至少两个档位的数组；noul 可省略 criteria。',
                    },
                },
                required: ['state'],
            },
            execute: makeLayaDecide(resolveLaya),
        };
        try {
            if (typeof tools.register === 'function')
                tools.register('laya_decide', spec);
            else if (typeof tools.registerTool === 'function')
                tools.registerTool('laya_decide', spec);
            else
                logger.warn?.('[dsh-mrrp] tools 注册 API 未知，跳过 laya_decide');
        }
        catch (error) {
            logger.warn?.('[dsh-mrrp] laya_decide 注册失败：', error?.message ?? error);
        }
    };
    if (typeof ctx?.inject === 'function') {
        try {
            ctx.inject(['tools'], registerTools);
        }
        catch {
            logger.warn?.('[dsh-mrrp] 当前运行时无法注入 tools，跳过 laya_decide 工具注册');
        }
    }
    else {
        registerTools(ctx);
    }
    logger.info?.('[dsh-mrrp] plugin ready, config at', store.path);
}
