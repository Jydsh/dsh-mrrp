import { appendFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { installRpc, type DshCtx } from './rpc.js';
import { MrrpConfigStore, probeLogDir, resolveRouteLogDir, sanitizeLogDir } from './store.js';
import { makeLayaDecide } from './decision.js';
import { makeImReader } from './dshim.js';
import { createImRouting, pruneRouteLogDir, pruneRouteLogFile, routeLogPathFor } from './route-engine.js';
import { readDingtalkBridgeSessions } from './dingtalk-bridge.js';
import { createRouteAdapter } from './route-adapter.js';
import { resolveUserPermission } from './permission.js';
import { checkLatestVersion, detectInstallEnv, getCurrentVersion, isAtLeast, runUpdate } from './updater.js';
import { ensureProfileConfig, mrrpConfigPathFor, rememberProfile, resolveProfileIdentity } from './profile.js';
/**
 * dsh-mrrp: MRRP（Model Routing & Resource Planning）控制台插件。
 *
 * host 侧职责：
 *   - 通过 DSH 的 llm 服务只读发现已注册的模型提供方与模型列表；
 *   - 在 ~/.dsh/integrations/dsh-mrrp/profiles/<profile>/config.json 持久化模型分类 / 路由配置 / 角色部门 / 用户 / 决策模型提供方
 *     （同一台机器的 desktop / web 各存一份，识别不出 profile 时回退旧的共享路径）；
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

/** DSH 日志器（宽松类型）。 */
export interface DshLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/** DSH 运行时上下文（宽松类型：DSH API 未提供完整类型定义）。 */
export interface DshContext extends DshCtx {
  logger?: DshLogger | ((scope: string) => DshLogger);
  effect?: (dispose: () => void, label: string) => unknown;
  provide?: (key: string, value: unknown) => unknown;
  [key: string]: unknown;
}

/** apply 配置参数。 */
export interface ApplyConfig {
  configPath?: string;
  [key: string]: unknown;
}

function makeLogger(ctx: DshContext): DshLogger {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger('dsh-mrrp') : ctx?.logger;
  const safe: DshLogger = logger && typeof logger === 'object' ? logger : console;
  return {
    info: (...args: unknown[]) => safe.info?.(...args),
    warn: (...args: unknown[]) => safe.warn?.(...args),
    error: (...args: unknown[]) => safe.error?.(...args),
    debug: (...args: unknown[]) => safe.debug?.(...args),
  };
}

/** 路由诊断日志器：写当天按天日志文件（route-decision-YYYY-MM-DD.log，append JSON 行）并透传宿主 logger。
 *  供会话发送者观测（im-route）使用，与 adapter 的路由决策日志共用同一文件（按天分文件）。
 *  目录用函数现取：控制台「日志设置」改了存放路径后，后续写入立即落到新目录。 */
function makeRouteLogger(getLogDir: () => string, host: DshLogger): DshLogger {
  const emit = (level: string, args: unknown[]): void => {
    let message = '';
    for (const arg of args) {
      message += (message ? ' ' : '')
        + (typeof arg === 'string' ? arg : safeJson(arg));
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), scope: 'im-route', level, message });
    try { appendFileSync(routeLogPathFor(getLogDir()), `${line}\n`, 'utf8'); } catch { /* 写失败不阻塞主链路 */ }
    try { (host as unknown as Record<string, (...args: unknown[]) => void>)?.[level]?.(`[dsh-mrrp:im-route]`, ...args); } catch { /* ignore */ }
  };
  return {
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
    debug: (...args: unknown[]) => emit('debug', args),
  };
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * 把权限规则里的「沙箱模式 / 审批策略」写进 DSH 会话（宿主内核据此拦截命令与文件操作）。
 * 宿主 `setSandboxMode(session, mode)` / `setApprovalPolicy(session, policy)` 的实现就是
 * `session.append('sandbox/mode'|'approval/policy', payload)`，这里直接用同一份会话事件契约。
 * 返回已下发的签名（"read-only/ask" 形式）；会话对象不支持 append 时返回空串（只是没有内核级限制，
 * adapter 的工具闸门仍然生效）。
 */
function applySessionPermission(session: unknown, sandbox: string, approval: string): string {
  if (!session || typeof (session as Record<string, any>).append !== 'function') return '';
  const applied: string[] = [];
  if (sandbox) {
    try {
      (session as Record<string, any>).append('sandbox/mode', { mode: sandbox });
      applied.push(sandbox);
    } catch { /* 会话已结束或不支持该事件：忽略，工具闸门兜住 */ }
  }
  if (approval) {
    try {
      (session as Record<string, any>).append('approval/policy', { policy: approval });
      applied.push(approval);
    } catch { /* ignore */ }
  }
  return applied.join('/');
}

export async function apply(ctx: DshContext, config: ApplyConfig = {}): Promise<void> {
  const logger = makeLogger(ctx);
  // 当前环境身份：同一台机器的 desktop / web 各自独立，配置与日志都按 profile 分目录存放。
  // profile 认定不出时回退旧的共享路径，宁可共用也不把配置写到看不见的地方。
  const identity = resolveProfileIdentity();
  const explicitPath = typeof config.configPath === 'string' && config.configPath ? config.configPath : '';
  const configFile = explicitPath || mrrpConfigPathFor(identity);
  if (!explicitPath) ensureProfileConfig(identity, configFile);
  const store = new MrrpConfigStore(configFile);
  // 路由决策日志目录：默认与 config.json 同目录；控制台「日志设置」可改成任意绝对路径。
  // 所有写入 / 读取 / 清理都通过 getLogDir() 现取，改完路径无需重装插件。
  // 自定义目录不存在（如刚改了配置还没建目录）或启动探测不可写时，本次运行回退默认目录，保证日志不会静默丢失。
  let brokenLogDir = '';
  const getLogDir = (): string => {
    const dir = resolveRouteLogDir(store.path, store.get().logDir);
    const fallback = dirname(store.path);
    if (dir === fallback) return dir;
    if (brokenLogDir && dir === brokenLogDir) return fallback;
    try { return statSync(dir).isDirectory() ? dir : fallback; } catch { return fallback; }
  };
  logger.info?.(
    '[dsh-mrrp] 当前 profile：',
    identity.profile ?? '未识别',
    `（依据：${identity.source}${identity.candidates.length ? `，候选：${identity.candidates.join('/')}` : ''}）`,
    '配置：',
    store.path,
    '日志目录：',
    getLogDir(),
  );
  // 会话发送者观测日志：写当天日志文件（与 adapter 共用），宿主 logger 透传。
  const routeLogger = makeRouteLogger(getLogDir, logger);
  try {
    await store.load();
    // 启动时校验一次自定义日志目录：不可写就本次运行回退默认目录并明确报出来（否则日志会静默写不进去）
    try {
      const custom = sanitizeLogDir(store.get().logDir);
      if (custom) {
        const bad = probeLogDir(custom);
        if (bad) {
          brokenLogDir = custom;
          logger.warn?.(`[dsh-mrrp] 日志目录不可用（${custom}）：${bad}；本次运行回退到 ${dirname(store.path)}，可在控制台「日志设置」里换一个目录`);
        }
      }
    } catch { /* ignore */ }
    // 启动时清理一次路由决策日志（删除超过保留天数的历史按天文件 + 当天文件内过期行；失败静默不影响启动）
    try {
      const retention = store.get().logRetentionDays || 30;
      const dir = getLogDir();
      pruneRouteLogDir(dir, retention);
      pruneRouteLogFile(routeLogPathFor(dir), retention);
    } catch { /* ignore */ }
  } catch (error) {
    logger.error?.('[dsh-mrrp] failed to load config, using defaults:', (error as Error)?.message ?? error);
  }

  // 模型发现只读使用 DSH 的 llm 服务（注入后可通过 ctx.llm 访问）。
  const llm = (ctx as Record<string, any>)?.llm;

  const rpcConfig = config as Record<string, any>;
  // im 读取器：测试 / 定制场景可注入（config.im 或 config.imDbPath），默认读 ~/.dsh 的 dsh-im 库。
  const im = rpcConfig?.im ?? makeImReader(typeof rpcConfig?.imDbPath === 'string' ? rpcConfig.imDbPath : undefined);

  // IM 消息路由引擎：常驻订阅 DSH 会话事件 + 只读 dsh-dingtalk 桥会话映射，
  // 建立「会话 → 发送者」映射，供决策模型路由 adapter 解析用户。只观测不拦截，异常静默降级。
  const imRouting = createImRouting(ctx as unknown as import('./route-engine.js').RoutingCtx, {
    getConfig: () => store.get(),
    logger: routeLogger,
    dingtalkBridge: { readSessions: () => readDingtalkBridgeSessions() },
    // 会话级权限：识别出 IM 发送者后按权限规则下发沙箱/审批；
    // 未授权用户直接锁到最严（只读 + 每次审批），即使准入判断有遗漏也干不了危险操作。
    applyPermission: (session, senderId, config) => {
      const permission = resolveUserPermission(config, senderId);
      if (!permission.bound || !permission.caps.chat) {
        return applySessionPermission(session, 'read-only', 'ask');
      }
      return applySessionPermission(session, permission.sandbox, permission.approval);
    },
  });
  try {
    imRouting.start();
  } catch (error) {
    logger.error?.('[dsh-mrrp] 会话发送者映射启动失败：', (error as Error)?.message ?? error);
  }

  // 决策模型路由 adapter：把「MRRP 智能路由」虚拟模型暴露到对话模型选择器。
  // 注册失败不影响管理控制台与其它能力，仅记录原因。
  let adapterRegistration: unknown = null;
  if (llm && typeof llm.registerAdapter === 'function') {
    try {
      const adapter = createRouteAdapter({
        getConfig: () => store.get(),
        registry: imRouting,
        host: { llm, logger },
        logger,
        // 路由决策日志：按天分文件（append JSON 行）；目录现取，改路径后即时生效
        getLogDir,
      });
      adapterRegistration = llm.registerAdapter(['mrrp'], adapter);
      logger.info?.('[dsh-mrrp] 决策模型路由 adapter 已注册：对话模型列表可选中「MRRP 智能路由」');
    } catch (error) {
      logger.error?.('[dsh-mrrp] 决策模型路由 adapter 注册失败：', (error as Error)?.message ?? error);
    }
  } else {
    logger.warn?.('[dsh-mrrp] 当前 DSH 运行时无 ctx.llm.registerAdapter，无法暴露决策模型路由虚拟模型');
  }

  const rpc = installRpc(ctx, {
    store, llm, logger, im,
    imRoutingStatus: () => imRouting.status(),
    getLogDir,
    updater: {
      current: getCurrentVersion,
      check: checkLatestVersion,
      isAtLeast,
      // 统一带上本进程解析好的 identity，保证配置目录与更新目标指向同一个 profile
      detect: (options) => detectInstallEnv({ ...options, identity }),
      update: (options) => runUpdate({ ...options, identity }),
      remember: rememberProfile,
    },
  });
  try {
    rpc.install();
  } catch (error) {
    logger.error?.('[dsh-mrrp] 管理接口注册失败：', (error as Error)?.message ?? error);
  }

  // dsh-im 自动同步：轮询只读扫描 dsh-im 的发送者，首次出现的 senderId 自动建用户。
  // 不注册任何 hook / 中间件，不写 dsh-im 数据；可通过 config.autoSyncIm=false 关闭。
  const autoSyncIm = rpcConfig?.autoSyncIm !== false;
  const syncIntervalMs = Math.max(
    10_000,
    Math.min(600_000, Number(rpcConfig?.imSyncIntervalSec) || 60) * 1000,
  );
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  if (autoSyncIm && typeof rpc.syncImUsers === 'function') {
    syncTimer = setInterval(() => {
      rpc.syncImUsers().catch(() => { /* 静默：同步失败不影响主链路 */ });
    }, syncIntervalMs);
  }

  const dispose = () => {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    try {
      if (typeof adapterRegistration === 'function') adapterRegistration();
      else if (typeof (adapterRegistration as any)?.dispose === 'function') (adapterRegistration as any).dispose();
    } catch { /* ignore */ }
    try { imRouting.stop(); } catch { /* ignore */ }
    try { rpc.dispose(); } catch { /* ignore */ }
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
    const provider = store.get().decisionProviders.find(
      (item) => item.format === 'laya' && item.enabled && item.baseUrl,
    );
    if (provider) return { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '', endpoint: provider.endpoint };
    const overlay = (config as Record<string, any>)?.laya;
    if (overlay && typeof overlay.baseUrl === 'string' && overlay.baseUrl.trim()) {
      return {
        baseUrl: overlay.baseUrl.trim(),
        apiKey: typeof overlay.apiKey === 'string' ? overlay.apiKey : '',
        endpoint: overlay.endpoint === 'decisions' ? 'decisions' : 'systemone',
      };
    }
    return null;
  };

  const registerTools = (toolsCtx: unknown): void => {
    const target = (toolsCtx && typeof toolsCtx === 'object' ? toolsCtx : {}) as Record<string, any>;
    const tools = target.tools ?? target.get?.('tools') ?? (ctx as Record<string, any>).tools ?? (ctx as Record<string, any>).get?.('tools');
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
      if (typeof tools.register === 'function') tools.register('laya_decide', spec);
      else if (typeof tools.registerTool === 'function') tools.registerTool('laya_decide', spec);
      else logger.warn?.('[dsh-mrrp] tools 注册 API 未知，跳过 laya_decide');
    } catch (error) {
      logger.warn?.('[dsh-mrrp] laya_decide 注册失败：', (error as Error)?.message ?? error);
    }
  };
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['tools'], registerTools);
    } catch {
      logger.warn?.('[dsh-mrrp] 当前运行时无法注入 tools，跳过 laya_decide 工具注册');
    }
  } else {
    registerTools(ctx);
  }

  logger.info?.('[dsh-mrrp] plugin ready, config at', store.path);
}
