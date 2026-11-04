import type { CategoryBinding, ImRouteConfig, ImRouteQuestion, PluginConfig } from './store.js';
import { makeLayaDecide } from './decision.js';
import { readFileSync, writeFileSync } from 'node:fs';

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
  /** 决策执行器（测试可注入；缺省按 decisionProviderId 走 laya 提供方） */
  decide?: (state: string, questions: Record<string, ImRouteQuestion>) => Promise<unknown>;
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
}

export interface ImRoutingHandle {
  start(): void;
  stop(): void;
  /** 运行状态（供 route.im.status RPC 调试用） */
  status(): Record<string, unknown>;
  /** 会话 → 发送者映射查询（adapter 用；查不到返回 null） */
  resolveSender(sessionId: string): { senderId: string; senderName: string } | null;
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
 *   <dsh_im_source>
 *     ... senderId: 具体用户ID ...
 *   </dsh_im_source>
 *   （用户实际消息内容）
 * 解析块内 senderId / senderName，返回 { senderId, senderName, rest }（rest=去掉前缀块后的正文）。
 */
function extractSenderFromContent(content: string): { senderId: string; senderName: string; rest: string } {
  const m = /<dsh_im_source>([\s\S]*?)<\/dsh_im_source>/.exec(content);
  if (!m) return { senderId: '', senderName: '', rest: content };
  const block = m[1];
  const id = /senderId\s*[:：]\s*([^\s,，;；"'`}\]]+)/.exec(block)?.[1]?.trim() ?? '';
  const name = /senderName\s*[:：]\s*([^\r\n]+)/.exec(block)?.[1]?.trim() ?? '';
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

/**
 * 目标模型决策（纯逻辑，无副作用；导出供测试）。
 *
 * 顺序：未注册用户（unknownUser）→ 用户可用模型池（角色 + 部门，去重）→
 *   池空用兜底；池唯一直接用；池多个用内置判定问题请决策模型（laya）选择 →
 *   决策失败 / 未命中用兜底。
 */
export async function resolveTargetModel(
  deps: ImRoutingDeps,
  cfg: ImRouteConfig,
  senderId: string,
  text: string,
): Promise<TargetModelOutcome | null> {
  const config = deps.getConfig();

  // 1. 未注册用户
  const user = config.users.find((item) => item.id === senderId);
  if (!user) {
    if (cfg.unknownUser !== 'fallback' || !cfg.fallbackModel) return null;
    return { model: cfg.fallbackModel, source: 'unknown-fallback', candidates: [], sources: { direct: [], inherited: [] } };
  }

  // 2. 用户可用模型池（方案 B：直接角色在前 = 显式授权最高；部门继承并集补充）
  const { direct, inherited } = collectUserModelsPrioritized(config, user);
  const candidates = [...direct, ...inherited];
  const sources = { direct, inherited };
  if (candidates.length === 0) {
    if (cfg.fallbackModel) return { model: cfg.fallbackModel, source: 'fallback', candidates, sources };
    return null;
  }
  if (candidates.length === 1) {
    return { model: candidates[0], source: 'user', candidates, sources };
  }

  // 3. 多个候选：内置判定问题请决策模型选择
  if (!cfg.decisionProviderId) {
    if (cfg.fallbackModel) return { model: cfg.fallbackModel, source: 'fallback', candidates, sources };
    return null;
  }
  const question = builtinModelChoiceQuestion(candidates.map((key) => {
    const parsed = parseModelKey(key);
    // 模型画像：优先用控制台手动维护的 modelProfiles（type 多选数组），未配置则取模型所在分类的「名称 + 描述」
    const profile = config.modelProfiles?.[key];
    const hits = config.categories.filter((category) => category.modelIds.includes(key));
    const profileTypes = Array.isArray(profile?.type)
      ? (profile.type as string[]).filter(Boolean)
      : (typeof profile?.type === 'string' && (profile.type as string).trim() ? [(profile.type as string).trim()] : []);
    const type = profileTypes.length ? profileTypes.join('、') : hits.map((category) => category.name).join('、') || undefined;
    const scene = profile?.scene || hits.map((category) => category.desc).filter(Boolean).join('；') || undefined;
    return { key, name: parsed ? parsed.model : key, type, scene };
  }), `发送者：${user.name || senderId}；候选授权来源：用户直接角色 ${direct.length} 个模型 / 部门继承 ${inherited.length} 个模型。`);
  // 生成路径的候选选择用短超时（6s）：决策慢 / 不可达时快速落兜底，避免用户干等
  const DECISION_TIMEOUT_MS = 6000;
  const questions = { model: question };
  const state = text || senderId;
  let data: unknown = null;
  if (typeof deps.decide === 'function') {
    try {
      deps.onDecide?.('before', { providerId: cfg.decisionProviderId, state, questions, timeoutMs: DECISION_TIMEOUT_MS });
      data = await deps.decide(state, questions);
      deps.onDecide?.('after', { providerId: cfg.decisionProviderId, raw: data });
    } catch (error) {
      deps.onDecide?.('error', { providerId: cfg.decisionProviderId, message: (error as Error)?.message ?? String(error) });
      log(deps, 'warn', `决策模型选择失败：${(error as Error)?.message ?? error}`);
    }
  } else {
    const provider = config.decisionProviders.find((item) => item.id === cfg.decisionProviderId);
    if (provider && provider.format === 'laya' && provider.baseUrl) {
      try {
        deps.onDecide?.('before', {
          providerId: provider.id,
          provider: { baseUrl: provider.baseUrl, endpoint: provider.endpoint, format: provider.format },
          state,
          questions,
          timeoutMs: DECISION_TIMEOUT_MS,
        });
        const run = makeLayaDecide(() => ({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey || '',
          endpoint: provider.endpoint,
        }), DECISION_TIMEOUT_MS);
        data = await run({ state, questions });
        deps.onDecide?.('after', { providerId: provider.id, raw: data });
      } catch (error) {
        deps.onDecide?.('error', { providerId: provider.id, message: (error as Error)?.message ?? String(error) });
        log(deps, 'warn', `决策模型选择失败：${(error as Error)?.message ?? error}`);
      }
    } else {
      deps.onDecide?.('error', { providerId: cfg.decisionProviderId, message: '未找到启用的 laya 决策提供方（format=laya 且 baseUrl 非空）' });
      log(deps, 'warn', '请选择一个启用的 Laya 决策模型提供方用于候选模型选择。');
    }
  }
  if (data !== null) {
    const decision = extractDecisionValues(data);
    // 内置判定问题是 choice 类型，答案在 choice 字段；model 字段可能是 Laya 响应的
    // 服务/路由元数据（如 laya-rl-agent / multilingual），不能直接当作判定值。
    // 按「在候选池中匹配」优先取 choice，避免被元数据污染导致决策成功却误判失败。
    const picked = [decision.choice, decision.model].find((v) => v && candidates.includes(v)) ?? '';
    if (picked) {
      return { model: picked, source: 'laya', candidates, sources, decision, reasoning: extractReasoning(data) };
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
        mappedCount,
        mappedSessions: senderBySession.size,
        bridgeSessions: bridgeSessions.size,
        last: { ...last, at: last.at ? new Date(last.at).toISOString() : null },
      };
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
