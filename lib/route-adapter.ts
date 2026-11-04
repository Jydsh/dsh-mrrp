import { appendFileSync } from 'node:fs';
import type { ImRouteConfig, PluginConfig } from './store.js';
import type { ImRoutingDeps, ImRoutingHandle } from './route-engine.js';
import { extractDecisionValues, parseModelKey, pruneRouteLogDir, pruneRouteLogFile, resolveTargetModel, routeLogPathFor } from './route-engine.js';

/**
 * MRRP 决策模型路由 adapter（新方案核心）。
 *
 * 通过宿主 `ctx.llm.registerAdapter(['mrrp'], adapter)` 注册为独立提供方，把
 * 「MRRP 智能路由」作为虚拟模型暴露到 DSH 对话的模型选择器。对话选中该模型后，
 * 宿主把生成调用交给本 adapter 的 stream()：
 *
 *   1. 用 options.sessionId 查会话发送者映射（createImRouting 观测记录）；
 *   2. 发送者 senderId → 用户表 → 用户（单独角色 + 所属部门角色）绑定的模型分类；
 *   3. 分类内模型去重得到候选池；候选唯一直接用，多个则用内置判定问题
 *      （builtinModelChoiceQuestion，插件内置，用户不配置）请 laya 决策模型选一个；
 *   4. 代理选中的真实模型：ctx.llm.stream({ ...options, provider, model }) 转发，
 *      输出流原样回传宿主，实现对用户「模型按权限路由」的回复。
 *
 * 契约对齐 dsh-our-free-model 的 FreeModelAdapter（providerInfo / providerRetryPolicy /
 * listModels / resolveModel / prepareCall / stream）。所有异常都带明确消息，由宿主
 * 呈现给对话；绝不吞错、绝不静默走错模型。
 */

/** MRRP 虚拟提供方标识。 */
export const ROUTE_PROVIDER = 'mrrp';
/** MRRP 虚拟模型标识（出现在对话模型选择器里）。 */
export const ROUTE_MODEL = 'route';
/** MRRP 虚拟模型显示名。 */
export const ROUTE_MODEL_NAME = 'MRRP 智能路由';

/**
 * 会话级决策缓存（sticky）：同一会话重复生成请求直接复用已决策的模型，
 * 避免每轮对话都串行等待 laya 决策。失效条件：发送者变化 / 路由配置变化 /
 * TTL 过期（10 分钟，会话内连续对话足够，重新决策成本可接受）。
 */
const DECISION_CACHE_TTL_MS = 10 * 60 * 1000;
/** 生成路径的候选选择超时：决策慢 / 不可达时快速落兜底。 */
export const DECISION_TIMEOUT_MS = 6000;

/** 宽松 DSH 上下文：转发生成调用用。 */
export interface AdapterHost {
  llm: {
    stream(options: Record<string, any>): AsyncIterable<unknown>;
  };
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

/** adapter 依赖（由 index.ts 装配）。 */
export interface RouteAdapterDeps {
  getConfig(): PluginConfig;
  /** 会话发送者映射（createImRouting 的句柄） */
  registry: ImRoutingHandle;
  /** 宿主生成调用入口（ctx.llm） */
  host: AdapterHost;
  /** 决策执行器（测试注入；缺省由 resolveTargetModel 按 decisionProviderId 走 laya） */
  decide?: ImRoutingDeps['decide'];
  /** 宽松日志器 */
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  /**
   * 路由决策日志目录（与 config.json 同目录）。按天分文件写入 route-decision-YYYY-MM-DD.log（append JSON 行），
   * 记录每次生成请求的完整路由链路：会话 / 发送者 / 用户命中 / 候选池 / 发送给 laya 的请求与响应 / 最终模型与来源。
   * 不配置时仅走 logger（宿主日志）。
   */
  logDir?: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function warn(deps: RouteAdapterDeps, message: string, ...args: unknown[]): void {
  try { deps.logger?.warn?.(`[dsh-mrrp:route-adapter] ${message}`, ...args); } catch { /* ignore */ }
}

/** 路由决策日志：追加 JSON 行到当天按天日志文件（若配置），同时透传宿主 logger.info。 */
function routeLog(deps: RouteAdapterDeps, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  if (deps.logDir) {
    const logPath = routeLogPathFor(deps.logDir);
    try { appendFileSync(logPath, `${line}\n`, 'utf8'); } catch (error) {
      warn(deps, `路由决策日志写入失败（${logPath}）：${(error as Error)?.message ?? error}`);
    }
    maybePruneLog(deps);
  }
  try { deps.logger?.info?.('[dsh-mrrp:route]', line); } catch { /* ignore */ }
}

/** 日志清理节流：默认 6 小时最多执行一次「删除超过保留天数的历史按天日志文件 + 当天文件内过期行」，
 *  避免每次写入都全文件扫描。保留天数取配置 logRetentionDays（默认 30，1~365）。 */
const ROUTE_LOG_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastRouteLogPruneAt = 0;
function maybePruneLog(deps: RouteAdapterDeps): void {
  const logDir = deps.logDir;
  if (!logDir) return;
  const now = Date.now();
  if (now - lastRouteLogPruneAt < ROUTE_LOG_PRUNE_INTERVAL_MS) return;
  lastRouteLogPruneAt = now;
  const maxAgeDays = deps.getConfig().logRetentionDays || 30;
  try { pruneRouteLogDir(logDir, maxAgeDays, now); } catch { /* 清理失败不影响路由 */ }
  try { pruneRouteLogFile(routeLogPathFor(logDir), maxAgeDays, now); } catch { /* 清理失败不影响路由 */ }
}

/** 从生成请求中提取「最后一条用户消息」文本（供决策模型判断任务内容）。 */
export function lastUserText(options: Record<string, any>): string {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (isRecord(block) && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim());
      }
      if (parts.length) return parts.join('\n');
    }
  }
  return '';
}

/** 决策模型输出 → 命中候选模型（复用 extractDecisionValues）。 */
export function pickedModelFrom(data: unknown, candidates: string[]): string | null {
  if (data === null || data === undefined) return null;
  const decision = extractDecisionValues(data);
  // 优先 choice（内置判定问题答案）；model 可能是 Laya 服务/路由元数据，仅在候选池中匹配才采用
  const picked = [decision.choice, decision.model].find((v) => v && candidates.includes(v)) ?? '';
  return picked || null;
}

/** 路由配置指纹：imRoute 配置或影响候选池的配置（分类/角色/部门/用户/模型画像/默认角色）变化时清空会话决策缓存。 */
export function routeCfgFingerprint(cfg: ImRouteConfig | undefined, config?: PluginConfig): string {
  try {
    const parts: unknown[] = [cfg ?? null];
    if (config) parts.push(
      config.categories ?? [],
      config.roles ?? [],
      config.depts ?? [],
      config.users ?? [],
      config.modelProfiles ?? {},
      config.userDefaults ?? {},
    );
    return JSON.stringify(parts);
  } catch { return ''; }
}

interface DecisionCacheEntry {
  senderId: string;
  model: string;
  source: string;
  at: number;
  fingerprint: string;
}

/** 从会话 id 解析发送者；解析失败返回 null（由调用方决定未知用户策略）。 */
export function resolveSenderFor(options: Record<string, any>, registry: ImRoutingHandle): { senderId: string; senderName: string } | null {
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.trim() ? options.sessionId.trim() : '';
  if (!sessionId) return null;
  return registry.resolveSender(sessionId);
}

export function createRouteAdapter(deps: RouteAdapterDeps): Record<string, any> {
  /** 会话级决策缓存（sticky；配置指纹 / 发送者 / TTL 变化时失效） */
  const decisionCache = new Map<string, DecisionCacheEntry>();

  return {
    /** 清空会话决策缓存（供管理通道在配置保存后调用，或测试用）。 */
    clearDecisionCache() {
      decisionCache.clear();
      return decisionCache.size;
    },

    providerInfo(provider: string) {
      return { id: provider || ROUTE_PROVIDER, name: ROUTE_MODEL_NAME };
    },

    providerRetryPolicy() {
      // 路由决策本身不做重试：转发层（ctx.llm.stream）对真实模型有独立的重试策略。
      return Object.freeze({
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: Object.freeze([]),
        initialDelayMs: 0,
        maxDelayMs: 0,
      });
    },

    async listModels(provider: string) {
      return [{
        provider: provider || ROUTE_PROVIDER,
        id: ROUTE_MODEL,
        name: ROUTE_MODEL_NAME,
        description: 'MRRP 智能路由：按会话发送者的角色 / 部门权限决策真实模型后代理回复（在「路由配置」页启动决策模型并绑定 Laya 决策模型）。',
        inputModalities: ['text'],
      }];
    },

    async resolveModel(provider: string, model: string) {
      return {
        provider: provider || ROUTE_PROVIDER,
        id: ROUTE_MODEL,
        name: ROUTE_MODEL_NAME,
        context: { contextWindow: 131072 },
        defaultMaxTokens: 8192,
      };
    },

    async prepareCall(provider: string, model: string) {
      return {
        model: await this.resolveModel(provider, model),
        stream: (options: Record<string, any>) => this.stream(options, null, undefined),
      };
    },

    /**
     * 生成调用主流程：解析发送者 → 决策目标模型 → 代理转发。
     * 返回 AsyncIterable<StreamChunk>，与宿主 stream 输出形状一致（转发原样透传）。
     */
    async *stream(options: Record<string, any>, _pinned: unknown, _snapshot: unknown): AsyncIterable<unknown> {
      const config = deps.getConfig();
      const cfg: ImRouteConfig | undefined = config?.route?.imRoute;
      const session = typeof options.sessionId === 'string' ? options.sessionId : '';

      // 1. 未启动决策模型：直接按兜底模型转发（若未配置兜底则明确报错）
      if (!cfg?.enabled) {
        routeLog(deps, { event: 'decision-disabled', session, model: cfg?.fallbackModel ?? null });
        if (cfg?.fallbackModel) {
          return yield* forwardTo(deps, options, cfg.fallbackModel, 'decision-disabled');
        }
        throw new Error('MRRP 决策模型路由未启动：请在「路由配置」页启动决策模型并配置兜底模型。');
      }

      // 2. 会话 → 发送者
      const sender = resolveSenderFor(options, deps.registry);
      if (!sender) {
        routeLog(deps, { event: 'unknown-sender', session, branch: cfg.unknownUser === 'fallback' ? 'unknown-fallback' : 'no-route', message: '会话映射未命中发送者' });
        return yield* unknownSenderFlow(deps, options, cfg);
      }

      // 2.5 决策缓存（sticky）：同会话同发送者同配置在 TTL 内直接复用已决策模型
      const fingerprint = routeCfgFingerprint(cfg, deps.getConfig());
      const cached = decisionCache.get(options.sessionId);
      if (cached && cached.senderId === sender.senderId && cached.fingerprint === fingerprint
          && Date.now() - cached.at < DECISION_CACHE_TTL_MS) {
        routeLog(deps, { event: 'cache-hit', session, senderId: sender.senderId, senderName: sender.senderName, model: cached.model, source: cached.source });
        warn(deps, `会话 ${options.sessionId} 命中决策缓存：${cached.model}（来源：${cached.source}）`);
        return yield* forwardTo(deps, options, cached.model, cached.source);
      }

      // 3. 决策目标模型（用户权限模型池 → laya 内置问题选择 → 兜底）
      const text = lastUserText(options);
      const outcome = await resolveTargetModel(
        {
          getConfig: deps.getConfig,
          decide: deps.decide,
          logger: deps.logger,
          // laya 决策过程追踪：发送给 laya 的请求 / 原始响应 / 错误全部记入路由决策日志
          onDecide: (phase, detail) => routeLog(deps, {
            event: `decide-${phase}`,
            session,
            senderId: sender.senderId,
            senderName: sender.senderName,
            ...detail,
          }),
        },
        cfg,
        sender.senderId,
        text,
      );
      if (!outcome) {
        // 用户未注册且 unknownUser=ignore：不路由（明确报错，避免用户误以为模型生效）
        routeLog(deps, { event: 'no-route', session, senderId: sender.senderId, senderName: sender.senderName, reason: '用户未注册且未配置兜底模型' });
        throw new Error(`用户 ${sender.senderName || sender.senderId} 未注册且未配置兜底模型，无法路由。请在「路由配置」页分配模型。`);
      }
      decisionCache.set(options.sessionId, {
        senderId: sender.senderId,
        model: outcome.model,
        source: outcome.source,
        at: Date.now(),
        fingerprint,
      });
      routeLog(deps, {
        event: 'route',
        session,
        senderId: sender.senderId,
        senderName: sender.senderName,
        userFound: true,
        candidates: outcome.candidates,
        sources: outcome.sources,
        branch: outcome.source,
        model: outcome.model,
        decision: outcome.decision ?? null,
        reasoning: outcome.reasoning ?? null,
        cache: 'miss',
      });
      warn(deps, `会话 ${options.sessionId} 用户 ${sender.senderName || sender.senderId} 命中模型 ${outcome.model}（来源：${outcome.source}）`);
      return yield* forwardTo(deps, options, outcome.model, outcome.source);
    },
  };
}

/** 未知会话（映射缺失）处理：按 unknownUser 策略走兜底或报错。 */
async function* unknownSenderFlow(
  deps: RouteAdapterDeps,
  options: Record<string, any>,
  cfg: ImRouteConfig,
): AsyncIterable<unknown> {
  if (cfg.unknownUser === 'fallback' && cfg.fallbackModel) {
    return yield* forwardTo(deps, options, cfg.fallbackModel, 'unknown-fallback');
  }
  throw new Error('无法解析该会话的发送者：MRRP 尚未观测到本会话的 dsh-im 消息。请先在会话中发送一条消息，或检查「路由配置」页的未注册用户策略。');
}

/** 转发：把 options 的 provider/model 换成目标真实模型，输出流原样透传。 */
async function* forwardTo(
  deps: RouteAdapterDeps,
  options: Record<string, any>,
  modelKey: string,
  source: string,
): AsyncIterable<unknown> {
  const parsed = parseModelKey(modelKey);
  if (!parsed) {
    throw new Error(`MRRP 路由的兜底 / 候选模型标识无效（期望 provider:id，实际为「${modelKey}」）。请在「路由配置」页修正。`);
  }
  if (parsed.provider === ROUTE_PROVIDER) {
    throw new Error(`MRRP 路由目标不能是自身（${modelKey}），请检查模型分类绑定与兜底模型配置。`);
  }
  // 展开新对象再改 provider/model：LOOP 构建的请求是深冻结的，不能原地改。
  const forwarded: Record<string, any> = { ...options, provider: parsed.provider, model: parsed.model };
  try {
    const stream = deps.host.llm.stream(forwarded);
    for await (const chunk of stream) yield chunk;
  } catch (error) {
    warn(deps, `转发到 ${modelKey} 失败：${(error as Error)?.message ?? error}`);
    throw new Error(`MRRP 已按权限路由到 ${modelKey}，但该模型调用失败：${(error as Error)?.message ?? error}`);
  }
}
