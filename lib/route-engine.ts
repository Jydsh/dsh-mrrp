import type { CategoryBinding, DecisionProvider, ImRouteConfig, ImRouteQuestion, PluginConfig } from './store.js';
import { makeLayaDecide, openaiChatDecide } from './decision.js';
import {
  buildDecisionSlots,
  decisionPoolConfig,
  defaultDecisionScheduler,
  DECISION_MAX_ATTEMPTS,
  type DecisionScheduler,
  type DecisionSlotDef,
} from './decision-pool.js';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 按天路由决策日志文件名：route-decision-YYYY-MM-DD.log（多人共用、按天分文件，避免单文件臃肿）。 */
export function routeLogFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `route-decision-${y}-${m}-${d}.log`;
}

/** 当天路由决策日志文件绝对路径（baseDir 为 config.json 所在目录）。 */
export function routeLogPathFor(baseDir: string, now: Date = new Date()): string {
  return join(baseDir, routeLogFileName(now));
}

/**
 * MRRP 决策模型路由（新方案：adapter 暴露虚拟模型 + 按用户权限决策真实模型）。
 *
 * 链路：dsh-im 钉钉消息进入 DSH 会话 → 会话事件被观测，记录「会话 → 发送者」映射；
 *   对话模型选择器里选中 MRRP 暴露的虚拟模型（mrrp:route）后，宿主把生成调用交给
 *   MRRP adapter → adapter 用会话 id 查发送者 → 解析用户 → 用户（单独角色 + 所属部门
 *   角色）绑定的模型分类 → 分类内模型去重 → 若候选多个，用内置判定问题请 laya 决策模型
 *   选一个 → MRRP 代理该模型（ctx.llm.stream）生成回复。
 *
 * 本文件提供：事件提取（兼容宿主真实事件形状）、会话→发送者映射服务、目标模型决策
 * 纯函数（内置判定问题）。adapter 本体见 route-adapter.ts。
 *
 * 原则：事件观测只读不拦截；任何异常静默降级，绝不影响 DSH 主链路。
 */

/** DSH 运行时上下文（宽松类型：仅用到 on/off）。 */
export interface RoutingCtx {
  on?: (event: string, handler: (session: unknown, event: unknown) => void, options?: unknown) => unknown;
  off?: (event: string, handler: (session: unknown, event: unknown) => void) => unknown;
}

/** 宽松日志器。 */
export interface RoutingLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/** 引擎依赖。 */
export interface ImRoutingDeps {
  getConfig(): PluginConfig;
  logger?: RoutingLogger;
  /** 决策执行器（测试可注入；缺省按 decisionProviderId / decisionProviderIds 走 laya 提供方，多提供方负载均衡 + 故障转移） */
  decide?: (state: string, questions: Record<string, ImRouteQuestion>) => Promise<unknown>;
  /** 多提供方决策执行器（createDecisionRunner；缺省由 resolveTargetModelFromPool 按配置自建） */
  decisionRunner?: DecisionRunner;
  /**
   * 决策过程追踪（路由决策日志用）：在调用决策模型前后 / 出错时回调，
   * detail 含发送给 laya 的请求（state/questions/提供方）与原始响应 / 错误。
   * 仅用于记录与诊断，不参与决策逻辑。
   */
  onDecide?: (phase: 'before' | 'after' | 'error', detail: Record<string, unknown>) => void;
  /**
   * dsh-dingtalk 桥会话映射读取器（只读 state.json）。
   * DSH agent inbox 消息不携带发送者身份，而钉钉桥持久化了
   * p2p:<staffId> -> DSH sessionId 的映射，可据此解析发送者。
   */
  dingtalkBridge?: { readSessions(): Promise<Map<string, string>> };
  /**
   * 会话级权限下发：识别出 IM 发送者后，按该用户的权限规则把
   * 「沙箱模式 / 审批策略」写进会话（宿主内核据此拦截进程与文件操作）。
   * 未注入时不做会话级限制，仅保留 adapter 的工具闸门。
   */
  applyPermission?: (session: unknown, senderId: string, config: PluginConfig) => string;
}

/** 目标模型决策结果（adapter 与测试可见）。 */
export interface TargetModelOutcome {
  /** 选中的模型（provider:id） */
  model: string;
  /** 命中来源：user=用户绑定唯一模型 / laya=决策模型选出 / fallback / unknown-fallback */
  source: 'user' | 'laya' | 'fallback' | 'unknown-fallback';
  /** 候选模型池（去重后的全部候选，laya 决策前） */
  candidates: string[];
  /** 候选来源拆分（方案 B）：direct=用户直接角色（显式授权），inherited=部门继承（组织授权并集） */
  sources: { direct: string[]; inherited: string[] };
  /** 决策模型输出（字段 -> 值），laya 决策后存在 */
  decision?: Record<string, string>;
  /** laya 给出的选择理由（reasoning），供路由日志展示 */
  reasoning?: string;
  /** 实际执行决策的提供方 id（source=laya 时存在；多提供方轮询/故障转移后记录） */
  providerId?: string;
  /** 本次决策是否经过故障转移（首个提供方失败后换下一个成功，source=laya 时记录） */
  failover?: boolean;
  /** 实际执行决策的模型名（并发调度池里选中的槽；本地 laya 为空字符串） */
  decisionModel?: string;
  /** 决策排队时长（毫秒）：> 0 表示当时池里有模型在忙、请求排过队 */
  decisionWaitMs?: number;
  /** 附件能力硬校验是否改选了模型（决策模型把带附件消息判给无能力模型时强制校正） */
  attachmentOverride?: boolean;
}

/**
 * 用户可用模型池（决策输入的**可缓存部分**）：
 * 用户命中 + 直接角色 / 部门继承候选，与「消息内容 / Laya 决策」无关。
 * adapter 按 发送者 + 配置指纹 缓存本池，每条消息只做 Laya 决策，不再重复组装候选。
 */
export interface UserModelPool {
  /** 用户是否在用户表命中（未命中时由调用方按 unknownUser 策略处理） */
  userFound: boolean;
  /** 命中的用户记录（姓名用于决策问题上下文） */
  user?: PluginConfig['users'][number];
  /** 直接角色候选（显式授权，排序在前） */
  direct: string[];
  /** 部门继承候选（并集补充） */
  inherited: string[];
}

export interface ImRoutingHandle {
  start(): void;
  stop(): void;
  /** 运行状态（供 route.im.status RPC 调试用） */
  status(): Record<string, unknown>;
  /** 会话 → 发送者映射查询（adapter 用；查不到返回 null） */
  resolveSender(sessionId: string): { senderId: string; senderName: string } | null;
  /** 由 adapter 从请求正文回填映射（事件观测被拒 / 桥未覆盖时的兜底；实现可忽略） */
  rememberSender?(sessionId: string, sender: { senderId: string; senderName: string }): void;
}

const IM_SOURCE_KINDS = new Set(['plugin:dsh-im', 'runtime-context', 'time-context', 'skill-catalog', 'user']);

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function log(deps: ImRoutingDeps, level: 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void {
  try { deps.logger?.[level]?.(`[dsh-mrrp:im-route] ${message}`, ...args); } catch { /* ignore */ }
}

/** 安全摘要：JSON 序列化截断，避免大对象 / 循环引用 / 函数打爆日志。 */
function safeSample(value: unknown, max = 300): string {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch { return String(value); }
}

/** source 字段形态摘要：懒函数调用一次取展开值，对象取 keys + 样本。 */
function summarizeSource(src: unknown): unknown {
  if (typeof src === 'function') {
    try {
      const expanded = (src as () => unknown)();
      return { type: 'function', expanded: safeSample(expanded) };
    } catch (error) {
      return { type: 'function', error: (error as Error)?.message ?? String(error) };
    }
  }
  if (src && typeof src === 'object') {
    return { type: 'object', keys: Object.keys(src), sample: safeSample(src) };
  }
  return { type: typeof src };
}

/** content 归一化为纯文本（支持 string 与 ContentBlock[]）。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/**
 * dsh-im 把发送者信息作为 `<dsh_im_source>` 前缀块附加在用户消息正文之前：
 *   <dsh_im_source>{"senderId":"xxx","senderName":"张三"}</dsh_im_source>
 *   <dsh_im_source>senderId: xxx / senderName: 张三</dsh_im_source>
 *   （用户实际消息内容）
 * 块内可能是 JSON，也可能是裸键值（dsh-im 不同版本两种形态都出现过），键名后可能带引号，
 * 因此匹配时容忍键名后的可选引号，避免 JSON 形态因 `"senderId":"…"` 解析失败。
 * 返回 { senderId, senderName, rest }（rest = 去掉前缀块后的正文）。
 */
export function extractSenderFromContent(content: string): { senderId: string; senderName: string; rest: string } {
  const m = /<dsh_im_source>([\s\S]*?)<\/dsh_im_source>/.exec(content);
  if (!m) return { senderId: '', senderName: '', rest: content };
  const block = m[1];
  const id = /senderId["']?\s*[:：]\s*["']?([^\s,，;；"'`}\]]+)/.exec(block)?.[1]?.trim() ?? '';
  const name = /senderName["']?\s*[:：]\s*["']?([^"'`}\r\n]+)/.exec(block)?.[1]?.trim() ?? '';
  const rest = content.slice(m.index + m[0].length).replace(/^\s*\r?\n?/, '');
  return { senderId: id, senderName: name, rest };
}

/**
 * 从会话事件对象提取消息来源与文本。
 *
 * 兼容两类宿主事件形状（实测根因修复）：
 *  - dsh-im 的 `user/message`：event.data 是消息对象，senderId 位于消息顶层
 *    （data.senderId），钉钉等渠道为 message.senderId / message.senderName；
 *    data.source 可能是懒函数（source: () => ({ channel, senderId, chatId })）也可能
 *    已被宿主展开为对象，两种都兼容。
 *  - DSH agent inbox 的 `agent/inbox/spliced`：data.inserted 是 UserMessage[]（最新
 *    插入在末尾），从最后一条消息提取发送者；`agent/inbox/inserted`：data.message。
 *    若消息未携带 senderId（如 agent 自身注入的内容）则返回 null，不建立映射。
 *
 * 提取规则（senderId 存在作为 IM 来源强信号把关）：
 *   1. 消息顶层 senderId；
 *   2. source 展开（懒函数 / 对象）；
 *   3. 消息正文 `<dsh_im_source>` 前缀块（dsh-im 把发送者信息附加在用户消息正文之前）。
 * senderName 依次：source → 前缀块 → contextSource() → 消息顶层。
 */
export function extractEvent(context: unknown): { channel: string; senderId: string; senderName: string; text: string } | null {
  const event = isRecord(context) ? context : {};
  const type = event.type;

  // 定位「消息对象」：不同事件类型的载体不同
  let message: Record<string, any> | null = null;
  if (type === 'user/message') {
    message = isRecord(event.data) ? event.data : null;
  } else if (type === 'agent/inbox/spliced') {
    const data = isRecord(event.data) ? event.data : {};
    const inserted = Array.isArray(data.inserted) ? data.inserted : [];
    // 最新插入在末尾；outcome='canceled' 是纯删除，无新消息
    if (data.outcome === 'canceled' || inserted.length === 0) return null;
    const last = inserted[inserted.length - 1];
    if (isRecord(last)) message = last;
  } else if (type === 'agent/inbox/inserted') {
    const data = isRecord(event.data) ? event.data : {};
    message = isRecord(data.message) ? data.message : (isRecord(data) ? data : null);
  } else {
    return null;
  }
  if (!message) return null;

  // source 展开：懒函数或对象（dsh-im 消息带；inbox 标准消息可能没有）
  let source: Record<string, any> = {};
  const rawSource = message.source;
  if (typeof rawSource === 'function') {
    try {
      const expanded = rawSource();
      if (isRecord(expanded)) source = expanded;
    } catch { /* ignore */ }
  } else if (isRecord(rawSource)) {
    source = rawSource;
  }

  // kind / form 排除：显式非 IM 来源（快照 / 目录 / 运行时上下文 / 其它插件）不路由
  const kind = typeof source.kind === 'string' ? source.kind : '';
  const form = typeof source.form === 'string' ? source.form : '';
  if (kind && !IM_SOURCE_KINDS.has(kind)) return null;
  if (kind && (form === 'snapshot' || form === 'notice' || form === 'catalog')) return null;

  // 正文归一化 + <dsh_im_source> 前缀块解析（dsh-im 把发送者信息附加在正文之前）
  const contentText = contentToText(message.content);
  const fromContent = extractSenderFromContent(contentText);

  // senderId：消息顶层 → source 展开 → 正文前缀块
  const senderId = pickString(message.senderId) ?? pickString(source.senderId) ?? fromContent.senderId;
  if (!senderId) return null;

  // senderName：source → 前缀块 → contextSource() → 消息顶层
  let senderName = pickString(source.senderName) ?? (fromContent.senderName || null) ?? pickString(message.senderName) ?? '';
  if (!senderName && typeof message.contextSource === 'function') {
    try {
      const cs = message.contextSource();
      if (isRecord(cs)) senderName = pickString(cs.senderName) ?? '';
    } catch { /* ignore */ }
  }

  const text = fromContent.rest || contentText;
  const channel = pickString(source.channel) ?? pickString(message.channel) ?? '';
  return { channel, senderId, senderName, text: text.trim() };
}

/** 聚合用户可用模型：单独角色 + 所属部门绑定的角色，按分类取并集。 */
export function collectUserModels(config: PluginConfig, user: PluginConfig['users'][number]): Map<string, Set<string>> {
  const roleById = new Map(config.roles.map((role) => [role.id, role]));
  const deptById = new Map(config.depts.map((dept) => [dept.id, dept]));
  const merge = (map: Map<string, Set<string>>, bindings: CategoryBinding[]): void => {
    for (const binding of bindings) {
      if (!binding.categoryId) continue;
      let set = map.get(binding.categoryId);
      if (!set) { set = new Set(); map.set(binding.categoryId, set); }
      for (const model of binding.modelIds) if (model) set.add(model);
    }
  };
  const out = new Map<string, Set<string>>();
  if (user.roleId) {
    const role = roleById.get(user.roleId);
    if (role) merge(out, role.categoryBindings);
  }
  for (const deptId of user.deptIds) {
    const dept = deptById.get(deptId);
    if (!dept) continue;
    for (const roleId of dept.roleIds) {
      const role = roleById.get(roleId);
      if (role) merge(out, role.categoryBindings);
    }
  }
  return out;
}

/** 方案 B：用户可用模型按来源拆分——直接角色（显式授权，最高）优先，部门继承（组织授权）并集补充。 */
export function collectUserModelsPrioritized(
  config: PluginConfig,
  user: PluginConfig['users'][number],
): { direct: string[]; inherited: string[] } {
  const roleById = new Map(config.roles.map((role) => [role.id, role]));
  const deptById = new Map(config.depts.map((dept) => [dept.id, dept]));
  const addModels = (set: Set<string>, bindings: CategoryBinding[]): void => {
    for (const binding of bindings) {
      for (const model of binding.modelIds) if (model) set.add(model);
    }
  };
  const direct = new Set<string>();
  if (user.roleId) {
    const role = roleById.get(user.roleId);
    if (role) addModels(direct, role.categoryBindings);
  }
  const inherited = new Set<string>();
  for (const deptId of user.deptIds) {
    const dept = deptById.get(deptId);
    if (!dept) continue;
    for (const roleId of dept.roleIds) {
      const role = roleById.get(roleId);
      if (role) addModels(inherited, role.categoryBindings);
    }
  }
  // 多部门全部并集；部门继承不重复直接角色已有的模型
  const dedup = (set: Set<string>, skip: Set<string>): string[] => {
    const out: string[] = [];
    for (const model of set) if (model && !skip.has(model)) out.push(model);
    return out;
  };
  return { direct: dedup(direct, new Set()), inherited: dedup(inherited, direct) };
}

/** 把用户可用模型（分类 → 模型集合）展平为去重后的候选模型列表。 */
export function flattenUserModels(bindings: Map<string, Set<string>>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const set of bindings.values()) {
    for (const model of set) {
      if (model && !seen.has(model)) {
        seen.add(model);
        out.push(model);
      }
    }
  }
  return out;
}

/** 从 laya 决策响应中提取「问题名 -> 判定值」映射（兼容多种返回形状）。 */
export function extractDecisionValues(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    const rec = value as Record<string, any>;
    const response = rec.response && typeof rec.response === 'object' ? rec.response : null;
    const question = typeof rec.question === 'string'
      ? rec.question
      : typeof rec.name === 'string' ? rec.name : '';
    if (response) {
      const picked = response.choice !== undefined ? response.choice
        : response.score !== undefined ? response.score
          : response.noul !== undefined ? response.noul : undefined;
      if (question && picked !== undefined) {
        out[question] = String(picked);
        return;
      }
      // 无顶层 question（如内嵌模型决策 { model: { response: { choice } } }）：
      // 把 response 内部的判定值提到顶层，供 pickedModelFrom / resolveTargetModel 读取。
      for (const [k, v] of Object.entries(response)) {
        if (['type', 'instructions', 'criteria', 'reasoning', 'metadata', 'meta'].includes(k)) continue;
        if (v !== undefined && v !== null) out[k] = String(v);
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }
    for (const [key, child] of Object.entries(rec)) {
      if (['response', 'type', 'instructions', 'criteria', 'reasoning', 'metadata', 'meta'].includes(key)) continue;
      if (question && key === 'choice' || question && key === 'score' || question && key === 'noul') continue;
      if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
        out[key] = String(child);
      } else if (child && typeof child === 'object') {
        visit(child, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(data, '');
  return out;
}

/** 从 laya 决策响应中提取选择理由（reasoning）文本（兼容多种返回形状），供日志记录。 */
export function extractReasoning(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const visit = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const rec = value as Record<string, any>;
    const response = rec.response && typeof rec.response === 'object' ? rec.response : null;
    const candidates: unknown[] = response ? [response] : [];
    if (Array.isArray(rec.answers)) candidates.push(...rec.answers);
    for (const item of candidates) {
      if (item && typeof item === 'object' && typeof (item as Record<string, any>).reasoning === 'string'
          && (item as Record<string, any>).reasoning.trim()) {
        return (item as Record<string, any>).reasoning.trim().slice(0, 500);
      }
    }
    if (typeof rec.reasoning === 'string' && rec.reasoning.trim()) return rec.reasoning.trim().slice(0, 500);
    for (const child of Object.values(rec)) {
      if (child && typeof child === 'object') {
        const found = visit(child);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(data);
}

/** 解析模型标识 provider:id；无效返回 null。 */
export function parseModelKey(key: string): { provider: string; model: string } | null {
  const text = (key ?? '').trim();
  const index = text.indexOf(':');
  if (index <= 0 || index === text.length - 1) return null;
  const provider = text.slice(0, index).trim();
  const model = text.slice(index + 1).trim();
  if (!provider || !model || provider.length > 128 || model.length > 128) return null;
  return { provider, model };
}

/** 生成路径的候选选择超时：决策慢 / 不可达时快速落兜底，避免用户干等。 */
const DECISION_TIMEOUT_MS = 6000;
/** OpenAI 兼容对话判定超时（普通大模型推理比 laya 判定慢，放宽到 10s）。 */
const CHAT_DECISION_TIMEOUT_MS = 10_000;

/** 决策执行结果：Laya 原始响应 + 实际使用的提供方 / 模型 + 是否故障转移。 */
export interface DecisionRunResult {
  data: unknown;
  providerId: string;
  /** 实际使用的判定模型名（本地 laya 为空字符串） */
  model?: string;
  failover: boolean;
  /** 排队等待时长（毫秒）：大于 0 说明当时池里有模型在忙 */
  waitMs?: number;
}

/** 多提供方决策执行器：负载均衡（轮询）+ 故障转移（按序换用）。 */
export interface DecisionRunner {
  run(opts: {
    providerIds: string[];
    state: string;
    questions: Record<string, ImRouteQuestion>;
    /** 会话/用户标识：并发调度下用于粘性复用上次成功的模型 */
    sessionKey?: string;
    onDecide?: (phase: 'before' | 'after' | 'error', detail: Record<string, unknown>) => void;
  }): Promise<DecisionRunResult | null>;
}

/** 生效的决策提供方有序列表：优先 imRoute.decisionProviderIds，空则回退 [decisionProviderId]。 */
export function effectiveDecisionProviderIds(cfg: ImRouteConfig | undefined): string[] {
  if (!cfg) return [];
  const list = Array.isArray(cfg.decisionProviderIds) && cfg.decisionProviderIds.length
    ? cfg.decisionProviderIds
    : (cfg.decisionProviderId ? [cfg.decisionProviderId] : []);
  return list.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());
}

/**
 * 创建决策执行器。两条路径：
 *
 * 1. **并发调度池（默认）**：把「选中的提供方 + 每个提供方下的模型」展开成池，
 *    按最少在途分流 —— 某个模型在忙时自动换空闲的模型，不用排队等它；
 *    全部满额才排队（等 queueTimeoutMs，超时落兜底）；失败换下一个槽（最多 DECISION_MAX_ATTEMPTS 个）。
 *    主用模型只作优先级，不强制独占。
 * 2. **旧路径**（`decisionPool.enabled=false`，或池里只有 1 个槽）：按提供方轮询起始 + 顺序故障转移。
 *
 * - decide 注入（测试）：直接单次调用，providerId 取列表首个；
 * - execute 注入（测试）：替换真实网络调用，第 5 参是该槽的模型名。
 */
export function createDecisionRunner(ctx: {
  getConfig(): PluginConfig;
  decide?: ImRoutingDeps['decide'];
  execute?: (provider: DecisionProvider, state: string, questions: Record<string, ImRouteQuestion>, timeoutMs: number, model?: string) => Promise<unknown>;
  /** 并发调度器（测试注入独立实例，避免用例之间共享在途计数） */
  scheduler?: DecisionScheduler;
}): DecisionRunner {
  const providersOf = (config: PluginConfig, ids: string[]): DecisionProvider[] => {
    const out: DecisionProvider[] = [];
    for (const id of ids) {
      const provider = config.decisionProviders.find((item) => item.id === id);
      // 决策提供方支持 laya 与 OpenAI 兼容格式（openai / generic）：
      // 云端判定型服务（如阿里云 MaaS compatible-mode/systemone、0G decisions）走同一判定协议。
      if (provider && provider.baseUrl && (provider.format === 'laya' || provider.format === 'openai' || provider.format === 'generic')) out.push(provider);
    }
    return out;
  };

  /** 按槽发起一次真实决策（本地 laya 不带 model，其余带该槽的主模型名）。 */
  const runSlot = async (slot: DecisionSlotDef, state: string, questions: Record<string, ImRouteQuestion>): Promise<unknown> => {
    const provider = slot.provider;
    if (ctx.execute) return ctx.execute(provider, state, questions, DECISION_TIMEOUT_MS, slot.model);
    if (provider.endpoint === 'chat') {
      // OpenAI 兼容对话判定：普通大模型当判定器
      const run = openaiChatDecide(() => ({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey || '',
        model: slot.model,
      }), CHAT_DECISION_TIMEOUT_MS);
      return run({ state, questions });
    }
    const decisionModel = provider.format === 'laya' ? '' : slot.model;
    const run = makeLayaDecide(() => ({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey || '',
      endpoint: provider.endpoint,
      model: decisionModel || undefined,
    }), DECISION_TIMEOUT_MS);
    return run({ state, questions });
  };

  let rr = 0;

  return {
    async run({ providerIds, state, questions, onDecide, sessionKey }) {
      const ids = providerIds.filter(Boolean);
      if (!ids.length) return null;
      // 测试注入：直接走 decide（单次）
      if (typeof ctx.decide === 'function') {
        try {
          onDecide?.('before', { providerId: ids[0], state, questions, timeoutMs: DECISION_TIMEOUT_MS });
          const data = await ctx.decide(state, questions);
          onDecide?.('after', { providerId: ids[0], raw: data });
          return { data, providerId: ids[0], failover: false };
        } catch (error) {
          onDecide?.('error', { providerId: ids[0], message: (error as Error)?.message ?? String(error) });
          return null;
        }
      }
      // 真实路径：过滤启用的决策提供方（laya / openai / generic，baseUrl 非空）
      const config = ctx.getConfig();
      const providers = providersOf(config, ids);
      if (!providers.length) {
        onDecide?.('error', { providerId: ids[0], message: '未找到启用的决策提供方（format=laya/openai/generic 且 baseUrl 非空）' });
        return null;
      }

      const pool = decisionPoolConfig(config.route?.imRoute);
      const slots = buildDecisionSlots(config, ids);
      const scheduler = ctx.scheduler ?? defaultDecisionScheduler;

      // 并发调度池：多槽时按最少在途分流（同 API 多模型也各占一个槽）
      if (pool.enabled && slots.length > 1) {
        const tried = new Set<string>();
        const attempts = Math.min(slots.length, DECISION_MAX_ATTEMPTS);
        let waitTotal = 0;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const remaining = slots.filter((slot) => !tried.has(slot.key));
          if (!remaining.length) break;
          const got = await scheduler.acquire(remaining, {
            sessionKey,
            sticky: pool.sticky,
            queueTimeoutMs: pool.queueTimeoutMs,
          });
          if (!got) {
            onDecide?.(attempt > 0 ? 'error' : 'before', {
              message: '所有决策模型都在忙，排队等待超时',
              timeoutMs: pool.queueTimeoutMs,
              waitMs: waitTotal,
              failover: attempt > 0,
            });
            return null;
          }
          const slot = got.slot;
          const failover = attempt > 0;
          waitTotal += got.waitMs;
          try {
            onDecide?.('before', {
              providerId: slot.provider.id,
              provider: { baseUrl: slot.provider.baseUrl, endpoint: slot.provider.endpoint, format: slot.provider.format },
              model: slot.model,
              waitMs: got.waitMs,
              state,
              questions,
              timeoutMs: DECISION_TIMEOUT_MS,
              failover,
            });
            const data = await runSlot(slot, state, questions);
            scheduler.release(slot, { ok: true, sessionKey });
            onDecide?.('after', { providerId: slot.provider.id, model: slot.model, waitMs: got.waitMs, raw: data, failover });
            return { data, providerId: slot.provider.id, model: slot.model, failover, waitMs: waitTotal };
          } catch (error) {
            scheduler.release(slot, { ok: false, sessionKey, error: (error as Error)?.message ?? String(error) });
            tried.add(slot.key);
            onDecide?.('error', {
              providerId: slot.provider.id,
              model: slot.model,
              message: (error as Error)?.message ?? String(error),
              waitMs: got.waitMs,
              failover,
            });
          }
        }
        return null;
      }

      // 旧路径：按提供方轮询起始 + 顺序故障转移
      const start = (rr % providers.length);
      rr += 1;
      for (let i = 0; i < providers.length; i += 1) {
        const provider = providers[(start + i) % providers.length];
        const model = provider.format === 'laya' ? '' : (provider.modelNames?.[0] || '').trim();
        const slot: DecisionSlotDef = { key: `${provider.id}::${model}`, provider, model, limit: 1, weight: 1, primary: false };
        const failover = i > 0;
        try {
          onDecide?.('before', {
            providerId: provider.id,
            provider: { baseUrl: provider.baseUrl, endpoint: provider.endpoint, format: provider.format },
            model,
            state,
            questions,
            timeoutMs: DECISION_TIMEOUT_MS,
            failover,
          });
          const data = await runSlot(slot, state, questions);
          onDecide?.('after', { providerId: provider.id, model, raw: data, failover });
          return { data, providerId: provider.id, model, failover };
        } catch (error) {
          onDecide?.('error', { providerId: provider.id, model, message: (error as Error)?.message ?? String(error), failover });
        }
      }
      return null;
    },
  };
}

/** 内置判定问题：让 laya 在候选模型里选一个（插件内置，用户不再配置）。
 *  候选带类型/擅长场景（来自分类画像）后，criteria 值 = 「名称（类型：…；擅长：…）」，
 *  Laya 可依据类型语义做决策，不再只靠模型名猜测。 */
export function builtinModelChoiceQuestion(
  candidates: Array<{ key: string; name: string; type?: string; scene?: string }>,
  context?: string,
): ImRouteQuestion {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    const parts = [candidate.name];
    if (candidate.type) parts.push(`类型：${candidate.type}`);
    if (candidate.scene) parts.push(`擅长：${candidate.scene}`);
    criteria[candidate.key] = parts.join('；');
  }
  const contextBlock = context ? `\n背景：${context}` : '';
  return {
    type: 'choice',
    instructions:
      `state 中是用户的问题正文。请根据问题的语义、复杂度、是否涉及代码/视觉/长文本、所需推理深度，从候选模型列表中选择最合适的模型；候选已标注类型与擅长场景。只能选择候选模型列表中存在的 key，不要编造其它 key，并在 response 中附带一句简短 reasoning 说明选择理由。${contextBlock}`,
    criteria,
  };
}

/** 收集用户可用模型池（决策上下文缓存用）：用户命中 + 直接角色 / 部门继承候选。 */
export function collectUserModelPool(config: PluginConfig, senderId: string): UserModelPool {
  const user = config.users.find((item) => item.id === senderId);
  if (!user) return { userFound: false, direct: [], inherited: [] };
  const { direct, inherited } = collectUserModelsPrioritized(config, user);
  return { userFound: true, user, direct, inherited };
}

/**
 * 目标模型决策（纯逻辑，无副作用；导出供测试）。
 *
 * 顺序：未注册用户（unknownUser）→ 用户可用模型池（角色 + 部门，去重）→
 *   池空用兜底；池唯一直接用；池多个用内置判定问题请决策模型（laya）选择 →
 *   决策失败 / 未命中用兜底。
 *
 * 候选池可经 collectUserModelPool 缓存（决策输入复用），每次消息仍执行本决策：
 * 候选多时每次都让 Laya 按消息内容选择模型，不再按会话锁死已决策模型。
 */
export async function resolveTargetModel(
  deps: ImRoutingDeps,
  cfg: ImRouteConfig,
  senderId: string,
  text: string,
): Promise<TargetModelOutcome | null> {
  const config = deps.getConfig();
  return resolveTargetModelFromPool(collectUserModelPool(config, senderId), deps, cfg, senderId, text);
}

/** 附件类型合法值（决策提示用，防止任意字符串污染判定问题）。 */
const ATTACHMENT_TYPES = new Set(['image', 'video', 'file', 'audio']);

/** 附件类型 → 中文标签（用于决策提示）。 */
const ATTACHMENT_LABELS: Record<string, string> = {
  image: '图片',
  video: '视频',
  file: '文件',
  audio: '音频',
};

/**
 * 构造附件能力提示：仅当消息带附件时追加。
 * 决策模型不需要理解附件内容——只按「附件类型 → 需要对应输入能力的模型」决策。
 */
export function attachmentContextHint(attachments?: string[]): string {
  const types = (attachments || [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => ATTACHMENT_TYPES.has(t));
  if (!types.length) return '';
  const labels = [...new Set(types)].map((t) => ATTACHMENT_LABELS[t] || t).join('、');
  return ` 本条消息包含附件：${labels}。决策目标：优先选择候选模型中「能处理该类输入」的模型（候选类型/擅长场景中标注了 多模态/图片/视频/文件/音频 等能力标签的优先；若候选均无对应能力，再按任务语义选择最合适的模型）。`;
}

/**
 * 模型画像类型文本：控制台手动维护的 modelProfiles.type（多选数组）优先，
 * 未配置则取模型所在分类的「名称」兜底；返回 undefined 表示无任何类型标注。
 */
export function profileTypeText(config: PluginConfig, key: string): string | undefined {
  const profile = config.modelProfiles?.[key];
  const hits = config.categories.filter((category) => category.modelIds.includes(key));
  const profileTypes = Array.isArray(profile?.type)
    ? (profile.type as string[]).filter(Boolean)
    : (typeof profile?.type === 'string' && (profile.type as string).trim() ? [(profile.type as string).trim()] : []);
  return profileTypes.length ? profileTypes.join('、') : hits.map((category) => category.name).join('、') || undefined;
}

/** 附件能力关键词：画像/分类类型文本命中任一即视为「可处理该附件输入」。 */
const ATTACHMENT_CAPABILITY_HINTS = ['多模态', '图片', '视觉', '图像', '视频', '文件', '文档', '音频', '语音', 'vision', 'image', 'multimodal', 'video', 'file', 'audio'];

export function hasAttachmentCapability(typeText: string | undefined): boolean {
  if (!typeText) return false;
  const t = typeText.toLowerCase();
  return ATTACHMENT_CAPABILITY_HINTS.some((h) => t.includes(h.toLowerCase()));
}

/**
 * 附件能力硬校验：决策模型（如本地 laya）可能无视附件提示、不读能力标签，
 * 把带附件消息判给无对应能力的模型（实测：对候选第一位有强位置偏见）。
 * 规则：被选模型画像/分类已含能力标签 → 不干预；否则改选候选池中第一个
 * 含能力标签的模型（直接授权在前）；池内确无能力模型 → 返回 null 保持原决策。
 */
export function enforceAttachmentCapability(
  picked: string,
  candidates: string[],
  config: PluginConfig,
  attachments?: string[],
): string | null {
  if (!attachmentContextHint(attachments)) return null;
  if (hasAttachmentCapability(profileTypeText(config, picked))) return null;
  return candidates.find((key) => key !== picked && hasAttachmentCapability(profileTypeText(config, key))) ?? null;
}

/**
 * 目标模型决策主流程（候选池已就绪）：
 *   池空用兜底；池唯一直接用；池多个用内置判定问题请决策模型（laya）选择 →
 *   决策失败 / 未命中用兜底。
 *
 * attachments：本条消息携带的附件类型（image / video / file / audio 等，可空）。
 * 决策模型无需理解附件内容——判定问题会带上「本条消息包含 XX 附件」提示，
 * 让 Laya 优先选择候选画像中标注了对应能力（多模态 / 图片 / 视频 / 文件）的模型。
 */
export async function resolveTargetModelFromPool(
  pool: UserModelPool,
  deps: ImRoutingDeps,
  cfg: ImRouteConfig,
  senderId: string,
  text: string,
  attachments?: string[],
): Promise<TargetModelOutcome | null> {
  const config = deps.getConfig();

  // 1. 未注册用户
  if (!pool.userFound) {
    if (cfg.unknownUser !== 'fallback' || !cfg.fallbackModel) return null;
    return { model: cfg.fallbackModel, source: 'unknown-fallback', candidates: [], sources: { direct: [], inherited: [] } };
  }

  // 2. 用户可用模型池（方案 B：直接角色在前 = 显式授权最高；部门继承并集补充）
  const candidates = [...pool.direct, ...pool.inherited];
  const sources = { direct: pool.direct, inherited: pool.inherited };
  if (candidates.length === 0) {
    if (cfg.fallbackModel) return { model: cfg.fallbackModel, source: 'fallback', candidates, sources };
    return null;
  }
  if (candidates.length === 1) {
    return { model: candidates[0], source: 'user', candidates, sources };
  }

  // 3. 多个候选：内置判定问题请决策模型选择（多提供方：负载均衡轮询 + 故障转移）
  const providerIds = effectiveDecisionProviderIds(cfg);
  if (!providerIds.length) {
    if (cfg.fallbackModel) return { model: cfg.fallbackModel, source: 'fallback', candidates, sources };
    return null;
  }
  const question = builtinModelChoiceQuestion(candidates.map((key) => {
    const parsed = parseModelKey(key);
    const type = profileTypeText(config, key);
    // 擅长场景：手动画像优先；未配置时回退到模型绑定分类的描述（同一分类的模型共用同一段擅长文案）。
    const scene = config.modelProfiles?.[key]?.scene || config.categories.filter((category) => category.modelIds.includes(key)).map((category) => category.desc).filter(Boolean).join('；') || undefined;
    return { key, name: parsed ? parsed.model : key, type, scene };
  }), `发送者：${pool.user?.name || senderId}；候选授权来源：用户直接角色 ${pool.direct.length} 个模型 / 部门继承 ${pool.inherited.length} 个模型。${attachmentContextHint(attachments)}`);
  const questions = { model: question };
  const state = text || senderId;
  const runner = deps.decisionRunner ?? createDecisionRunner({ getConfig: deps.getConfig, decide: deps.decide });
  const result = await runner.run({
    providerIds,
    state,
    questions,
    // 并发调度下按发送者做粘性：同一用户优先复用上次成功的决策模型
    sessionKey: senderId || undefined,
    onDecide: deps.onDecide ? ((phase, detail) => deps.onDecide?.(phase, detail)) : undefined,
  });
  if (result) {
    const decision = extractDecisionValues(result.data);
    // 内置判定问题是 choice 类型，答案在 choice 字段；model 字段可能是 Laya 响应的
    // 服务/路由元数据（如 laya-rl-agent / multilingual），不能直接当作判定值。
    // 按「在候选池中匹配」优先取 choice，避免被元数据污染导致决策成功却误判失败。
    const picked = [decision.choice, decision.model].find((v) => v && candidates.includes(v)) ?? '';
    if (picked) {
      // 附件能力硬校验：本地 laya 实测无视附件提示、对候选第一位有强位置偏见，
      // 带图消息可能被判给无视觉能力的模型——此处强制校正（日志 attachment-override）。
      const overridden = enforceAttachmentCapability(picked, candidates, config, attachments);
      if (overridden) {
        log(deps, 'warn', `附件能力校验：决策选中 ${picked} 无对应附件能力，强制改选 ${overridden}（attachment-override）。`);
        return { model: overridden, source: 'laya', candidates, sources, decision, reasoning: extractReasoning(result.data), providerId: result.providerId, decisionModel: result.model, decisionWaitMs: result.waitMs, failover: result.failover, attachmentOverride: true };
      }
      return { model: picked, source: 'laya', candidates, sources, decision, reasoning: extractReasoning(result.data), providerId: result.providerId, decisionModel: result.model, decisionWaitMs: result.waitMs, failover: result.failover };
    }
    log(deps, 'warn', `决策结果未命中候选模型（${picked || '(空)'}），回退兜底模型。`);
  }

  // 4. 决策失败 / 未命中：兜底
  if (cfg.fallbackModel) return { model: cfg.fallbackModel, source: 'fallback', candidates, sources };
  return null;
}

/** 从会话事件回调参数提取会话 id（session.id 或 session.header.id）。 */
export function sessionIdOf(session: unknown): string {
  if (!isRecord(session)) return '';
  return pickString(session.id) ?? pickString(session.header?.id) ?? '';
}

/**
 * 创建会话发送者映射 + 路由诊断引擎。
 *
 * 新方案下不再切换会话模型（selectModel）；事件观测只做一件事：
 * 记录「会话 id → 最近发送者」映射，供 adapter 在生成调用时解析用户。
 */
export function createImRouting(ctx: RoutingCtx, deps: ImRoutingDeps): ImRoutingHandle {
  const logger = deps.logger;
  let attached: ((session: unknown, event: unknown) => void) | null = null;
  let off: (() => void) | null = null;
  let last = { at: 0, senderId: '', senderName: '', error: '' };
  let mappedCount = 0;
  let rejectLogged = false;
  const senderBySession = new Map<string, { senderId: string; senderName: string; at: number }>();
  /** 已下发过的会话权限签名（sessionId -> "sandbox/approval"），用于避免重复写会话事件。 */
  const permissionApplied = new Map<string, string>();

  // dsh-dingtalk 桥映射（sessionId -> senderId / senderName）：事件观测之外的兜底来源
  const bridgeSessions = new Map<string, string>();
  const bridgeNames = new Map<string, string>();
  const BRIDGE_TTL_MS = 5_000;
  let bridgeLoadedAt = 0;
  let bridgeLoading: Promise<void> | null = null;

  /** 从 config.users 解析发送者姓名（桥映射只给 senderId）。 */
  const bridgeNameOf = (senderId: string): string => {
    const hit = bridgeNames.get(senderId);
    if (hit !== undefined) return hit;
    let name = '';
    try {
      const users = deps.getConfig().users ?? [];
      const found = (Array.isArray(users) ? users : []).find((u: any) => u?.id === senderId);
      name = typeof found?.name === 'string' ? found.name : '';
    } catch { /* ignore */ }
    bridgeNames.set(senderId, name);
    return name;
  };

  /** 刷新 dingtalk 桥会话映射（TTL 防抖 + 防重入）。 */
  const refreshBridge = async (): Promise<void> => {
    if (!deps.dingtalkBridge) return;
    const now = Date.now();
    if (now - bridgeLoadedAt < BRIDGE_TTL_MS && bridgeSessions.size > 0) return;
    if (bridgeLoading) return bridgeLoading;
    bridgeLoading = (async () => {
      try {
        const sessions = await deps.dingtalkBridge!.readSessions();
        const before = bridgeSessions.size;
        for (const [sessionId, senderId] of sessions) bridgeSessions.set(sessionId, senderId);
        bridgeLoadedAt = Date.now();
        const added = bridgeSessions.size - before;
        if (added > 0 || before === 0) {
          log(deps, 'info', `会话映射（dingtalk 桥）：${bridgeSessions.size} 个会话（本次新增 ${added}）`);
        }
      } catch (error) {
        log(deps, 'warn', `读取 dingtalk 桥会话映射失败：${(error as Error)?.message ?? error}`);
      } finally {
        bridgeLoading = null;
      }
    })();
    return bridgeLoading;
  };

  /** 事件观测被拒（形状不匹配）时记一次诊断样本，避免每消息刷屏。 */
  const logFirstReject = (detail: Record<string, unknown>): void => {
    if (rejectLogged) return;
    rejectLogged = true;
    log(deps, 'warn', `会话事件观测拒绝（仅记录首个样本）：`, detail);
  };

  const handler = async (session: unknown, event: unknown): Promise<void> => {
    try {
      const cfg = deps.getConfig().route?.imRoute;
      if (!isRecord(event)) {
        logFirstReject({ reason: '回调 event 非对象', type: typeof event });
        return;
      }
      const info = extractEvent(event);
      if (!info) {
        // 事件未带发送者身份（DSH inbox 常见）：尝试从 dingtalk 桥反查，同时记录诊断样本
        void refreshBridge();
        const data = isRecord(event.data) ? event.data : {};
        const inserted = Array.isArray(data.inserted) ? data.inserted : [];
        const firstMsg = inserted.length > 0 && isRecord(inserted[0]) ? inserted[0] : null;
        logFirstReject({
          reason: 'extractEvent 未提取到 IM 消息（无 senderId 或非 IM 来源）',
          type: event.type,
          eventKeys: Object.keys(event),
          dataKeys: Object.keys(data),
          hasSenderId: typeof event.data === 'object' && event.data !== null ? 'senderId' in (event.data as Record<string, unknown>) : false,
          insertedCount: inserted.length,
          firstInsertedKeys: firstMsg ? Object.keys(firstMsg) : null,
          firstInsertedHasSenderId: firstMsg ? ('senderId' in firstMsg) : null,
          firstInsertedSource: firstMsg ? summarizeSource(firstMsg.source) : null,
          firstInsertedContent: firstMsg ? safeSample(contentToText(firstMsg.content), 500) : null,
        });
        return;
      }
      // 渠道白名单：channel 缺失时不拦截（无法判断渠道则放行，宁多勿漏）
      if (cfg?.channels && cfg.channels.length > 0 && info.channel && !cfg.channels.includes(info.channel)) {
        logFirstReject({ reason: '渠道不在白名单', channel: info.channel, channels: cfg.channels });
        return;
      }
      const sessionId = sessionIdOf(session);
      if (!sessionId) {
        last = { at: Date.now(), senderId: info.senderId, senderName: info.senderName, error: '事件未携带会话 id，无法建立映射' };
        log(deps, 'warn', `事件未携带会话 id，无法建立映射（sender=${info.senderName || info.senderId}）`);
        return;
      }
      senderBySession.set(sessionId, { senderId: info.senderId, senderName: info.senderName, at: Date.now() });
      mappedCount += 1;
      // 会话级权限下发：按发送者权限把沙箱模式 / 审批策略写进会话（宿主内核据此拦截命令与文件操作）。
      // 只在签名变化时写入，避免每条消息都往会话事件流里刷同样的权限事件。
      if (deps.applyPermission) {
        try {
          const signature = deps.applyPermission(session, info.senderId, deps.getConfig());
          if (signature && permissionApplied.get(sessionId) !== signature) {
            permissionApplied.set(sessionId, signature);
            log(deps, 'info', `会话权限：${sessionId}（${info.senderName || info.senderId}）→ ${signature}`);
          }
        } catch (error) {
          log(deps, 'warn', `会话权限下发失败（不影响主链路）：${(error as Error)?.message ?? error}`);
        }
      }
      last = { at: Date.now(), senderId: info.senderId, senderName: info.senderName, error: '' };
      log(deps, 'info', `会话映射：${sessionId} -> ${info.senderName || info.senderId}${cfg?.enabled ? '（决策模型已启动）' : '（决策模型未启动）'}`);
    } catch (error) {
      last = { at: Date.now(), senderId: '', senderName: '', error: (error as Error)?.message ?? String(error) };
      log(deps, 'warn', `事件观测异常（已忽略，不影响主链路）：${(error as Error)?.message ?? error}`);
    }
  };

  return {
    start() {
      if (attached) return;
      // 先加载 dingtalk 桥映射（插件启动可能早于钉钉桥写入，稍后再补一次）
      void refreshBridge();
      if (typeof ctx?.on !== 'function') {
        log(deps, 'warn', '当前 DSH 运行时未提供 ctx.on，会话发送者映射不可用（决策模型路由将无法解析用户）');
        return;
      }
      attached = (session, event) => { void handler(session, event); };
      try {
        const result = ctx.on('session/event', attached);
        if (typeof result === 'function') off = result as () => void;
        log(deps, 'info', '会话事件观测已订阅（决策模型路由依赖此映射解析用户）');
        // 钉钉桥可能晚于插件启动，延迟再刷一次兜底
        setTimeout(() => { void refreshBridge(); }, 2_000);
      } catch (error) {
        log(deps, 'warn', `订阅会话事件失败：${(error as Error)?.message ?? error}`);
        attached = null;
      }
    },
    stop() {
      if (!attached) return;
      if (typeof off === 'function') {
        try { off(); } catch { /* ignore */ }
      } else if (typeof ctx?.off === 'function') {
        try { ctx.off('session/event', attached); } catch { /* ignore */ }
      }
      attached = null;
      off = null;
    },
    status() {
      const cfg = deps.getConfig().route?.imRoute;
      return {
        subscribed: attached !== null,
        enabled: Boolean(cfg?.enabled),
        decisionProviderId: cfg?.decisionProviderId ?? '',
        decisionProviderIds: effectiveDecisionProviderIds(cfg),
        mappedCount,
        mappedSessions: senderBySession.size,
        bridgeSessions: bridgeSessions.size,
        last: { ...last, at: last.at ? new Date(last.at).toISOString() : null },
      };
    },
    /**
     * 由 adapter 从请求正文的 `<dsh_im_source>` 块回填映射：
     * 会话事件被宿主剥掉 senderId（或事件形状变化）时，请求体里的发送者块仍可用，
     * 回填后同一会话后续消息直接命中映射，不必每条都解析正文。
     */
    rememberSender(sessionId: string, sender: { senderId: string; senderName: string }) {
      if (!sessionId || !sender || !sender.senderId) return;
      if (!senderBySession.has(sessionId) && senderBySession.size >= 20_000) {
        const oldest = senderBySession.keys().next().value;
        if (typeof oldest === 'string') senderBySession.delete(oldest);
      }
      senderBySession.set(sessionId, {
        senderId: sender.senderId,
        senderName: sender.senderName || sender.senderId,
        at: Date.now(),
      });
      log(deps, 'info', `会话映射（请求正文回填）：${sessionId} -> ${sender.senderId}`);
    },
    resolveSender(sessionId: string) {
      if (!sessionId) return null;
      const hit = senderBySession.get(sessionId);
      if (hit) return { senderId: hit.senderId, senderName: hit.senderName };
      // 事件观测 miss：查 dingtalk 桥映射（sessionId -> senderId），并触发后台刷新
      const bridgeId = bridgeSessions.get(sessionId);
      if (bridgeId) {
        const name = bridgeNameOf(bridgeId);
        return { senderId: bridgeId, senderName: name || bridgeId };
      }
      // 会话 id 可能被宿主派生（如带前缀 / 简写），做最宽松的包含匹配兜底
      for (const [key, value] of senderBySession) {
        if (key.includes(sessionId) || sessionId.includes(key)) {
          return { senderId: value.senderId, senderName: value.senderName };
        }
      }
      for (const [key, bridgeId] of bridgeSessions) {
        if (key.includes(sessionId) || sessionId.includes(key)) {
          const name = bridgeNameOf(bridgeId);
          return { senderId: bridgeId, senderName: name || bridgeId };
        }
      }
      void refreshBridge();
      return null;
    },
  };
}

/**
 * 清理路由决策日志（route-decision.log）：删除超过 maxAgeDays 天的 JSON 行（按每行 ts 判断）。
 * 坏行 / 无 ts 的行保留不误删；文件不存在或读写失败静默返回 0（清理失败绝不影响路由主链路）。
 * 返回删除的行数。
 */
export function pruneRouteLogFile(logPath: string, maxAgeDays: number, now: number = Date.now()): number {
  if (!logPath || !(maxAgeDays > 0)) return 0;
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return 0;
  }
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const lines = text.split('\n');
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    if (!line.trim()) {
      kept.push(line);
      continue;
    }
    let ts = 0;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { ts?: unknown }).ts === 'string') {
        ts = new Date((parsed as { ts: string }).ts).getTime();
      }
    } catch {
      /* 坏行保留，不误删 */
    }
    if (ts && ts < cutoff) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return 0;
  try {
    writeFileSync(logPath, kept.join('\n'), 'utf8');
  } catch {
    return 0;
  }
  return removed;
}

/** 清理按天路由决策日志：删除 baseDir 下「文件名日期早于 maxAgeDays 天」的 route-decision-YYYY-MM-DD.log。
 *  文件不存在 / 读取失败 / 无匹配文件均静默返回 0；返回删除的文件数。 */
export function pruneRouteLogDir(baseDir: string, maxAgeDays: number, now: number = Date.now()): number {
  if (!baseDir || !(maxAgeDays > 0)) return 0;
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const nameRe = /^route-decision-(\d{4})-(\d{2})-(\d{2})\.log$/;
  let names: string[] = [];
  try {
    names = readdirSync(baseDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const m = nameRe.exec(name);
    if (!m) continue;
    const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (!Number.isFinite(fileDate) || fileDate >= cutoff) continue;
    try {
      unlinkSync(join(baseDir, name));
      removed += 1;
    } catch { /* 删除失败静默跳过，不影响其它文件 */ }
  }
  return removed;
}
