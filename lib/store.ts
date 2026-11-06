import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { mrrpConfigPathFor } from './profile.js';

/**
 * MRRP 控制台的数据契约与持久化存储。
 * 模型路由管理（Model Routing & Resource Planning）：
 *   - 模型分类：把 DSH 已发现的模型按用途归类（如深度推理 / 代码辅助 / 快速响应…）；
 *   - 路由模型配置：路由策略 / 负载均衡 / 超时 / 兜底；
 *   - 角色与部门：把角色 / 部门绑定到某个模型分类，实现按请求来源路由；
 *   - 用户：管理用户与角色 / 部门的从属关系。
 * 全部类型以 TypeScript 声明，host 与 client 共用同一份数据契约。
 */

/** 模型分类。 */
export interface Category {
  id: string;
  /** 分类名称 */
  name: string;
  /** 用途说明 */
  desc: string;
  /** 绑定到该分类的模型标识（provider:id）列表 */
  modelIds: string[];
  /** 是否默认分类（新建模型 / 未归类请求的落点） */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 路由策略。 */
export type RouteStrategy = 'category' | 'round-robin' | 'least-loaded' | 'random';
/** 兜底策略（分类内无可用模型时）。 */
export type FallbackStrategy = 'random' | 'keep' | 'none';

/** IM 消息路由判定规则：决策模型输出的字段值 -> 模型分类。 */
export interface ImRouteRule {
  /** 决策输出字段名（对应 imRoute.questions 里的问题名，如 department / urgency） */
  field: string;
  /** 字段值（choice 选项 key / score 档位 / noul 判定结果；空 = 该字段任意值命中） */
  value: string;
  /** 命中的模型分类 id */
  categoryId: string;
}

/** 判定问题定义（与 laya_decide 的 questions 格式一致，供决策模型判定任务用）。 */
export interface ImRouteQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria?: unknown;
}

/** 决策模型并发调度配置（多 API / 同 API 多模型合成一个池）。 */
export interface DecisionPoolConfig {
  /** 启用并发调度（关闭后回到「按提供方轮询 + 故障转移」的旧行为） */
  enabled: boolean;
  /** 每个模型默认并发上限 */
  defaultLimit: number;
  /** 全部满额时的排队等待上限（毫秒，0 = 不排队直接落兜底） */
  queueTimeoutMs: number;
  /** 同一会话优先复用上次成功的模型，避免判定口径来回跳 */
  sticky: boolean;
  /** 主用提供方 id（只作优先级，不强制独占） */
  primaryProviderId: string;
  /** 主用模型名（与 primaryProviderId 一起定位主用槽） */
  primaryModel: string;
  /** 每个槽的并发上限覆盖：key = providerId::model */
  limits: Record<string, number>;
  /** 每个槽的权重覆盖（1-5，越大越能多吃并发） */
  weights: Record<string, number>;
}

/** IM 消息路由配置（「路由配置」页新增卡片）：启用后 dsh-im 钉钉消息按用户路由模型。 */
export interface ImRouteConfig {
  /** 启用 IM 消息路由（订阅 DSH 会话事件，按消息发送者路由会话模型） */
  enabled: boolean;
  /** 任务判定用的决策模型提供方 id（decisionProviders 之一；支持 laya 与 OpenAI 兼容判定型服务） */
  decisionProviderId: string;
  /** 决策模型提供方有序列表（负载均衡轮询 + 故障转移按序换用；空时回退 [decisionProviderId]） */
  decisionProviderIds: string[];
  /** 决策模型并发调度：把选中的提供方及其模型展开成池，按最少在途分流 */
  decisionPool: DecisionPoolConfig;
  /** 判定问题定义（决策模型 questions，多字段） */
  questions: Record<string, ImRouteQuestion>;
  /** 判定规则：决策输出字段值 -> 模型分类（多字段判定 + 映射表） */
  rules: ImRouteRule[];
  /** 兜底模型（provider:id；用户/分类均无可用模型时使用） */
  fallbackModel: string;
  /** 未注册用户策略：ignore = 不路由；fallback = 使用兜底模型 */
  unknownUser: 'ignore' | 'fallback';
  /** 允许的 dsh-im 渠道（默认 ['dingtalk']；空 = 全部渠道） */
  channels: string[];
}

/** 路由模型配置。 */
export interface RouteConfig {
  /** 路由开关 */
  active: boolean;
  /** 路由策略 */
  strategy: RouteStrategy;
  /** 负载均衡算法 */
  lb: 'round-robin' | 'weighted' | 'least-loaded';
  /** 按模型分配权重（模型标识 -> 权重 1-10） */
  weights: Record<string, number>;
  /** 兜底策略 */
  fallback: FallbackStrategy;
  /** 请求超时（毫秒） */
  timeoutMs: number;
  /** 失败重试次数 */
  retries: number;
  /** 单点故障时是否自动切换同分类其它模型 */
  failover: boolean;
  /** IM 消息路由配置（dsh-im 会话模型路由） */
  imRoute: ImRouteConfig;
}

/** 角色绑定的分类及其可用的模型（模型来源于模型列表的模型标识 provider:id）。 */
export interface CategoryBinding {
  categoryId: string;
  modelIds: string[];
}

/** 角色。 */
export interface Role {
  id: string;
  name: string;
  /** 绑定到的部门 id 列表（多对多，与部门表的 roleIds 双向同步；空 = 全局生效） */
  deptIds: string[];
  /** 绑定到的模型分类及每个分类可用的模型（多选分类） */
  categoryBindings: CategoryBinding[];
  desc: string;
}

/** 部门。 */
export interface Dept {
  id: string;
  name: string;
  parentId: string;
  /** 绑定到的角色 id 列表（多对多，与角色表的 deptIds 双向同步） */
  roleIds: string[];
}

/** 用户。 */
export interface User {
  /** 唯一标识 = dsh-im 对话中的 senderId（如钉钉 staffId / openId）；旧数据 usr_xxx 保留 */
  id: string;
  /** 姓名（可由 dsh-im 的 sender_name 自动带出） */
  name: string;
  /** 单独绑定的角色 id；空 = 使用所属部门绑定的角色 */
  roleId: string;
  /** 归属的部门 id 列表（用户可归属于多个部门） */
  deptIds: string[];
  /** 备注 */
  note: string;
}

/** 侧边栏入口显隐配置。 */
export interface SidebarConfig {
  mode: 'auto' | 'show' | 'hide';
}

/** 决策模型提供方接口格式。 */
export type DecisionFormat = 'laya' | 'openai' | 'generic';

/** Laya 调用端点：systemone = 本地 laya-server（POST /v1/systemone）；decisions = 0G 云端（POST /v1/decisions，自动带 model: laya）。 */
/** 决策调用端点：systemone/decisions 为判定协议（云端判定型服务），chat 为 OpenAI 兼容对话判定（普通大模型当判定器）。 */
export type LayaEndpoint = 'systemone' | 'decisions' | 'chat';

/** 决策模型提供方（laya-server 本地部署 / 0G 云端 / OpenAI 兼容 / 通用 API）。 */
export interface DecisionProvider {
  id: string;
  /** 显示名 */
  name: string;
  /** 接口格式 */
  format: DecisionFormat;
  /** 决策调用端点：systemone/decisions=判定协议（laya 本地 / 0G 云端 / 云端判定型服务）；chat=OpenAI 兼容对话判定（普通大模型当判定器） */
  endpoint: LayaEndpoint;
  /** API 基地址，如 http://127.0.0.1:8000（本地）或 https://router-api.0g.ai（云端） */
  baseUrl: string;
  /** API 密钥（选填；服务端未鉴权时留空） */
  apiKey: string;
  /** 模型名列表（laya 手动维护，openai / generic 拉取后保存） */
  modelNames: string[];
  /** 绑定到的模型分类 id（复用「模型分类配置」的分类体系，空 = 未绑定） */
  categoryId: string;
  /** 是否启用 */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 插件全局配置。 */
export interface PluginConfig {
  version: number;
  route: RouteConfig;
  categories: Category[];
  roles: Role[];
  depts: Dept[];
  users: User[];
  sidebar: SidebarConfig;
  decisionProviders: DecisionProvider[];
  /** 自动添加用户的默认绑定（userDefaults.roleId：新同步用户自动赋的角色） */
  userDefaults: UserDefaultsConfig;
  /** 模型手动画像（key=provider:model -> 类型/擅长场景），覆盖分类画像，供 Laya 模型路由决策使用 */
  modelProfiles: Record<string, ModelProfile>;
  /** 类型/场景列表（模型列表「类型/擅长场景」下拉框的选项来源；可增删） */
  typeSceneList: string[];
  /** 路由决策日志自动清理保留天数（1~365，默认 30） */
  logRetentionDays: number;
  /** 路由决策日志存放目录（绝对路径）；空串表示默认「与 config.json 同目录」 */
  logDir: string;
  /** GitHub 仓库路径（owner/repo），版本检查用；缺省使用插件默认仓库（Jydsh/dsh-mrrp） */
  updateRepo?: string;
}

/** 自动添加用户默认值：新用户从 dsh-im 同步 / 自动创建时赋的默认角色。 */
export interface UserDefaultsConfig {
  roleId: string;
}

/** 模型画像：类型（可多选）+ 擅长场景（控制台「模型」页手动维护，覆盖分类画像）。 */
export interface ModelProfile {
  /** 擅长类型（多选，0~5 个）；空数组表示仅配了场景 */
  type: string[];
  scene: string;
}

const MAX_STR = 200;
const MAX_DESC = 500;

/** 默认类型/场景列表（模型列表「类型/擅长场景」下拉框初始选项；可在「类型/场景」页增删）。 */
export const DEFAULT_TYPE_SCENES: ReadonlyArray<string> = ['推理', '对话', '代码', '视觉', '长文本', '多模态', '工具调用', '快速', '其他'];

/** 清洗类型/场景列表：字符串数组、trim、去重、上限 50；非法或空则回退默认列表。 */
export function sanitizeTypeSceneList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out = cleanStringArray(value, 50);
    if (out.length) return out;
  }
  return DEFAULT_TYPE_SCENES.slice();
}

export const DEFAULT_CATEGORIES: ReadonlyArray<Readonly<Omit<Category, 'id' | 'createdAt' | 'updatedAt'>>> = [
  { name: '深度推理', desc: '复杂推理 / 长链思考任务，如代码设计、逻辑分析、多步规划。', modelIds: [], isDefault: true },
  { name: '代码辅助', desc: '代码编写 / 解释 / 重构 / 调试，面向工程开发场景。', modelIds: [], isDefault: false },
  { name: '视觉理解', desc: '图片 / 文档视觉理解与多模态任务。', modelIds: [], isDefault: false },
  { name: '快速响应', desc: '低延迟问答 / 对话 / 轻量任务，追求速度。', modelIds: [], isDefault: false },
  { name: '重载任务', desc: '批量 / 长文本 / 高吞吐任务，适合大上下文模型。', modelIds: [], isDefault: false },
];

export const DEFAULT_CONFIG: Readonly<PluginConfig> = Object.freeze({
  version: 1,
  route: Object.freeze({
    active: true,
    strategy: 'category',
    lb: 'round-robin',
    weights: Object.freeze({}),
    fallback: 'random',
    timeoutMs: 60_000,
    retries: 0,
    failover: true,
    imRoute: Object.freeze({
      enabled: false,
      decisionProviderId: '',
      decisionProviderIds: Object.freeze([]),
      decisionPool: Object.freeze({
        enabled: true,
        defaultLimit: 1,
        queueTimeoutMs: 8_000,
        sticky: true,
        primaryProviderId: '',
        primaryModel: '',
        limits: Object.freeze({}),
        weights: Object.freeze({}),
      }),
      questions: Object.freeze({}),
      rules: Object.freeze([]),
      fallbackModel: '',
      unknownUser: 'ignore',
      channels: Object.freeze(['dingtalk']),
    }),
  }),
  categories: [],
  roles: [],
  depts: [],
  users: [],
  sidebar: { mode: 'auto' },
  decisionProviders: [],
  userDefaults: { roleId: '' },
  modelProfiles: {},
  typeSceneList: DEFAULT_TYPE_SCENES.slice(),
  logRetentionDays: 30,
  logDir: '',
}) as unknown as Readonly<PluginConfig>;

/**
 * 日志目录清洗：空串 = 默认（与 config.json 同目录）。
 * 只接受绝对路径（Windows 盘符 / UNC / POSIX 绝对路径），超长或含空字节的一律回退默认。
 * 尾部多余分隔符去掉，盘符根（C:\、/）原样保留。
 */
export function sanitizeLogDir(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 512 || text.includes('\0')) return '';
  if (!isAbsolute(text)) return '';
  const normalized = normalize(text);
  if (/^[A-Za-z]:[\\/]$/.test(normalized) || normalized === '/') return normalized;
  const stripped = normalized.replace(/[\\/]+$/, '');
  return stripped || normalized;
}

/** 当前生效的日志目录：配置了合法绝对目录就用它，否则回退 config.json 所在目录。 */
export function resolveRouteLogDir(configPath: string, custom: unknown): string {
  return sanitizeLogDir(custom) || dirname(configPath);
}

/** 校验日志目录可用：不存在则递归创建，并写一个探针文件确认真的可写。
 *  返回失败原因（空串 = 可用）。目录不可写时必须先拦住，否则日志会静默写不进去。 */
export function probeLogDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.mrrp-write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
    return '';
  } catch (error) {
    return (error as Error)?.message ?? String(error);
  }
}

function cleanString(value: unknown, fallback: string, max = MAX_STR): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text && text.length <= max ? text : fallback;
}

function cleanBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 整数清洗：数值取整并 clamp 到 [min, max]，非法回退 fallback。 */
function cleanInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function cleanId(value: unknown, prefix: string): string {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)) return value;
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** 用户唯一标识清洗：保留任意非空 senderId（trim 后 ≤128，如钉钉 staffId / openId）；空则生成内部 usr_xxx。 */
function sanitizeUserId(value: unknown): string {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text && text.length <= 128) return text;
  }
  return `usr_${randomUUID().slice(0, 8)}`;
}

function cleanStringArray(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || text.length > 128 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function cleanWeights(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || key.length > 128) continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    const weight = Math.min(10, Math.max(1, Math.round(num)));
    out[key] = weight;
  }
  return out;
}

export function sanitizeCategory(input: unknown): Category {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  return {
    id: cleanId(source.id, 'cat'),
    name: cleanString(source.name, '未命名分类', 60),
    desc: cleanString(source.desc, '', MAX_DESC),
    modelIds: cleanStringArray(source.modelIds),
    isDefault: cleanBool(source.isDefault, false),
    createdAt: cleanString(source.createdAt, new Date().toISOString(), 40),
    updatedAt: cleanString(source.updatedAt, new Date().toISOString(), 40),
  };
}

/** 清洗 IM 消息路由判定问题定义（questions）。 */
function sanitizeImRouteQuestions(input: unknown): Record<string, ImRouteQuestion> {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const out: Record<string, ImRouteQuestion> = {};
  for (const [name, raw] of Object.entries(source)) {
    const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
    const type = ['choice', 'score', 'noul'].includes(rec.type) ? rec.type : 'noul';
    const instructions = cleanString(rec.instructions, '', 500);
    if (!name || name.length > 60) continue;
    out[name] = {
      type,
      instructions,
      ...(rec.criteria !== undefined ? { criteria: rec.criteria } : {}),
    };
    if (Object.keys(out).length >= 30) break;
  }
  return out;
}

/** 清洗 IM 消息路由判定规则（rules）。 */
function sanitizeImRouteRules(input: unknown): ImRouteRule[] {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const out: ImRouteRule[] = [];
  const seen = new Set<string>();
  if (Array.isArray(source.rules)) {
    for (const item of source.rules.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, any>;
      const field = cleanString(rec.field, '', 60);
      const categoryId = cleanString(rec.categoryId, '', 40);
      if (!field || !categoryId) continue;
      const key = `${field}\u0000${categoryId}\u0000${cleanString(rec.value, '', 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ field, value: cleanString(rec.value, '', 60), categoryId });
    }
  }
  return out;
}

/** 清洗「键 -> 整数」映射（并发上限 / 权重共用）。 */
function cleanNumberMap(value: unknown, min: number, max: number, limit = 64): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawKey !== 'string') continue;
    const key = rawKey.trim();
    const n = Math.round(Number(rawValue));
    if (!key || key.length > 160 || !Number.isFinite(n)) continue;
    out[key] = Math.min(max, Math.max(min, n));
    count += 1;
    if (count >= limit) break;
  }
  return out;
}

/** 清洗决策模型并发调度配置。 */
export function sanitizeDecisionPool(input: unknown): DecisionPoolConfig {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const fallback: DecisionPoolConfig = DEFAULT_CONFIG.route.imRoute.decisionPool;
  return {
    enabled: cleanBool(source.enabled, fallback.enabled),
    defaultLimit: Number.isSafeInteger(source.defaultLimit)
      ? Math.min(32, Math.max(1, source.defaultLimit))
      : fallback.defaultLimit,
    queueTimeoutMs: Number.isFinite(Number(source.queueTimeoutMs))
      ? Math.min(60_000, Math.max(0, Math.round(Number(source.queueTimeoutMs))))
      : fallback.queueTimeoutMs,
    sticky: cleanBool(source.sticky, fallback.sticky),
    primaryProviderId: cleanString(source.primaryProviderId, '', 40),
    primaryModel: cleanString(source.primaryModel, '', 128),
    limits: cleanNumberMap(source.limits, 1, 32),
    weights: cleanNumberMap(source.weights, 1, 5),
  };
}

/** 清洗 IM 消息路由配置。 */
export function sanitizeImRoute(input: unknown): ImRouteConfig {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const fallback: ImRouteConfig = DEFAULT_CONFIG.route.imRoute;
  const channels = cleanStringArray(source.channels);
  return {
    enabled: cleanBool(source.enabled, fallback.enabled),
    decisionProviderId: cleanString(source.decisionProviderId, '', 40),
    decisionProviderIds: cleanStringArray(source.decisionProviderIds).slice(0, 8),
    decisionPool: sanitizeDecisionPool(source.decisionPool),
    questions: sanitizeImRouteQuestions(source.questions),
    rules: sanitizeImRouteRules(source),
    fallbackModel: cleanString(source.fallbackModel, '', 128),
    unknownUser: source.unknownUser === 'fallback' ? 'fallback' : 'ignore',
    channels: channels.length ? channels.slice(0, 8) : ['dingtalk'],
  };
}

export function sanitizeRoute(input: unknown): RouteConfig {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const fallback: RouteConfig = DEFAULT_CONFIG.route;
  return {
    active: cleanBool(source.active, fallback.active),
    strategy: ['category', 'round-robin', 'least-loaded', 'random'].includes(source.strategy)
      ? source.strategy : fallback.strategy,
    lb: ['round-robin', 'weighted', 'least-loaded'].includes(source.lb) ? source.lb : fallback.lb,
    weights: cleanWeights(source.weights),
    fallback: ['random', 'keep', 'none'].includes(source.fallback) ? source.fallback : fallback.fallback,
    timeoutMs: Number.isFinite(Number(source.timeoutMs))
      ? Math.min(300_000, Math.max(5_000, Math.round(Number(source.timeoutMs))))
      : fallback.timeoutMs,
    retries: Number.isSafeInteger(source.retries)
      ? Math.min(10, Math.max(0, source.retries))
      : fallback.retries,
    failover: cleanBool(source.failover, fallback.failover),
    imRoute: sanitizeImRoute(source.imRoute),
  };
}

/** 清洗角色分类绑定（categoryBindings），旧版单分类字段 categoryId 自动迁移。 */
export function sanitizeCategoryBindings(input: unknown): CategoryBinding[] {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const out: CategoryBinding[] = [];
  const seen = new Set<string>();
  if (Array.isArray(source.categoryBindings)) {
    for (const item of source.categoryBindings.slice(0, 50)) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, any>;
      const categoryId = cleanString(rec.categoryId, '', 40);
      if (!categoryId || seen.has(categoryId)) continue;
      seen.add(categoryId);
      out.push({ categoryId, modelIds: cleanStringArray(rec.modelIds) });
    }
  } else if (source.categoryId) {
    const categoryId = cleanString(source.categoryId, '', 40);
    if (categoryId) out.push({ categoryId, modelIds: [] });
  }
  return out;
}

export function sanitizeRole(input: unknown): Role {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  return {
    id: cleanId(source.id, 'role'),
    name: cleanString(source.name, '未命名角色', 60),
    deptIds: cleanStringArray(source.deptIds),
    categoryBindings: sanitizeCategoryBindings(source),
    desc: cleanString(source.desc, '', MAX_DESC),
  };
}

export function sanitizeDept(input: unknown): Dept {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  return {
    id: cleanId(source.id, 'dept'),
    name: cleanString(source.name, '未命名部门', 60),
    parentId: cleanString(source.parentId, '', 40),
    roleIds: cleanStringArray(source.roleIds),
  };
}

export function sanitizeUser(input: unknown): User {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  let deptIds = cleanStringArray(source.deptIds);
  // 旧版单部门字段 deptId 自动迁移为多部门
  if (deptIds.length === 0 && source.deptId) {
    const legacy = cleanString(source.deptId, '', 40);
    if (legacy) deptIds = [legacy];
  }
  return {
    id: sanitizeUserId(source.id),
    name: cleanString(source.name, '未命名用户', 60),
    roleId: cleanString(source.roleId, '', 40),
    deptIds,
    note: cleanString(source.note, '', MAX_DESC),
  };
}

export function sanitizeDecisionProvider(input: unknown): DecisionProvider {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const format = ['laya', 'openai', 'generic'].includes(source.format) ? source.format : 'laya';
  // 端点：laya 默认判定协议 systemone；openai/generic 无判定端点时默认走 OpenAI 兼容对话判定（chat）
  const validEndpoints = ['systemone', 'decisions', 'chat'];
  const endpoint = validEndpoints.includes(source.endpoint)
    ? source.endpoint
    : (format === 'laya' ? 'systemone' : 'chat');
  return {
    id: cleanId(source.id, 'dp'),
    name: cleanString(source.name, '未命名提供方', 60),
    format,
    endpoint,
    baseUrl: cleanString(source.baseUrl, '', 200),
    apiKey: cleanString(source.apiKey, '', 200),
    modelNames: cleanStringArray(source.modelNames),
    categoryId: cleanString(source.categoryId, '', 40),
    enabled: cleanBool(source.enabled, true),
    createdAt: cleanString(source.createdAt, new Date().toISOString(), 40),
    updatedAt: cleanString(source.updatedAt, new Date().toISOString(), 40),
  };
}

export function sanitizeConfig(input: unknown): PluginConfig {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const categories = Array.isArray(source.categories)
    ? source.categories.slice(0, 100).map(sanitizeCategory) : [];
  // 至少保留一个默认分类，避免「没有默认分类」的空洞状态。
  if (!categories.some((category) => category.isDefault)) {
    const base = DEFAULT_CATEGORIES[0];
    categories.unshift(sanitizeCategory({
      id: 'cat_default',
      name: base.name,
      desc: base.desc,
      modelIds: [],
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }
  return {
    version: 1,
    route: sanitizeRoute(source.route),
    categories,
    roles: Array.isArray(source.roles) ? source.roles.slice(0, 200).map(sanitizeRole) : [],
    depts: Array.isArray(source.depts) ? source.depts.slice(0, 300).map(sanitizeDept) : [],
    users: Array.isArray(source.users) ? source.users.slice(0, 1000).map(sanitizeUser) : [],
    sidebar: {
      mode: source.sidebar?.mode === 'show' || source.sidebar?.mode === 'hide' ? source.sidebar.mode : 'auto',
    },
    decisionProviders: Array.isArray(source.decisionProviders)
      ? source.decisionProviders.slice(0, 50).map(sanitizeDecisionProvider) : [],
    userDefaults: {
      roleId: cleanString(source.userDefaults?.roleId, '', 40),
    },
    modelProfiles: sanitizeModelProfiles(source.modelProfiles),
    typeSceneList: sanitizeTypeSceneList(source.typeSceneList),
    logRetentionDays: cleanInt(source.logRetentionDays, 30, 1, 365),
    logDir: sanitizeLogDir(source.logDir),
  };
}

/** 清洗模型画像表（key=provider:model，type/scene 任一非空才保留；上限 200 条）。
 *  兼容旧数据：type 为字符串时归一化为单元素数组；重复项去重、上限 5 个。 */
function sanitizeModelProfiles(value: unknown): Record<string, ModelProfile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ModelProfile> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || key.length > 256 || out[key] || Object.keys(out).length >= 200) continue;
    const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
    const rawTypes = Array.isArray(rec.type)
      ? rec.type
      : (typeof rec.type === 'string' && rec.type.trim() ? [rec.type] : []);
    const type = Array.from(new Set(rawTypes
      .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t: string) => t.trim().slice(0, 20)))).slice(0, 5);
    const scene = typeof rec.scene === 'string' ? rec.scene.trim().slice(0, 200) : '';
    if (type.length || scene) out[key] = { type, scene };
  }
  return out;
}

/** 解析自动添加用户的默认角色：配置了且角色仍存在时返回 roleId，否则空串（不赋）。 */
export function defaultRoleIdFor(config: PluginConfig): string {
  const roleId = config.userDefaults?.roleId ?? '';
  if (!roleId) return '';
  return config.roles.some((role) => role.id === roleId) ? roleId : '';
}

/** 配置文件路径：按当前 profile 隔离；profile 认定不出时回退旧的共享位置（不丢配置）。 */
export function configPath(): string {
  return mrrpConfigPathFor();
}

export class MrrpConfigStore {
  #path: string;
  #config: PluginConfig = sanitizeConfig(DEFAULT_CONFIG);
  #loaded = false;
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string = configPath()) {
    this.#path = resolve(path);
  }

  get path(): string {
    return this.#path;
  }

  get(): PluginConfig {
    return structuredClone(this.#config);
  }

  async load(): Promise<PluginConfig> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      this.#config = sanitizeConfig(JSON.parse(raw.replace(/^\uFEFF/, '')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      this.#config = sanitizeConfig(DEFAULT_CONFIG);
    }
    this.#loaded = true;
    return this.get();
  }

  async save(input: unknown): Promise<PluginConfig> {
    this.#config = sanitizeConfig(input);
    this.#loaded = true;
    const payload = `${JSON.stringify(this.#config, null, 2)}\n`;
    const path = this.#path;
    this.#writing = this.#writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      await writeFile(temp, payload, 'utf8');
      await rename(temp, path);
    });
    await this.#writing;
    return this.get();
  }

  async patch(partial: unknown): Promise<PluginConfig> {
    return this.save(mergeConfig(this.get(), partial));
  }

  get loaded(): boolean {
    return this.#loaded;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base: PluginConfig, partial: unknown): PluginConfig {
  if (!isRecord(partial)) return base;
  return {
    ...base,
    route: isRecord(partial.route) ? sanitizeRoute({ ...base.route, ...partial.route }) : base.route,
    categories: Array.isArray(partial.categories) ? partial.categories : base.categories,
    roles: Array.isArray(partial.roles) ? partial.roles : base.roles,
    depts: Array.isArray(partial.depts) ? partial.depts : base.depts,
    users: Array.isArray(partial.users) ? partial.users : base.users,
    sidebar: isRecord(partial.sidebar)
      ? { mode: partial.sidebar.mode === 'show' || partial.sidebar.mode === 'hide' ? partial.sidebar.mode : 'auto' }
      : base.sidebar,
    decisionProviders: Array.isArray(partial.decisionProviders) ? partial.decisionProviders : base.decisionProviders,
  };
}
