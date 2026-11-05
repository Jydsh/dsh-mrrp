import { appendFileSync } from 'node:fs';
import type { ImRouteConfig, PluginConfig } from './store.js';
import type { ImRoutingDeps, ImRoutingHandle } from './route-engine.js';
import { extractDecisionValues, parseModelKey, pruneRouteLogDir, pruneRouteLogFile, collectUserModelPool, resolveTargetModelFromPool, routeLogPathFor, type UserModelPool } from './route-engine.js';

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
 * 决策上下文缓存：缓存「发送者 → 用户可用模型池」（候选池 + 画像 + 指纹），
 * 每条消息仍执行 Laya 决策（候选多时按消息内容重新选择），不再按会话锁死已决策模型。
 * 失效条件：发送者变化 / 路由配置变化 / TTL 过期（10 分钟，候选组装成本可忽略）。
 */
const DECISION_CTX_TTL_MS = 10 * 60 * 1000;
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
/**
 * 剥离 dsh-im 附加在用户消息正文前的 `<dsh_im_source>…</dsh_im_source>` 发送者块，
 * 返回真实正文（仅发送者块时返回空串）。
 */
export function stripSourceBlock(text: string): string {
  if (typeof text !== 'string' || !text) return '';
  const m = /<dsh_im_source>[\s\S]*?<\/dsh_im_source>/.exec(text);
  if (!m) return text;
  return text.slice(m.index + m[0].length).replace(/^\s*\r?\n?/, '').trim();
}

/** 文本块常见字段名（宿主多形态：text / content / markdown / plain_text 等）。 */
const USER_TEXT_FIELDS = ['text', 'content', 'textContent', 'markdown', 'plain_text', 'value'];

function blockText(block: Record<string, any>): string {
  for (const field of USER_TEXT_FIELDS) {
    const value = block[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 顶层兜底字段：宿主可能把当前用户正文放在这些位置。 */
const TOP_TEXT_FIELDS = ['content', 'text', 'query', 'prompt', 'userText', 'input_text', 'user_message', 'message'];

/**
 * 提取生成请求里最新一条用户文本。
 * 宿主可能以多种形态传消息：
 *   A. messages: [{ role:'user', content: string | [{type:'text',text},{type:'image',...}] }]
 *   B. input: [{type:'text', text}, {type:'image', ...}]（当前请求的多模态输入数组）
 *   C. 顶层字段 content / text / query / prompt / userText / input_text / message（宿主兜底形态）
 * 优先 B → A → C；文本统一剥离 `<dsh_im_source>` 发送者前缀块，避免发送者块污染决策判断。
 */
export function lastUserText(options: Record<string, any>): string {
  // B. input 数组形态（当前请求的多模态输入）
  const input = Array.isArray(options.input) ? options.input : [];
  if (input.length) {
    const parts: string[] = [];
    for (const block of input) {
      if (!isRecord(block)) continue;
      const t = blockText(block);
      if (t) parts.push(t);
    }
    if (parts.length) {
      const stripped = stripSourceBlock(parts.join('\n'));
      if (stripped) return stripped;
    }
  }
  // A. messages 形态：定位「本条消息」user（跳过宿主注入的发送者块等元数据消息），取该消息正文。
  //    历史消息里的正文/附件不会冒充当前消息：定位停在第一条「有正文或有附件」的 user 即止。
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const idx = lastUserMessageIndex(messages);
  if (idx >= 0) {
    const content = messages[idx].content;
    if (typeof content === 'string' && content.trim()) {
      return stripSourceBlock(content.trim());
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (isRecord(block)) {
          const t = blockText(block);
          if (t) parts.push(t);
        }
      }
      return stripSourceBlock(parts.join('\n'));
    }
  }
  // C. 顶层兜底字段
  for (const field of TOP_TEXT_FIELDS) {
    const value = options[field];
    if (typeof value === 'string' && value.trim()) {
      const stripped = stripSourceBlock(value.trim());
      if (stripped) return stripped;
    }
    if (isRecord(value)) {
      const t = blockText(value);
      if (t) {
        const stripped = stripSourceBlock(t);
        if (stripped) return stripped;
      }
    }
  }
  return '';
}

/** 附件类型判定：content block 的 type → image/video/file/audio。 */
function attachTypeOf(block: Record<string, any>): string {
  const kind = String(block.type || '').toLowerCase();
  if (kind === 'image' || kind === 'image_url') return 'image';
  if (kind === 'video' || kind === 'video_url') return 'video';
  if (kind === 'file' || kind === 'file_url') return 'file';
  if (kind === 'audio' || kind === 'audio_url') return 'audio';
  return '';
}

/** 文本占位附件：IM 占位 / markdown 图片 / 裸图片 URL（先剥发送者块再检测）。 */
function placeholderAttachTypes(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  const low = stripSourceBlock(text).toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\[(图片|照片)\]/, 'image'],
    [/\[(视频)\]/, 'video'],
    [/\[(文件|附件)\]/, 'file'],
    [/\[(音频|语音)\]/, 'audio'],
    [/!\[[^\]]*\]\([^)]+\)/, 'image'],
    [/(?:https?:)?\/\/\S+\.(?:png|jpe?g|gif|webp|bmp)(?:\?\S*)?/i, 'image'],
  ];
  for (const [re, type] of rules) {
    if (re.test(low) && !out.includes(type)) out.push(type);
  }
  return out;
}

/** 定位「本条消息」的 user 消息索引。
 *  宿主会在 messages 末尾注入「发送者标识」等元数据 user 消息（正文只有 <dsh_im_source> 块，
 *  或仅有回显占位），它们无正文也无附件；真实用户消息（有正文或有附件）在其前。
 *  从后往前跳过这类元数据消息，停在第一条「有正文或有附件」的 user 消息（无论是否命中都停止，
 *  避免翻到历史对话把旧附件误判为当前消息）。搜索深度限制 MAX_SCAN 条，找不到返回 -1。 */
const LAST_USER_SCAN_MAX = 8;
function lastUserMessageIndex(messages: unknown[]): number {
  let scanned = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== 'user') continue;
    if (++scanned > LAST_USER_SCAN_MAX) return -1;
    const content = message.content;
    if (typeof content === 'string' && content.trim()) {
      const stripped = stripSourceBlock(content.trim());
      if (stripped || placeholderAttachTypes(stripped).length) return i;
      continue; // 仅发送者块等元数据，跳过
    }
    if (Array.isArray(content)) {
      const blocks = content.filter(isRecord);
      const hasAttach = blocks.some((b) => attachTypeOf(b));
      const text = blocks.map(blockText).filter(Boolean).join('\n');
      if (stripSourceBlock(text) || hasAttach) return i;
      continue; // 元数据，跳过
    }
    continue;
  }
  return -1;
}

/** 从生成请求中提取「本条消息」的附件类型（image/video/file/audio）。
 *  决策模型不需要理解附件内容，只需据此优先选择「能处理该类输入」的候选模型。 */
export function extractAttachmentHints(options: Record<string, any>): string[] {
  const hints: string[] = [];
  // B. input 数组形态（当前请求的多模态输入，最准确，优先）
  const input = Array.isArray(options.input) ? options.input : [];
  for (const block of input) {
    if (isRecord(block)) {
      const t = attachTypeOf(block);
      if (t && !hints.includes(t)) hints.push(t);
    }
  }
  if (hints.length) return hints;
  // A. messages 形态：定位「本条消息」user（跳过宿主注入的发送者块等元数据消息），取该消息附件
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const idx = lastUserMessageIndex(messages);
  if (idx >= 0) {
    const content = messages[idx].content;
    if (typeof content === 'string' && content.trim()) {
      for (const t of placeholderAttachTypes(content.trim())) {
        if (!hints.includes(t)) hints.push(t);
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        const t = attachTypeOf(block);
        if (t && !hints.includes(t)) hints.push(t);
      }
    }
  }
  return hints;
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

interface DecisionCtxEntry {
  senderId: string;
  fingerprint: string;
  pool: UserModelPool;
  at: number;
}

/** 从会话 id 解析发送者；解析失败返回 null（由调用方决定未知用户策略）。 */
export function resolveSenderFor(options: Record<string, any>, registry: ImRoutingHandle): { senderId: string; senderName: string } | null {
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.trim() ? options.sessionId.trim() : '';
  if (!sessionId) return null;
  return registry.resolveSender(sessionId);
}

export function createRouteAdapter(deps: RouteAdapterDeps): Record<string, any> {
  /** 决策上下文缓存（发送者 → 候选池；配置指纹 / 发送者 / TTL 变化时失效） */
  const decisionCtxCache = new Map<string, DecisionCtxEntry>();

  return {
    /** 清空决策上下文缓存（供管理通道在配置保存后调用，或测试用）。 */
    clearDecisionCache() {
      decisionCtxCache.clear();
      return decisionCtxCache.size;
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
        // 声明全模态输入：宿主才会把图片/视频/文件/音频（input: [{type:text},{type:image}...]）传给路由虚拟模型，
        // 转发层再按目标模型能力透传（附件感知决策保证带附件消息路由到有对应能力的模型）。
        inputModalities: ROUTE_INPUT_MODALITIES,
        // 声明全模态输出：目标模型生成的图片/视频/音频/文件（stream 输出块）经路由原样透传，不削减模型能力。
        outputModalities: ROUTE_OUTPUT_MODALITIES,
      }];
    },

    async resolveModel(provider: string, model: string) {
      return {
        provider: provider || ROUTE_PROVIDER,
        id: ROUTE_MODEL,
        name: ROUTE_MODEL_NAME,
        context: { contextWindow: 131072 },
        defaultMaxTokens: 8192,
        inputModalities: ROUTE_INPUT_MODALITIES,
        outputModalities: ROUTE_OUTPUT_MODALITIES,
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

      // 观测宿主调用形态（仅当带多模态输入时记录）：确认图片元素结构，供转发兼容调试
      const callShape = describeCallShape(options);
      if (callShape) routeLog(deps, { event: 'observe-call', session, ...callShape });

      // 1. 未启动决策模型：直接按兜底模型转发（若未配置兜底则明确报错）
      if (!cfg?.enabled) {
        routeLog(deps, { event: 'decision-disabled', session, model: cfg?.fallbackModel ?? null });
        if (cfg?.fallbackModel) {
          return yield* forwardTo(deps, options, cfg.fallbackModel, 'decision-disabled', cfg.fallbackModel);
        }
        throw new Error('MRRP 决策模型路由未启动：请在「路由配置」页启动决策模型并配置兜底模型。');
      }

      // 2. 会话 → 发送者
      const sender = resolveSenderFor(options, deps.registry);
      if (!sender) {
        routeLog(deps, { event: 'unknown-sender', session, branch: cfg.unknownUser === 'fallback' ? 'unknown-fallback' : 'no-route', message: '会话映射未命中发送者' });
        return yield* unknownSenderFlow(deps, options, cfg);
      }

      // 2.5 决策上下文缓存（候选池复用）：同发送者同配置在 TTL 内复用「用户可用模型池」，
      //     但每条消息仍执行 Laya 决策（候选多时按消息内容重新选择），不再锁死会话模型。
      const fingerprint = routeCfgFingerprint(cfg, deps.getConfig());
      const ctxKey = `${sender.senderId}\u0000${fingerprint}`;
      const ctx = decisionCtxCache.get(ctxKey);
      let pool: UserModelPool;
      let ctxHit = false;
      if (ctx && ctx.senderId === sender.senderId && ctx.fingerprint === fingerprint
          && Date.now() - ctx.at < DECISION_CTX_TTL_MS) {
        pool = ctx.pool;
        ctxHit = true;
        routeLog(deps, { event: 'ctx-hit', session, senderId: sender.senderId, senderName: sender.senderName, candidates: pool.direct.length + pool.inherited.length, direct: pool.direct.length, inherited: pool.inherited.length });
        warn(deps, `会话 ${options.sessionId} 命中决策上下文缓存（候选池 ${pool.direct.length + pool.inherited.length} 个），本条消息仍执行 Laya 决策`);
      } else {
        pool = collectUserModelPool(deps.getConfig(), sender.senderId);
        decisionCtxCache.set(ctxKey, { senderId: sender.senderId, fingerprint, pool, at: Date.now() });
      }

      // 3. 决策目标模型（候选池已就绪 → laya 内置问题按本条消息内容选择 → 兜底）
      const text = lastUserText(options);
      const outcome = await resolveTargetModelFromPool(
        pool,
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
        extractAttachmentHints(options),
      );
      if (!outcome) {
        // 用户未注册且 unknownUser=ignore：不路由（明确报错，避免用户误以为模型生效）
        routeLog(deps, { event: 'no-route', session, senderId: sender.senderId, senderName: sender.senderName, reason: '用户未注册且未配置兜底模型' });
        throw new Error(`用户 ${sender.senderName || sender.senderId} 未注册且未配置兜底模型，无法路由。请在「路由配置」页分配模型。`);
      }
      routeLog(deps, {
        event: 'route',
        session,
        senderId: sender.senderId,
        senderName: sender.senderName,
        userFound: pool.userFound,
        candidates: outcome.candidates,
        sources: outcome.sources,
        branch: outcome.source,
        model: outcome.model,
        decision: outcome.decision ?? null,
        reasoning: outcome.reasoning ?? null,
        providerId: outcome.providerId ?? null,
        failover: outcome.failover ?? false,
        attachmentOverride: outcome.attachmentOverride ?? false,
        ctx: ctxHit ? 'hit' : 'miss',
      });
      warn(deps, `会话 ${options.sessionId} 用户 ${sender.senderName || sender.senderId} 命中模型 ${outcome.model}（来源：${outcome.source}）`);
      return yield* forwardTo(deps, options, outcome.model, outcome.source, cfg.fallbackModel);
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
    return yield* forwardTo(deps, options, cfg.fallbackModel, 'unknown-fallback', cfg.fallbackModel);
  }
  throw new Error('无法解析该会话的发送者：MRRP 尚未观测到本会话的 dsh-im 消息。请先在会话中发送一条消息，或检查「路由配置」页的未注册用户策略。');
}

/** 转发：把 options 的 provider/model 换成目标真实模型，输出流原样透传。
 *  目标模型调用失败（且尚未产出任何内容）时，自动改用兜底模型重试
 *  （来源 fallback-after-error）；兜底未配置 / 就是失败模型 / 已输出部分内容则不切换。 */
/**
 * 观测宿主调用形态：仅在存在 input 数组 / messages 含非 text 附件块 / 带工具声明时返回结构快照，
 * 用于确认多模态输入各附件元素字段与工具调用是否透传（调试转发兼容；决策 / 转发依赖此信息）。
 */
export function describeCallShape(options: Record<string, any>): Record<string, any> | null {
  const shape: Record<string, any> = {};
  const input = Array.isArray(options.input) ? options.input : null;
  if (input) {
    shape.hasInput = true;
    shape.inputKinds = [...new Set(input.filter(isRecord).map((b) => String((b as Record<string, any>).type || '')))];
    for (const want of ['image', 'video', 'file', 'audio', 'image_url', 'video_url']) {
      const blk = input.find((b) => isRecord(b) && String((b as Record<string, any>).type || '').toLowerCase() === want);
      if (blk) shape[`${want}Fields`] = Object.keys(blk as Record<string, any>);
    }
  }
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const attachKinds: string[] = [];
  for (const msg of messages) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isRecord(block)) continue;
      const kind = String((block as Record<string, any>).type || '').toLowerCase();
      if (kind !== 'text') attachKinds.push(kind);
    }
  }
  if (attachKinds.length) {
    shape.hasAttachBlocks = true;
    shape.attachKinds = [...new Set(attachKinds)];
  }
  // 决策正文观测：确认宿主把「当前用户消息」放在哪个字段/形态，避免 state 里缺失用户正文
  if (input) {
    shape.inputTextBlocks = input.filter((b) => isRecord(b) && String((b as Record<string, any>).type || '') === 'text').length;
  }
  const userMsgs = messages.filter((m) => isRecord(m) && m.role === 'user');
  if (userMsgs.length) {
    shape.userMsgCount = userMsgs.length;
    const last = userMsgs[userMsgs.length - 1] as Record<string, any>;
    shape.lastUserContentType = Array.isArray(last.content) ? 'array' : typeof last.content;
    if (typeof last.content === 'string') shape.lastUserStringLen = (last.content as string).length;
    if (Array.isArray(last.content)) shape.lastUserBlockKinds = [...new Set(last.content.filter(isRecord).map((b) => String((b as Record<string, any>).type || '')))];
  }
  if (Object.keys(shape).length) shape.topKeys = Object.keys(options).slice(0, 40);
  // 工具调用是否由宿主传入（透传依赖此信息；forwardTo 原样保留 tools / tool_choice）
  const tools = Array.isArray(options.tools) ? options.tools : null;
  if (tools) {
    shape.hasTools = true;
    shape.toolCount = tools.length;
    shape.toolNames = tools.map((t) => (isRecord(t) ? t.function?.name ?? t.name ?? null : null)).filter(Boolean).slice(0, 20);
  }
  if (options.tool_choice !== undefined) shape.toolChoice = options.tool_choice;
  return Object.keys(shape).length ? shape : null;
}

/** 路由虚拟模型声明的多模态输入能力：全量声明，宿主才会把图片/视频/文件/音频传给路由转发层。 */
const ROUTE_INPUT_MODALITIES = ['text', 'image', 'video', 'file', 'audio'];

/** 路由虚拟模型声明的输出能力：全量声明，宿主才允许路由承载「能生成图片/视频」的模型输出。 */
const ROUTE_OUTPUT_MODALITIES = ['text', 'image', 'video', 'audio', 'file'];

/** 附件类型（决策提示用）到「能力关键词」的映射：带附件时决策层据此优先选有对应能力的模型。 */
export const ATTACHMENT_HINT_CAPABILITIES: Record<string, string[]> = {
  image: ['多模态', '图片', '视觉', '图像', 'vision', 'image', 'multimodal'],
  video: ['多模态', '视频', '视觉', 'video', 'vision', 'multimodal'],
  file: ['文件', '文档', 'file', 'document'],
  audio: ['音频', '语音', 'audio', 'multimodal'],
};

/**
 * 把多模态输入块规范化为目标模型（vllm 等 OpenAI 兼容服务）可识别的结构：
 *  - image：{type:'image', url|data} → {type:'image_url', image_url:{url}}（含 base64 → data URL）
 *  - video：{type:'video', url} / {type:'video_url', url} → {type:'video_url', video_url:{url}}
 *  - file / audio：无统一开放标准，原样透传（保留全部字段），由目标模型侧处理
 *  - 未知字段（file_id / attachmentId / 本地路径等）保留原样
 * 幂等：已规范化的块再次处理不变（重试 / 故障转移无副作用）。
 */
export function normalizeMultimodalInput(forwarded: Record<string, any>): void {
  const norm = (block: Record<string, any>): void => {
    if (!isRecord(block)) return;
    const kind = String(block.type || '').toLowerCase();
    if (kind === 'image_url') {
      if (typeof block.url === 'string' && block.url.trim() && !block.image_url) {
        block.image_url = { url: block.url };
        delete block.url;
      }
      return;
    }
    if (kind === 'image') {
      if (block.image_url && typeof block.image_url === 'object') return;
      if (typeof block.url === 'string' && block.url.trim()) {
        block.type = 'image_url';
        block.image_url = { url: block.url };
        delete block.url;
        return;
      }
      if (typeof block.data === 'string' && block.data.trim()) {
        const raw = block.data.startsWith('data:') ? block.data : `data:image/jpeg;base64,${block.data}`;
        block.type = 'image_url';
        block.image_url = { url: raw };
        delete block.data;
      }
      return;
    }
    if (kind === 'video_url') {
      if (typeof block.url === 'string' && block.url.trim() && !block.video_url) {
        block.video_url = { url: block.url };
        delete block.url;
      }
      return;
    }
    if (kind === 'video') {
      if (block.video_url && typeof block.video_url === 'object') return;
      if (typeof block.url === 'string' && block.url.trim()) {
        block.type = 'video_url';
        block.video_url = { url: block.url };
        delete block.url;
      }
      return;
    }
    // file / audio / 其它：原样保留，交由目标模型侧处理
  };
  if (Array.isArray(forwarded.input)) forwarded.input.forEach(norm);
  const messages = Array.isArray(forwarded.messages) ? forwarded.messages : [];
  for (const msg of messages) {
    if (isRecord(msg) && Array.isArray(msg.content)) msg.content.forEach(norm);
  }
}

async function* forwardTo(
  deps: RouteAdapterDeps,
  options: Record<string, any>,
  modelKey: string,
  source: string,
  fallbackModel?: string,
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
  // 多模态输入规范化为目标模型可识别格式（image_url），否则带图消息转发后图片失效
  normalizeMultimodalInput(forwarded);
  let emitted = false;
  const seenOutKinds = new Set<string>();
  try {
    const stream = deps.host.llm.stream(forwarded);
    for await (const chunk of stream) {
      emitted = true;
      // 输出块观测：目标模型返回的图片/视频/音频/文件等非文本块（首样本去重），确认生成输出透传形状
      if (isRecord(chunk)) {
        const kind = String((chunk as Record<string, any>).type || (chunk as Record<string, any>).kind || '').toLowerCase();
        if (kind && kind !== 'text' && !seenOutKinds.has(kind)) {
          seenOutKinds.add(kind);
          routeLog(deps, { event: 'forward-media', session: options.sessionId ?? '', model: modelKey, kind, fields: Object.keys(chunk as Record<string, any>).slice(0, 20) });
        }
      }
      yield chunk;
    }
  } catch (error) {
    const message = (error as Error)?.message ?? error;
    // 仅当尚未输出任何内容时才切兜底：已输出部分内容时切换会造成重复回复。
    if (!emitted && fallbackModel && fallbackModel !== modelKey) {
      const fbParsed = parseModelKey(fallbackModel);
      if (fbParsed && fbParsed.provider !== ROUTE_PROVIDER) {
        warn(deps, `转发到 ${modelKey} 失败，启用兜底模型 ${fallbackModel}：${message}`);
        routeLog(deps, { event: 'fallback-after-error', session: options.sessionId ?? '', model: modelKey, fallback: fallbackModel, message: String(message).slice(0, 500) });
        const fbForwarded: Record<string, any> = { ...options, provider: fbParsed.provider, model: fbParsed.model };
        const fbStream = deps.host.llm.stream(fbForwarded);
        for await (const chunk of fbStream) yield chunk;
        return;
      }
    }
    throw new Error(`MRRP 已按权限路由到 ${modelKey}，但该模型调用失败：${message}`);
  }
}
