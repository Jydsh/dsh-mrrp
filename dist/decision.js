/**
 * 决策模型提供方：模型列表拉取、连通性测试、laya_decide 工具执行体。
 *
 * 支持的接口格式：
 *   - laya    Laya 决策模型（TypeSafe Jev 协议）。两种调用端点：
 *               · systemone  本地 laya-server，POST {baseUrl}/v1/systemone；
 *               · decisions  0G 云端，POST {baseUrl}/v1/decisions，请求体自动带 model: 'laya'。
 *            不提供 /v1/models 列表接口，模型名手动维护（内置检查点：english / multilingual / typed-decisions）。
 *   - openai  OpenAI 兼容接口，GET {baseUrl}/v1/models（Bearer 鉴权）。
 *   - generic 通用接口，GET {baseUrl}/models（Bearer 鉴权）。
 *
 * 鉴权：请求头 Authorization: Bearer <apiKey>；服务端未设置密钥时留空即可（不发送该头）。
 */
/** laya-server 内置检查点（Bifrost / Laya 自托管文档确认）。 */
export const KNOWN_LAYA_MODELS = Object.freeze([
    { id: 'english', name: 'english（英语，512 tokens）' },
    { id: 'multilingual', name: 'multilingual（多语言，1024 tokens）' },
    { id: 'typed-decisions', name: 'typed-decisions（结构化决策，1024 tokens）' },
]);
/** laya_decide 工具的默认测试问题（简单 choice）。 */
export function defaultLayaQuestions() {
    return {
        verdict: {
            type: 'choice',
            instructions: '根据 state 给出的文本，判断应当选择哪个选项。',
            criteria: { yes: '应该继续 / 同意 / 通过', no: '应该停止 / 拒绝 / 不通过' },
        },
    };
}
function baseOf(url) {
    return (url ?? '').trim().replace(/\/+$/, '');
}
/** Laya 提供方的决策请求 URL 与请求体（systemone = 本地；decisions = 0G 云端）。
 *  model 非空时请求体带 model 字段（OpenAI 兼容 / 云端判定型提供方需指定判定模型名）。 */
function layaDecisionRequest(provider, body, model) {
    const base = baseOf(provider.baseUrl ?? '');
    if (provider.endpoint === 'decisions') {
        return { url: `${base}/v1/decisions`, body: { model: model || 'laya', ...body } };
    }
    return { url: `${base}/v1/systemone`, body: model ? { model, ...body } : body };
}
function authHeaders(apiKey) {
    const key = (apiKey ?? '').trim();
    return key ? { authorization: `Bearer ${key}` } : {};
}
async function jsonFetch(url, init, timeoutMs = 10_000) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`服务响应 ${response.status}：${text.slice(0, 300)}`);
    }
    return response.json();
}
/** 按格式拉取模型列表。laya 返回内置检查点（manual=true），openai / generic 走真实列表接口。 */
export async function fetchProviderModels(provider) {
    const base = baseOf(provider.baseUrl ?? '');
    if (!/^https?:\/\//i.test(base))
        throw new Error('API 地址必须以 http(s):// 开头。');
    if (provider.format === 'laya') {
        return { models: [...KNOWN_LAYA_MODELS], manual: true };
    }
    const url = provider.format === 'openai' ? `${base}/v1/models` : `${base}/models`;
    const data = await jsonFetch(url, { headers: { 'content-type': 'application/json', ...authHeaders(provider.apiKey ?? '') } });
    const source = (data && typeof data === 'object' ? data : {});
    const rows = Array.isArray(source.data) ? source.data : [];
    if (!rows.length)
        throw new Error('接口未返回模型列表（期望 data 数组）。');
    const models = rows
        .map((row) => {
        const id = String(row?.id ?? '').trim();
        return { id, name: String(row?.name ?? row?.id ?? '').trim() };
    })
        .filter((m) => m.id && m.id.length <= 128);
    return { models, manual: false };
}
/** 测试连通性：laya 走真实决策调用，openai / generic 走模型列表拉取。 */
export async function testProvider(provider) {
    const base = baseOf(provider.baseUrl ?? '');
    if (!/^https?:\/\//i.test(base))
        return { ok: false, message: 'API 地址必须以 http(s):// 开头。', latencyMs: 0 };
    const start = Date.now();
    try {
        if (provider.format === 'laya') {
            const { url, body } = layaDecisionRequest(provider, {
                state: 'ping',
                questions: { reachable: { type: 'noul', instructions: 'Is this reachable?' } },
            });
            await jsonFetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...authHeaders(provider.apiKey ?? '') },
                body: JSON.stringify(body),
            }, 30_000);
        }
        else {
            const url = provider.format === 'openai' ? `${base}/v1/models` : `${base}/models`;
            await jsonFetch(url, { headers: { 'content-type': 'application/json', ...authHeaders(provider.apiKey ?? '') } });
        }
        return { ok: true, message: '连接成功', latencyMs: Date.now() - start };
    }
    catch (error) {
        return { ok: false, message: error?.message ?? String(error), latencyMs: Date.now() - start };
    }
}
/**
 * laya_decide 工具执行体（由 index.ts 注册进 DSH tools）。
 * 输入：{ state: string, questions?: object }；输出：Laya 原始 JSON 响应。
 * resolve 返回 { baseUrl, apiKey, endpoint? }：endpoint 为 'decisions' 时走 0G 云端 /v1/decisions。
 * timeoutMs：默认 30_000（工具路径）；生成路径的候选选择建议传短超时（如 6000），
 * 决策慢 / 不可达时快速落兜底，避免用户干等。
 */
export function makeLayaDecide(resolve, timeoutMs = 30_000) {
    return async (input) => {
        const source = (input && typeof input === 'object' ? input : {});
        const state = typeof source.state === 'string' ? source.state : '';
        if (!state.trim())
            throw new Error('参数 state 必填：传入待判断的文本。');
        const endpoint = resolve();
        if (!endpoint)
            throw new Error('未配置 Laya 服务：请在 MRRP 控制台「模型路由配置 → 决策模型绑定」中新增并启用 Laya 提供方。');
        const questions = source.questions && typeof source.questions === 'object' ? source.questions : defaultLayaQuestions();
        const { url, body } = layaDecisionRequest(endpoint, { state, questions }, endpoint.model);
        const data = await jsonFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders(endpoint.apiKey) },
            body: JSON.stringify(body),
        }, timeoutMs);
        return data;
    };
}
/** 从 OpenAI 兼容 chat 响应（choices[0].message.content）中提取判定 choice 与 reasoning。 */
export function extractChatChoice(data) {
    const root = (data && typeof data === 'object' ? data : {});
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const content = String(choices[0]?.message?.content ?? '').trim();
    // 去 ```json 围栏
    const jsonText = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
        const parsed = JSON.parse(jsonText);
        if (typeof parsed.choice === 'string' && parsed.choice.trim()) {
            return { choice: parsed.choice.trim(), reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '' };
        }
    }
    catch {
        // 非严格 JSON，走正则兜底
    }
    const choiceMatch = content.match(/"choice"\s*:\s*"([^"]+)"/) || content.match(/"choice"\s*:\s*([^,\s}]+)/);
    if (choiceMatch && choiceMatch[1])
        return { choice: choiceMatch[1].trim(), reasoning: '' };
    throw new Error(`判定输出未包含有效 choice（模型返回：${content.slice(0, 120) || '空'}）。`);
}
/**
 * OpenAI 兼容对话判定（format=openai/generic 且 endpoint=chat）：
 * 把判定问题（state + questions）交给普通 OpenAI 兼容模型，要求其输出
 * {"choice":"<候选 key>","reasoning":"..."}，再解析为标准 Laya 判定响应形状，
 * 供上层（extractDecisionValues / pickedModelFrom / 日志）直接复用。
 */
export function openaiChatDecide(resolve, timeoutMs = 10_000) {
    return async (input) => {
        const source = (input && typeof input === 'object' ? input : {});
        const state = typeof source.state === 'string' ? source.state : '';
        if (!state.trim())
            throw new Error('参数 state 必填：传入待判断的文本。');
        const ep = resolve();
        if (!ep)
            throw new Error('未配置决策模型服务：请在 MRRP 控制台「模型路由配置 → 决策模型绑定」中新增并启用提供方。');
        if (!ep.model)
            throw new Error('未配置判定模型名：请在提供方「模型列表」中填入要用于判定的模型名。');
        const questions = source.questions && typeof source.questions === 'object' ? source.questions : defaultLayaQuestions();
        const url = `${baseOf(ep.baseUrl)}/chat/completions`;
        const system = '你是模型路由判定器。根据「待判定文本 state」与「判定问题 questions」，从每个问题的候选（criteria 的 key）中选出最合适的 key。只输出一个严格 JSON 对象：{"choice":"<选择的 key>","reasoning":"<一句话理由>"}，不要输出其它内容。';
        const data = await jsonFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders(ep.apiKey) },
            body: JSON.stringify({
                model: ep.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: JSON.stringify({ state, questions }) },
                ],
                temperature: 0,
            }),
        }, timeoutMs);
        const { choice, reasoning } = extractChatChoice(data);
        // 标准化为 Laya 判定响应形状（answers.model.choice），上层解析与日志直接复用
        return {
            model: { id: ep.model, repo: 'openai-compat' },
            answers: { model: { type: 'choice', choice, reasoning } },
        };
    };
}
