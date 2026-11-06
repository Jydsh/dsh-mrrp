import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mrrpConfigPathFor } from './profile.js';
const MAX_STR = 200;
const MAX_DESC = 500;
/** 默认类型/场景列表（模型列表「类型/擅长场景」下拉框初始选项；可在「类型/场景」页增删）。 */
export const DEFAULT_TYPE_SCENES = ['推理', '对话', '代码', '视觉', '长文本', '多模态', '工具调用', '快速', '其他'];
/** 清洗类型/场景列表：字符串数组、trim、去重、上限 50；非法或空则回退默认列表。 */
export function sanitizeTypeSceneList(value) {
    if (Array.isArray(value)) {
        const out = cleanStringArray(value, 50);
        if (out.length)
            return out;
    }
    return DEFAULT_TYPE_SCENES.slice();
}
export const DEFAULT_CATEGORIES = [
    { name: '深度推理', desc: '复杂推理 / 长链思考任务，如代码设计、逻辑分析、多步规划。', modelIds: [], isDefault: true },
    { name: '代码辅助', desc: '代码编写 / 解释 / 重构 / 调试，面向工程开发场景。', modelIds: [], isDefault: false },
    { name: '视觉理解', desc: '图片 / 文档视觉理解与多模态任务。', modelIds: [], isDefault: false },
    { name: '快速响应', desc: '低延迟问答 / 对话 / 轻量任务，追求速度。', modelIds: [], isDefault: false },
    { name: '重载任务', desc: '批量 / 长文本 / 高吞吐任务，适合大上下文模型。', modelIds: [], isDefault: false },
];
export const DEFAULT_CONFIG = Object.freeze({
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
});
function cleanString(value, fallback, max = MAX_STR) {
    if (typeof value !== 'string')
        return fallback;
    const text = value.trim();
    return text && text.length <= max ? text : fallback;
}
function cleanBool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/** 整数清洗：数值取整并 clamp 到 [min, max]，非法回退 fallback。 */
function cleanInt(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}
function cleanId(value, prefix) {
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value))
        return value;
    return `${prefix}_${randomUUID().slice(0, 8)}`;
}
/** 用户唯一标识清洗：保留任意非空 senderId（trim 后 ≤128，如钉钉 staffId / openId）；空则生成内部 usr_xxx。 */
function sanitizeUserId(value) {
    if (typeof value === 'string') {
        const text = value.trim();
        if (text && text.length <= 128)
            return text;
    }
    return `usr_${randomUUID().slice(0, 8)}`;
}
function cleanStringArray(value, max = 64) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        const text = item.trim();
        if (!text || text.length > 128 || seen.has(text))
            continue;
        seen.add(text);
        out.push(text);
        if (out.length >= max)
            break;
    }
    return out;
}
function cleanWeights(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (!key || key.length > 128)
            continue;
        const num = Number(raw);
        if (!Number.isFinite(num))
            continue;
        const weight = Math.min(10, Math.max(1, Math.round(num)));
        out[key] = weight;
    }
    return out;
}
export function sanitizeCategory(input) {
    const source = (input && typeof input === 'object' ? input : {});
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
function sanitizeImRouteQuestions(input) {
    const source = (input && typeof input === 'object' ? input : {});
    const out = {};
    for (const [name, raw] of Object.entries(source)) {
        const rec = (raw && typeof raw === 'object' ? raw : {});
        const type = ['choice', 'score', 'noul'].includes(rec.type) ? rec.type : 'noul';
        const instructions = cleanString(rec.instructions, '', 500);
        if (!name || name.length > 60)
            continue;
        out[name] = {
            type,
            instructions,
            ...(rec.criteria !== undefined ? { criteria: rec.criteria } : {}),
        };
        if (Object.keys(out).length >= 30)
            break;
    }
    return out;
}
/** 清洗 IM 消息路由判定规则（rules）。 */
function sanitizeImRouteRules(input) {
    const source = (input && typeof input === 'object' ? input : {});
    const out = [];
    const seen = new Set();
    if (Array.isArray(source.rules)) {
        for (const item of source.rules.slice(0, 100)) {
            if (!item || typeof item !== 'object')
                continue;
            const rec = item;
            const field = cleanString(rec.field, '', 60);
            const categoryId = cleanString(rec.categoryId, '', 40);
            if (!field || !categoryId)
                continue;
            const key = `${field}\u0000${categoryId}\u0000${cleanString(rec.value, '', 60)}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push({ field, value: cleanString(rec.value, '', 60), categoryId });
        }
    }
    return out;
}
/** 清洗「键 -> 整数」映射（并发上限 / 权重共用）。 */
function cleanNumberMap(value, min, max, limit = 64) {
    const out = {};
    if (!value || typeof value !== 'object')
        return out;
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(value)) {
        if (typeof rawKey !== 'string')
            continue;
        const key = rawKey.trim();
        const n = Math.round(Number(rawValue));
        if (!key || key.length > 160 || !Number.isFinite(n))
            continue;
        out[key] = Math.min(max, Math.max(min, n));
        count += 1;
        if (count >= limit)
            break;
    }
    return out;
}
/** 清洗决策模型并发调度配置。 */
export function sanitizeDecisionPool(input) {
    const source = (input && typeof input === 'object' ? input : {});
    const fallback = DEFAULT_CONFIG.route.imRoute.decisionPool;
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
export function sanitizeImRoute(input) {
    const source = (input && typeof input === 'object' ? input : {});
    const fallback = DEFAULT_CONFIG.route.imRoute;
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
export function sanitizeRoute(input) {
    const source = (input && typeof input === 'object' ? input : {});
    const fallback = DEFAULT_CONFIG.route;
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
export function sanitizeCategoryBindings(input) {
    const source = (input && typeof input === 'object' ? input : {});
    const out = [];
    const seen = new Set();
    if (Array.isArray(source.categoryBindings)) {
        for (const item of source.categoryBindings.slice(0, 50)) {
            if (!item || typeof item !== 'object')
                continue;
            const rec = item;
            const categoryId = cleanString(rec.categoryId, '', 40);
            if (!categoryId || seen.has(categoryId))
                continue;
            seen.add(categoryId);
            out.push({ categoryId, modelIds: cleanStringArray(rec.modelIds) });
        }
    }
    else if (source.categoryId) {
        const categoryId = cleanString(source.categoryId, '', 40);
        if (categoryId)
            out.push({ categoryId, modelIds: [] });
    }
    return out;
}
export function sanitizeRole(input) {
    const source = (input && typeof input === 'object' ? input : {});
    return {
        id: cleanId(source.id, 'role'),
        name: cleanString(source.name, '未命名角色', 60),
        deptIds: cleanStringArray(source.deptIds),
        categoryBindings: sanitizeCategoryBindings(source),
        desc: cleanString(source.desc, '', MAX_DESC),
    };
}
export function sanitizeDept(input) {
    const source = (input && typeof input === 'object' ? input : {});
    return {
        id: cleanId(source.id, 'dept'),
        name: cleanString(source.name, '未命名部门', 60),
        parentId: cleanString(source.parentId, '', 40),
        roleIds: cleanStringArray(source.roleIds),
    };
}
export function sanitizeUser(input) {
    const source = (input && typeof input === 'object' ? input : {});
    let deptIds = cleanStringArray(source.deptIds);
    // 旧版单部门字段 deptId 自动迁移为多部门
    if (deptIds.length === 0 && source.deptId) {
        const legacy = cleanString(source.deptId, '', 40);
        if (legacy)
            deptIds = [legacy];
    }
    return {
        id: sanitizeUserId(source.id),
        name: cleanString(source.name, '未命名用户', 60),
        roleId: cleanString(source.roleId, '', 40),
        deptIds,
        note: cleanString(source.note, '', MAX_DESC),
    };
}
export function sanitizeDecisionProvider(input) {
    const source = (input && typeof input === 'object' ? input : {});
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
export function sanitizeConfig(input) {
    const source = (input && typeof input === 'object' ? input : {});
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
    };
}
/** 清洗模型画像表（key=provider:model，type/scene 任一非空才保留；上限 200 条）。
 *  兼容旧数据：type 为字符串时归一化为单元素数组；重复项去重、上限 5 个。 */
function sanitizeModelProfiles(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (!key || key.length > 256 || out[key] || Object.keys(out).length >= 200)
            continue;
        const rec = (raw && typeof raw === 'object' ? raw : {});
        const rawTypes = Array.isArray(rec.type)
            ? rec.type
            : (typeof rec.type === 'string' && rec.type.trim() ? [rec.type] : []);
        const type = Array.from(new Set(rawTypes
            .filter((t) => typeof t === 'string' && t.trim().length > 0)
            .map((t) => t.trim().slice(0, 20)))).slice(0, 5);
        const scene = typeof rec.scene === 'string' ? rec.scene.trim().slice(0, 200) : '';
        if (type.length || scene)
            out[key] = { type, scene };
    }
    return out;
}
/** 解析自动添加用户的默认角色：配置了且角色仍存在时返回 roleId，否则空串（不赋）。 */
export function defaultRoleIdFor(config) {
    const roleId = config.userDefaults?.roleId ?? '';
    if (!roleId)
        return '';
    return config.roles.some((role) => role.id === roleId) ? roleId : '';
}
/** 配置文件路径：按当前 profile 隔离；profile 认定不出时回退旧的共享位置（不丢配置）。 */
export function configPath() {
    return mrrpConfigPathFor();
}
export class MrrpConfigStore {
    #path;
    #config = sanitizeConfig(DEFAULT_CONFIG);
    #loaded = false;
    #writing = Promise.resolve();
    constructor(path = configPath()) {
        this.#path = resolve(path);
    }
    get path() {
        return this.#path;
    }
    get() {
        return structuredClone(this.#config);
    }
    async load() {
        try {
            const raw = await readFile(this.#path, 'utf8');
            this.#config = sanitizeConfig(JSON.parse(raw.replace(/^\uFEFF/, '')));
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
            this.#config = sanitizeConfig(DEFAULT_CONFIG);
        }
        this.#loaded = true;
        return this.get();
    }
    async save(input) {
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
    async patch(partial) {
        return this.save(mergeConfig(this.get(), partial));
    }
    get loaded() {
        return this.#loaded;
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function mergeConfig(base, partial) {
    if (!isRecord(partial))
        return base;
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
