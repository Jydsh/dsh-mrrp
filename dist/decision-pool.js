/**
 * 决策模型并发调度池。
 *
 * 池里同时放两类东西，合成一个统一候选集：
 *   - 不同 API（decisionProviders）下的提供方；
 *   - 同一个 API 下登记的多个模型名（openai / generic 的 modelNames）。
 * 也就是说：选中 2 个 API、其中一个下面填了 3 个模型，池里就是 1 + 3 = 4 个槽。
 *
 * 分派规则（按以下顺序比较）：
 *   1. 最少在途优先：利用率 = 在途 / 并发上限 / 权重，越低越先选 → 忙的模型自动跳过；
 *   2. 主用槽优先：利用率相同时主用模型先上；
 *   3. 最久未用优先（LRU）：串行调用时自然形成轮询，不会一直压同一个模型。
 *
 * 排队：所有槽都满额时等待空位（queueTimeoutMs），等不到返回 null，由上层落兜底模型。
 *      任务多到全部满额时就是排队等，这正是「太忙才排队」的预期行为。
 * 失败：该槽冷却 DECISION_COOLDOWN_MS，本次决策排除它换下一个（最多 DECISION_MAX_ATTEMPTS 个槽）。
 * 粘性：同一会话优先复用上次成功的槽（sticky 关闭则每次都重新挑）。
 *
 * 状态放在模块单例里：决策链路每次都会新建 createDecisionRunner，
 * 在途计数必须跨调用保持，否则并发判断失效。
 */
/** 失败后的冷却时长（毫秒）：避免反复打同一个故障模型。 */
export const DECISION_COOLDOWN_MS = 15_000;
/** 单次决策最多尝试的槽数（防止大池时把一场决策拖成串行长链）。 */
export const DECISION_MAX_ATTEMPTS = 3;
/** 每个模型默认并发上限。 */
export const DEFAULT_DECISION_LIMIT = 1;
/** 默认排队等待上限（毫秒）。 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 8_000;
/** 单个提供方最多展开的模型槽数。 */
const MAX_SLOTS_PER_PROVIDER = 8;
/** 槽标识：providerId::model（model 为空时是 providerId::）。 */
export function slotKeyOf(providerId, model) {
    return `${providerId}::${model}`;
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}
/** 规范化模型名列表：去空白、去重、限量；空列表返回 ['']（表示不带 model）。 */
function normalizeModels(names) {
    const out = [];
    if (Array.isArray(names)) {
        for (const raw of names) {
            if (typeof raw !== 'string')
                continue;
            const name = raw.trim();
            if (!name || out.includes(name))
                continue;
            out.push(name);
            if (out.length >= MAX_SLOTS_PER_PROVIDER)
                break;
        }
    }
    return out.length ? out : [''];
}
/** 读调度配置（缺省值集中在这里，store 只负责存）。 */
export function decisionPoolConfig(cfg) {
    const pool = cfg?.decisionPool;
    return {
        enabled: pool?.enabled !== false,
        defaultLimit: clampInt(pool?.defaultLimit, 1, 32, DEFAULT_DECISION_LIMIT),
        queueTimeoutMs: clampInt(pool?.queueTimeoutMs, 0, 60_000, DEFAULT_QUEUE_TIMEOUT_MS),
        sticky: pool?.sticky !== false,
        primaryProviderId: typeof pool?.primaryProviderId === 'string' ? pool.primaryProviderId.trim() : '',
        primaryModel: typeof pool?.primaryModel === 'string' ? pool.primaryModel.trim() : '',
        limits: pool?.limits && typeof pool.limits === 'object' ? pool.limits : {},
        weights: pool?.weights && typeof pool.weights === 'object' ? pool.weights : {},
    };
}
/**
 * 按配置展开候选槽。
 * providerIds 由调用方给（沿用「决策模型（可多选）」里选中的提供方顺序），
 * laya 提供方只展开 1 个槽（服务端自选检查点，请求不带 model）。
 */
export function buildDecisionSlots(config, providerIds) {
    const pool = decisionPoolConfig(config.route?.imRoute);
    const slots = [];
    for (const id of providerIds) {
        const provider = config.decisionProviders.find((item) => item.id === id);
        if (!provider || !provider.baseUrl)
            continue;
        const models = provider.format === 'laya' ? [''] : normalizeModels(provider.modelNames);
        for (const model of models) {
            const key = slotKeyOf(provider.id, model);
            slots.push({
                key,
                provider,
                model,
                limit: clampInt(pool.limits[key], 1, 32, pool.defaultLimit),
                weight: clampInt(pool.weights[key], 1, 5, 1),
                primary: pool.primaryProviderId === provider.id && pool.primaryModel === model,
            });
            if (slots.length >= 64)
                return slots;
        }
    }
    return slots;
}
function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}
export class DecisionScheduler {
    runtime = new Map();
    affinity = new Map();
    runtimeOf(key) {
        const existing = this.runtime.get(key);
        if (existing)
            return existing;
        const fresh = { inflight: 0, lastUsedAt: 0, cooldownUntil: 0, lastError: '', success: 0, failed: 0 };
        this.runtime.set(key, fresh);
        return fresh;
    }
    /** 利用率：在途 / 上限 / 权重。 */
    score(slot) {
        const st = this.runtimeOf(slot.key);
        return (st.inflight / slot.limit) / slot.weight;
    }
    compare(a, b) {
        const sa = this.score(a);
        const sb = this.score(b);
        if (Math.abs(sa - sb) > 1e-9)
            return sa - sb;
        if (a.primary !== b.primary)
            return a.primary ? -1 : 1;
        const ta = this.runtimeOf(a.key).lastUsedAt;
        const tb = this.runtimeOf(b.key).lastUsedAt;
        if (ta !== tb)
            return ta - tb;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    }
    /** 挑一个可用槽（未满额、不在冷却），没有则 null。 */
    pick(slots, options = {}) {
        const now = Date.now();
        const usable = slots.filter((slot) => {
            const st = this.runtimeOf(slot.key);
            return st.inflight < slot.limit && st.cooldownUntil <= now;
        });
        if (!usable.length)
            return null;
        if (options.sticky !== false && options.sessionKey) {
            const key = this.affinity.get(options.sessionKey);
            if (key) {
                const hit = usable.find((slot) => slot.key === key);
                if (hit)
                    return hit;
            }
        }
        let best = usable[0];
        for (let i = 1; i < usable.length; i += 1) {
            if (this.compare(usable[i], best) < 0)
                best = usable[i];
        }
        return best;
    }
    /**
     * 占一个槽：有空位立刻返回；全部满额则排队等到 queueTimeoutMs，等不到返回 null。
     * 调用方必须在用完后 release（成功或失败都要释放），否则在途数只增不减。
     */
    async acquire(slots, options = {}) {
        const started = Date.now();
        const timeout = Math.max(0, options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
        const deadline = started + timeout;
        for (;;) {
            const slot = this.pick(slots, options);
            if (slot) {
                const st = this.runtimeOf(slot.key);
                st.inflight += 1;
                st.lastUsedAt = Date.now();
                return { slot, waitMs: Date.now() - started };
            }
            if (Date.now() >= deadline)
                return null;
            await sleep(5);
        }
    }
    /** 释放槽：成功记粘性；失败进冷却，让本次决策换下一个槽。 */
    release(slot, outcome) {
        const st = this.runtimeOf(slot.key);
        st.inflight = Math.max(0, st.inflight - 1);
        if (outcome.ok) {
            st.success += 1;
            st.cooldownUntil = 0;
            st.lastError = '';
            if (outcome.sessionKey)
                this.affinity.set(outcome.sessionKey, slot.key);
        }
        else {
            st.failed += 1;
            st.cooldownUntil = Date.now() + DECISION_COOLDOWN_MS;
            st.lastError = (outcome.error ?? '').slice(0, 200);
        }
    }
    /** 池状态快照（控制台展示 / 日志诊断）。 */
    stats(slots) {
        const now = Date.now();
        return slots.map((slot) => {
            const st = this.runtimeOf(slot.key);
            return {
                key: slot.key,
                providerId: slot.provider.id,
                providerName: slot.provider.name,
                model: slot.model,
                format: slot.provider.format,
                endpoint: slot.provider.endpoint,
                limit: slot.limit,
                weight: slot.weight,
                primary: slot.primary,
                inflight: st.inflight,
                success: st.success,
                failed: st.failed,
                cooldownMs: Math.max(0, st.cooldownUntil - now),
                lastError: st.lastError,
            };
        });
    }
    /** 清空运行时状态（测试用；生产只在进程重启时自然清空）。 */
    reset() {
        this.runtime.clear();
        this.affinity.clear();
    }
}
/** 全局调度器：决策链路每次决策都会新建 runner，在途计数必须共享。 */
export const defaultDecisionScheduler = new DecisionScheduler();
