import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteAdapter, ROUTE_PROVIDER, ROUTE_MODEL, extractAttachmentHints, lastUserText, normalizeMultimodalInput, describeCallShape, resolveSenderFor, rawUserText, buildFailoverChain } from '../dist/route-adapter.js';
import { extractSenderFromContent } from '../dist/route-engine.js';

/** 最小配置：staff_001 经 dept_it -> role_ops 拥有两个候选模型（cat_ops）。 */
function makeConfig(overrides = {}) {
  return {
    version: 1,
    route: {
      active: true, strategy: 'category', lb: 'round-robin', weights: {}, fallback: 'random',
      timeoutMs: 60000, retries: 0, failover: true,
      imRoute: {
        enabled: true,
        decisionProviderId: 'dp_laya',
        questions: {},
        rules: [],
        fallbackModel: 'dashscope:qwen-max',
        unknownUser: 'ignore',
        channels: ['dingtalk'],
      },
    },
    categories: [
      { id: 'cat_ops', name: '运维', desc: '', modelIds: ['dashscope:qwen-turbo', 'ollama:deepseek-r1'], isDefault: false },
    ],
    roles: [
      { id: 'role_ops', name: '运维员', deptIds: ['dept_it'], categoryBindings: [{ categoryId: 'cat_ops', modelIds: ['dashscope:qwen-turbo', 'ollama:deepseek-r1'] }], desc: '' },
    ],
    depts: [
      { id: 'dept_it', name: 'IT 部', parentId: '', roleIds: ['role_ops'] },
    ],
    users: [
      { id: 'staff_001', name: '李鹏', roleId: '', deptIds: ['dept_it'], note: '' },
    ],
    sidebar: { mode: 'auto' },
    decisionProviders: [
      { id: 'dp_laya', name: '本地 Laya', format: 'laya', endpoint: 'systemone', baseUrl: 'http://127.0.0.1:8000', apiKey: '', modelNames: [], categoryId: '', enabled: true, createdAt: '', updatedAt: '' },
    ],
    ...overrides,
  };
}

const quiet = { warn() {}, info() {}, error() {}, debug() {} };

/** adapter 依赖：registry 固定 s1 -> staff_001；host.llm.stream 记录 opts 并产出单 chunk。 */
function adapterDeps(config, { decide, streamImpl, logs } = {}) {
  const seen = [];
  return {
    config,
    seen,
    deps: {
      getConfig: () => config,
      registry: {
        resolveSender: (sessionId) => (sessionId === 's1' ? { senderId: 'staff_001', senderName: '李鹏' } : null),
      },
      host: {
        llm: {
          stream: streamImpl
            || (async function* (opts) {
              seen.push(opts);
              yield { provider: opts.provider, model: opts.model, text: 'ok' };
            }),
        },
      },
      decide: decide || (async (state) => ({ model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } })),
      logger: { warn() {}, info: (...a) => logs && logs.push(String(a[1] ?? '')), error() {} },
    },
  };
}

async function* collectStream(adapter, messages) {
  const options = {
    sessionId: 's1',
    provider: ROUTE_PROVIDER,
    model: ROUTE_MODEL,
    messages: Array.isArray(messages) ? messages : [{ role: 'user', content: messages }],
  };
  for await (const chunk of adapter.stream(options, null, undefined)) yield chunk;
}

test('adapter.stream：同会话连续消息每次都执行 Laya 决策（上下文缓存命中候选池但不锁死模型）', async () => {
  const config = makeConfig();
  const logs = [];
  let calls = 0;
  const decide = async (state) => {
    calls += 1;
    const choice = String(state).includes('代码') ? 'dashscope:qwen-turbo' : 'ollama:deepseek-r1';
    return { model: { response: { type: 'choice', choice } } };
  };
  const { deps, seen } = adapterDeps(config, { decide, logs });
  const adapter = createRouteAdapter(deps);

  const first = [];
  for await (const chunk of collectStream(adapter, '写一段 Python 代码')) first.push(chunk);
  const second = [];
  for await (const chunk of collectStream(adapter, '聊聊天')) second.push(chunk);

  assert.equal(calls, 2, '两条消息各执行一次 Laya 决策，不使用已决策模型复用');
  assert.equal(first[0].provider, 'dashscope');
  assert.equal(first[0].model, 'qwen-turbo', '代码消息按内容决策');
  assert.equal(second[0].provider, 'ollama');
  assert.equal(second[0].model, 'deepseek-r1', '闲聊消息按内容决策');
  assert.equal(seen.length, 2);
  assert.ok(logs.some((l) => l.includes('ctx-hit')), '第二次调用命中决策上下文缓存（候选池复用）');
  assert.ok(logs.some((l) => l.includes('"ctx":"hit"')), 'route 日志标记上下文命中');
});

test('adapter.stream：转发目标模型失败（未输出内容）时按候选链自动换模型', async () => {
  const config = makeConfig();
  const logs = [];
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const streamImpl = async function* (opts) {
    if (opts.model === 'qwen-turbo') throw new Error('upstream 503');
    yield { provider: opts.provider, model: opts.model, text: 'fallback reply' };
  };
  const { deps } = adapterDeps(config, { decide, streamImpl, logs });
  const adapter = createRouteAdapter(deps);

  const chunks = [];
  for await (const chunk of collectStream(adapter, '服务器挂了')) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].model, 'deepseek-r1', '失败后先切候选池里的下一个模型（候选优先于兜底）');
  assert.ok(logs.some((l) => l.includes('"event":"failover-switch"')), '记录切换事件');
  assert.ok(logs.some((l) => l.includes('"event":"failover-recovered"')), '记录容灾生效');
});

test('adapter.stream：兜底模型与首选同名也不重复请求，仍会试候选里的其它模型', async () => {
  const config = makeConfig({ route: { ...makeConfig().route, imRoute: { ...makeConfig().route.imRoute, fallbackModel: 'dashscope:qwen-turbo' } } });
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const called = [];
  const streamImpl = async function* (opts) {
    called.push(opts.model);
    if (opts.model === 'qwen-turbo') throw new Error('upstream down');
    yield { provider: opts.provider, model: opts.model, text: 'ok' };
  };
  const { deps } = adapterDeps(config, { decide, streamImpl });
  const adapter = createRouteAdapter(deps);

  const chunks = [];
  for await (const chunk of collectStream(adapter, '服务器挂了')) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].model, 'deepseek-r1', '首选与兜底同名时去重，改试候选里的其它模型');
  assert.deepEqual(called, ['qwen-turbo', 'deepseek-r1'], '同名模型不重复请求');
});

test('adapter.stream：已输出部分内容后失败不换模型（避免重复回复），错误带明确说明', async () => {
  const config = makeConfig();
  const logs = [];
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const streamImpl = async function* (opts) {
    if (opts.model === 'qwen-turbo') {
      yield { provider: opts.provider, model: opts.model, text: 'partial' };
      throw new Error('mid-stream error');
    }
    yield { provider: opts.provider, model: opts.model, text: 'fallback' };
  };
  const { deps } = adapterDeps(config, { decide, streamImpl, logs });
  const adapter = createRouteAdapter(deps);

  await assert.rejects(
    async () => { for await (const _ of collectStream(adapter, '服务器挂了')) { /* drain */ } },
    /输出过程中|已输出部分内容/,
  );
  assert.ok(!logs.some((l) => l.includes('"event":"failover-switch"')), '已输出内容时不切换模型');
  assert.ok(logs.some((l) => l.includes('"event":"attempt-fail"')), '记录失败事件');
});

test('extractAttachmentHints：从 content 数组 / 占位文本 / markdown 提取附件类型', () => {
  assert.deepEqual(extractAttachmentHints({ messages: [{ role: 'user', content: [{ type: 'image_url', url: 'x' }] }] }), ['image']);
  assert.deepEqual(extractAttachmentHints({ messages: [{ role: 'user', content: [{ type: 'image_url' }, { type: 'file' }] }] }), ['image', 'file']);
  assert.deepEqual(extractAttachmentHints({ messages: [{ role: 'user', content: '发个[视频]给你' }] }), ['video']);
  assert.deepEqual(extractAttachmentHints({ messages: [{ role: 'user', content: '![图](http://a/1.png)' }] }), ['image']);
  assert.deepEqual(extractAttachmentHints({ messages: [{ role: 'user', content: '普通文本' }] }), []);
  assert.deepEqual(extractAttachmentHints({ messages: [{ role: 'assistant', content: '[图片]' }, { role: 'user', content: '看看' }] }), []);
  // 历史 user 带图、最后一条 user 纯文本 → 不计入「本条消息」附件（避免每次都被当成带图消息）
  assert.deepEqual(extractAttachmentHints({ messages: [{ role: 'user', content: [{ type: 'image_url', url: 'x' }] }, { role: 'user', content: '看看这个' }] }), []);
  assert.deepEqual(extractAttachmentHints({ messages: [{ role: 'user', content: '旧消息[图片]' }, { role: 'user', content: '新消息' }] }), []);
});

test('lastUserText / extractAttachmentHints：兼容宿主 input 数组形态（input: [text, image]）', () => {
  const opts = {
    sessionId: 's1',
    input: [
      { type: 'text', text: '帮我看看这张图' },
      { type: 'image', url: 'https://a/1.png' },
    ],
  };
  assert.equal(lastUserText(opts), '帮我看看这张图', 'input 数组形态提取正文');
  assert.deepEqual(extractAttachmentHints(opts), ['image'], 'input 数组形态识别图片附件');
  // messages 形态仍兼容
  assert.equal(lastUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), 'hi');
});

test('lastUserText：剥离 dsh_im_source 发送者块并覆盖顶层字段形态', () => {
  const block = '<dsh_im_source>{"senderId":"021724185801860353","senderName":"李鹏"}</dsh_im_source>';
  // messages string content：发送者块 + 正文 → 只留正文（决策 state 不被发送者块污染）
  assert.equal(lastUserText({ messages: [{ role: 'user', content: `${block}\n帮我看看这个模型配置` }] }), '帮我看看这个模型配置');
  // 只有发送者块（无正文）→ 空串（调用方回退 senderId）
  assert.equal(lastUserText({ messages: [{ role: 'user', content: block }] }), '');
  // input 数组含发送者块文本 → 剥块后无正文
  assert.equal(lastUserText({ input: [{ type: 'text', text: block }, { type: 'image', url: 'x' }] }), '');
  // 顶层兜底字段（宿主可能把当前用户正文放在 content / prompt 等位置）
  assert.equal(lastUserText({ content: '为什么选中这个模型' }), '为什么选中这个模型');
  assert.equal(lastUserText({ prompt: `${block}\n解释一下` }), '解释一下');
  assert.equal(lastUserText({ message: { content: '看这个图' } }), '看这个图');
  // 无任何正文 → 空串
  assert.equal(lastUserText({}), '');
  // 最后一条 user 是宿主注入的发送者块（无正文）→ 跳过元数据，定位其前真实 user 消息正文
  assert.equal(lastUserText({ messages: [{ role: 'user', content: '历史问题' }, { role: 'user', content: block }] }), '历史问题');
  // 带图形态：最后 user=发送者块元数据，倒数第二条 user=正文+图片 → 正文提取、附件识别（均不翻到历史）
  const imgMsg = { messages: [
    { role: 'user', content: '更早的普通问题' },
    { role: 'user', content: [{ type: 'text', text: `${block}\n帮我看看这张图` }, { type: 'image_url', url: 'https://a/1.png' }] },
    { role: 'user', content: block },
  ] };
  assert.equal(lastUserText(imgMsg), '帮我看看这张图', '带图消息：跳过尾部发送者块，正文取自真实用户消息');
  assert.deepEqual(extractAttachmentHints(imgMsg), ['image'], '带图消息：附件识别到 image');
  // 纯文本消息即使历史带图，也不把历史附件计入当前消息（定位在真实用户消息即止）
  const textMsg = { messages: [
    { role: 'user', content: [{ type: 'image_url', url: 'x' }] },
    { role: 'user', content: '新消息' },
    { role: 'user', content: block },
  ] };
  assert.equal(lastUserText(textMsg), '新消息');
  assert.deepEqual(extractAttachmentHints(textMsg), []);
});

test('normalizeMultimodalInput：image 块规范化为 OpenAI 兼容 image_url', () => {
  const f1 = { input: [{ type: 'text', text: 't' }, { type: 'image', url: 'https://a/1.png' }] };
  normalizeMultimodalInput(f1);
  assert.deepEqual(f1.input[1], { type: 'image_url', image_url: { url: 'https://a/1.png' } });
  // 幂等：再次规范化不改变
  normalizeMultimodalInput(f1);
  assert.deepEqual(f1.input[1], { type: 'image_url', image_url: { url: 'https://a/1.png' } });
  // base64 data → data URL
  const f2 = { input: [{ type: 'image', data: 'AAAABBBB' }] };
  normalizeMultimodalInput(f2);
  assert.deepEqual(f2.input[0], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAABBBB' } });
  // messages content 内 image_url 仅有 url → 包一层；已有 image_url 不动
  const f3 = { messages: [{ role: 'user', content: [{ type: 'image_url', url: 'x' }, { type: 'image_url', image_url: { url: 'y' } }] }] };
  normalizeMultimodalInput(f3);
  assert.deepEqual(f3.messages[0].content[0], { type: 'image_url', image_url: { url: 'x' } });
  assert.deepEqual(f3.messages[0].content[1], { type: 'image_url', image_url: { url: 'y' } });
  // 未知字段（file_id）保留原样
  const f4 = { input: [{ type: 'image', file_id: 'f-1' }] };
  normalizeMultimodalInput(f4);
  assert.deepEqual(f4.input[0], { type: 'image', file_id: 'f-1' });
});

test('describeCallShape：记录输入/用户消息结构（含纯文本形态，供决策正文观测）', () => {
  // 纯文本消息也记录结构快照（确认宿主把用户正文放在哪个字段）
  const plain = describeCallShape({ sessionId: 's1', messages: [{ role: 'user', content: '纯文本' }] });
  assert.equal(plain.userMsgCount, 1);
  assert.equal(plain.lastUserContentType, 'string');
  assert.deepEqual(plain.lastUserBlockKinds, undefined);
  const shape = describeCallShape({ input: [{ type: 'text', text: 't' }, { type: 'image', url: 'x' }] });
  assert.equal(shape.hasInput, true);
  assert.deepEqual(shape.inputKinds, ['text', 'image']);
  assert.deepEqual(shape.imageFields, ['type', 'url']);
  assert.equal(shape.inputTextBlocks, 1);
});

test('adapter.stream：input 数组形态带图消息转发时图片规范化为 image_url', async () => {
  const config = makeConfig();
  const decide = async (state, questions) => ({ model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } });
  const { deps, seen } = adapterDeps(config, { decide });
  const adapter = createRouteAdapter(deps);
  const chunks = [];
  for await (const chunk of adapter.stream({
    sessionId: 's1',
    provider: ROUTE_PROVIDER,
    model: ROUTE_MODEL,
    input: [{ type: 'text', text: '看图' }, { type: 'image', url: 'https://a/1.png' }],
  }, null, undefined)) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(seen.length, 1, '转发调用一次');
  const forwarded = seen[0];
  assert.equal(forwarded.provider, 'ollama');
  assert.deepEqual(forwarded.input[1], { type: 'image_url', image_url: { url: 'https://a/1.png' } }, '转发后图片为 OpenAI 兼容格式');
});

test('normalizeMultimodalInput：video 规范化为 video_url，file/audio 原样透传', () => {
  // video url → video_url
  const f1 = { input: [{ type: 'video', url: 'https://a/1.mp4' }] };
  normalizeMultimodalInput(f1);
  assert.deepEqual(f1.input[0], { type: 'video_url', video_url: { url: 'https://a/1.mp4' } });
  // video_url 仅有 url → 包一层；已有 video_url 不动
  const f2 = { input: [{ type: 'video_url', url: 'x' }, { type: 'video_url', video_url: { url: 'y' } }] };
  normalizeMultimodalInput(f2);
  assert.deepEqual(f2.input[0], { type: 'video_url', video_url: { url: 'x' } });
  assert.deepEqual(f2.input[1], { type: 'video_url', video_url: { url: 'y' } });
  // file / audio 原样保留（无统一开放标准）
  const f3 = { input: [{ type: 'file', file_id: 'f-1', name: 'a.pdf' }, { type: 'audio', url: 'https://a/1.wav' }] };
  normalizeMultimodalInput(f3);
  assert.deepEqual(f3.input[0], { type: 'file', file_id: 'f-1', name: 'a.pdf' });
  assert.deepEqual(f3.input[1], { type: 'audio', url: 'https://a/1.wav' });
  // image + video 混合都规范化
  const f4 = { input: [{ type: 'image', url: 'https://a/i.png' }, { type: 'video', url: 'https://a/v.mp4' }] };
  normalizeMultimodalInput(f4);
  assert.deepEqual(f4.input[0], { type: 'image_url', image_url: { url: 'https://a/i.png' } });
  assert.deepEqual(f4.input[1], { type: 'video_url', video_url: { url: 'https://a/v.mp4' } });
});

test('describeCallShape：记录各附件类型字段与工具调用声明', () => {
  const shape = describeCallShape({
    input: [
      { type: 'text', text: 't' },
      { type: 'image', url: 'x' },
      { type: 'video', url: 'y' },
      { type: 'file', file_id: 'f' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
    tool_choice: 'auto',
  });
  assert.deepEqual(shape.inputKinds, ['text', 'image', 'video', 'file']);
  assert.deepEqual(shape.imageFields, ['type', 'url']);
  assert.deepEqual(shape.videoFields, ['type', 'url']);
  assert.deepEqual(shape.fileFields, ['type', 'file_id']);
  assert.equal(shape.hasTools, true);
  assert.equal(shape.toolCount, 1);
  assert.deepEqual(shape.toolNames, ['get_weather']);
  assert.equal(shape.toolChoice, 'auto');
});

test('adapter.stream：input 多模态（图+视频）转发时全部规范化为 OpenAI 兼容结构，工具声明原样透传', async () => {
  const config = makeConfig();
  const decide = async (state, questions) => ({ model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } });
  const { deps, seen } = adapterDeps(config, { decide });
  const adapter = createRouteAdapter(deps);
  const chunks = [];
  for await (const chunk of adapter.stream({
    sessionId: 's1',
    provider: ROUTE_PROVIDER,
    model: ROUTE_MODEL,
    input: [
      { type: 'text', text: '看图看视频' },
      { type: 'image', url: 'https://a/i.png' },
      { type: 'video', url: 'https://a/v.mp4' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
    tool_choice: 'auto',
  }, null, undefined)) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(seen.length, 1);
  const forwarded = seen[0];
  assert.equal(forwarded.provider, 'ollama');
  assert.deepEqual(forwarded.input[1], { type: 'image_url', image_url: { url: 'https://a/i.png' } });
  assert.deepEqual(forwarded.input[2], { type: 'video_url', video_url: { url: 'https://a/v.mp4' } });
  assert.deepEqual(forwarded.tools, [{ type: 'function', function: { name: 'get_weather' } }], '工具声明原样透传');
  assert.equal(forwarded.tool_choice, 'auto');
});

test('adapter：listModels/resolveModel 声明全模态输入与输出（图片/视频生成可对接）', async () => {
  const { deps } = adapterDeps(makeConfig(), {});
  const adapter = createRouteAdapter(deps);
  const models = await adapter.listModels(ROUTE_PROVIDER);
  const m = await adapter.resolveModel(ROUTE_PROVIDER, ROUTE_MODEL);
  assert.deepEqual(models[0].inputModalities, ['text', 'image', 'video', 'file', 'audio']);
  assert.deepEqual(models[0].outputModalities, ['text', 'image', 'video', 'audio', 'file']);
  assert.deepEqual(m.inputModalities, ['text', 'image', 'video', 'file', 'audio']);
  assert.deepEqual(m.outputModalities, ['text', 'image', 'video', 'audio', 'file']);
});

test('adapter：启动决策模型关闭时不再暴露虚拟模型（模型列表里不该残留「MRRP 智能路由」）', async () => {
  const config = makeConfig();
  config.route.imRoute = { ...config.route.imRoute, enabled: false };
  const { deps } = adapterDeps(config, {});
  const adapter = createRouteAdapter(deps);
  const models = await adapter.listModels(ROUTE_PROVIDER);
  assert.deepEqual(models, []);
  // 关闭后仍可解析：旧会话已选中 mrrp/route 时按兜底模型转发，不能因为隐藏列表而崩
  const resolved = await adapter.resolveModel(ROUTE_PROVIDER, ROUTE_MODEL);
  assert.equal(resolved.id, ROUTE_MODEL);
});

test('adapter.stream：目标模型输出图片/视频块经路由原样透传（forward-media 观测）', async () => {
  const config = makeConfig();
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } });
  const logs = [];
  const streamImpl = async function* () {
    yield { type: 'image', url: 'https://a/gen1.png' };
    yield { text: '生成好了' };
    yield { type: 'image', url: 'https://a/gen2.png' };
    yield { type: 'video', url: 'https://a/gen.mp4' };
  };
  const { deps } = adapterDeps(config, { decide, logs, streamImpl });
  const adapter = createRouteAdapter(deps);
  const chunks = [];
  for await (const chunk of adapter.stream({
    sessionId: 's1',
    provider: ROUTE_PROVIDER,
    model: ROUTE_MODEL,
    input: [{ type: 'text', text: '画一只猫' }],
  }, null, undefined)) chunks.push(chunk);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks[0], { type: 'image', url: 'https://a/gen1.png' }, '图像输出块原样透传');
  assert.deepEqual(chunks[2], { type: 'image', url: 'https://a/gen2.png' }, '多个图像输出块均原样透传');
  assert.deepEqual(chunks[3], { type: 'video', url: 'https://a/gen.mp4' }, '视频输出块原样透传');
  const mediaLogs = logs.filter((l) => l.includes('forward-media'));
  assert.ok(mediaLogs.length >= 1, '输出块观测日志记录');
  assert.equal(mediaLogs.length, 2, 'image/video 各记一次；同类型重复输出只记一次（去重）');
});

test('adapter.stream：消息带图片附件时判定输入携带附件能力提示', async () => {
  const config = makeConfig();
  const logs = [];
  const seen = [];
  const decide = async (state, questions) => {
    seen.push(questions);
    return { model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } };
  };
  const { deps } = adapterDeps(config, { decide, logs });
  const adapter = createRouteAdapter(deps);

  const chunks = [];
  for await (const chunk of adapter.stream({
    sessionId: 's1',
    provider: ROUTE_PROVIDER,
    model: ROUTE_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: '看看这个' }, { type: 'image_url', url: 'x' }] }],
  }, null, undefined)) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].model, 'deepseek-r1');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].model.instructions.includes('附件：图片'), '图片附件被识别并带入判定指令');
});

test('adapter 契约：必须实现宿主的 imageRequestPricing / imageRequestTarget（缺失会在压缩阶段抛 TypeError）', () => {
  const { deps } = adapterDeps(makeConfig());
  const adapter = createRouteAdapter(deps);
  // 宿主 dsh-llm 直接调用 this.adapters.get(...).adapter.imageRequestPricing(provider, model)，
  // 不检查方法是否存在；缺方法即 TypeError，进而 Cannot switch to mrrp/route。
  assert.equal(typeof adapter.imageRequestPricing, 'function');
  assert.equal(typeof adapter.imageRequestTarget, 'function');
  assert.equal(adapter.imageRequestPricing('mrrp', 'route'), undefined, '不声明定价 → 宿主退回中性估算');
  assert.deepEqual(
    adapter.imageRequestTarget('mrrp', 'route', { width: 1024, height: 768, bytes: 2048 }),
    { width: 1024, height: 768, maxBytes: 2048 },
    '图片投影与宿主归一化结果一致（原样转发）',
  );
});

test('extractSenderFromContent：兼容 dsh-im 的 JSON 发送者块与裸键值形态', () => {
  const json = extractSenderFromContent('<dsh_im_source>{"senderId":"021724185801860353","senderName":"李鹏"}</dsh_im_source>\n\n上午好');
  assert.equal(json.senderId, '021724185801860353', 'JSON 形态（值带引号）也能解析出 senderId');
  assert.equal(json.senderName, '李鹏');
  assert.equal(json.rest, '上午好');

  const bare = extractSenderFromContent('<dsh_im_source>senderId: 021724, senderName: 李鹏</dsh_im_source>\n你好');
  assert.equal(bare.senderId, '021724', '裸键值形态保持兼容');
  assert.equal(bare.senderName, '李鹏');
  assert.equal(bare.rest, '你好');

  assert.equal(extractSenderFromContent('没有前缀块').senderId, '');
});

test('resolveSenderFor：事件映射缺失时从请求正文恢复发送者并回填映射', () => {
  const remembered = [];
  const registry = {
    resolveSender: () => null,
    rememberSender: (sessionId, sender) => remembered.push({ sessionId, sender }),
  };
  const options = {
    sessionId: 'sess-dingtalk-1',
    messages: [{ role: 'user', content: '<dsh_im_source>{"senderId":"u-9","senderName":"张三"}</dsh_im_source>\n\n你好' }],
  };
  const sender = resolveSenderFor(options, registry);
  assert.deepEqual(sender, { senderId: 'u-9', senderName: '张三' });
  assert.equal(remembered.length, 1, '回填一次映射，后续同会话可直接命中');
  assert.equal(remembered[0].sessionId, 'sess-dingtalk-1');
});

test('resolveSenderFor：已有映射优先，不再解析正文', () => {
  let parsed = 0;
  const registry = {
    resolveSender: () => ({ senderId: 'staff_001', senderName: '李鹏' }),
    rememberSender: () => { parsed += 1; },
  };
  const options = { sessionId: 's1', messages: [{ role: 'user', content: '<dsh_im_source>{"senderId":"other"}</dsh_im_source>\n嗨' }] };
  assert.deepEqual(resolveSenderFor(options, registry), { senderId: 'staff_001', senderName: '李鹏' });
  assert.equal(parsed, 0);
});

test('rawUserText：保留发送者前缀块（lastUserText 则剥离）', () => {
  const options = { messages: [{ role: 'user', content: '<dsh_im_source>{"senderId":"u-1"}</dsh_im_source>\n正文内容' }] };
  assert.ok(rawUserText(options).includes('<dsh_im_source>'), 'raw 版本保留前缀块');
  assert.equal(lastUserText(options), '正文内容', '决策用版本剥离前缀块');
});

// ---------- 容灾（模型服务不可达时自动换模型） ----------

/** 跑一次完整 stream，返回 { chunks, error }（不因模型报错中断测试）。 */
async function runStream(adapter) {
  const chunks = [];
  try {
    for await (const chunk of adapter.stream({
      sessionId: 's1',
      provider: ROUTE_PROVIDER,
      model: ROUTE_MODEL,
      messages: [{ role: 'user', content: '你好' }],
    }, null, undefined)) chunks.push(chunk);
  } catch (error) {
    return { chunks, error };
  }
  return { chunks, error: null };
}

test('容灾：首选模型连不上（且未输出内容）时自动切候选里的下一个，用户只看到成功模型的回复', async () => {
  const config = makeConfig();
  const logs = [];
  const called = [];
  const streamImpl = async function* (opts) {
    called.push(`${opts.provider}:${opts.model}`);
    if (opts.model === 'qwen-turbo') throw new Error('无法连接模型服务（ECONNREFUSED 127.0.0.1:11434）');
    yield { text: '来自备选模型的回复' };
  };
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const { deps } = adapterDeps(config, { decide, logs, streamImpl });
  const adapter = createRouteAdapter(deps);

  const { chunks, error } = await runStream(adapter);

  assert.equal(error, null, '不应把「无法连接模型服务」抛给用户');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, '来自备选模型的回复');
  assert.deepEqual(called, ['dashscope:qwen-turbo', 'ollama:deepseek-r1'], '失败后切到候选池里的下一个模型');
  const events = logs.join('\n');
  assert.ok(events.includes('"event":"attempt-fail"'), '记录失败模型');
  assert.ok(events.includes('"event":"failover-switch"'), '记录切换');
  assert.ok(events.includes('"event":"failover-recovered"'), '记录容灾生效');
});

test('容灾：目标模型以 finish(kind=error) 表达限流/额度不足时也自动切兜底（宿主不抛异常的真实形态）', async () => {
  const config = makeConfig();
  const logs = [];
  const called = [];
  const streamImpl = async function* (opts) {
    called.push(`${opts.provider}:${opts.model}`);
    if (opts.model === 'qwen-turbo') {
      // 宿主把 provider 的 429 归一化成终态 finish 事件，而不是抛异常
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Rate limit exceeded', code: 'RATE_LIMITED', status: 429 } } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: '来自兜底模型的回复' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const { deps } = adapterDeps(config, { decide, logs, streamImpl });
  const adapter = createRouteAdapter(deps);

  const { chunks, error } = await runStream(adapter);

  assert.equal(error, null, '限流不应被当成正常结束抛给用户');
  const text = chunks.filter((c) => typeof c.text === 'string').map((c) => c.text).join('');
  assert.equal(text, '来自兜底模型的回复');
  assert.deepEqual(called, ['dashscope:qwen-turbo', 'ollama:deepseek-r1'], '限流后切到下一个模型');
  const events = logs.join('\n');
  assert.ok(events.includes('"event":"model-failure"'), '记录 finish 事件里的限流错误');
  assert.ok(events.includes('"code":"RATE_LIMITED"'), '记录错误码');
  assert.ok(events.includes('"event":"failover-switch"'), '记录切换');
  assert.ok(events.includes('"event":"failover-recovered"'), '记录容灾生效');
});

test('容灾：finish(kind=aborted)（用户主动停止）不当作失败、不切换', async () => {
  const config = makeConfig();
  const logs = [];
  const called = [];
  const streamImpl = async function* (opts) {
    called.push(`${opts.provider}:${opts.model}`);
    yield { type: 'text-delta', index: 0, text: '被打断的内容' };
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by user', code: 'ABORTED' } } };
  };
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const { deps } = adapterDeps(config, { decide, logs, streamImpl });
  const adapter = createRouteAdapter(deps);

  const { error } = await runStream(adapter);
  assert.equal(error, null, '用户主动停止不算失败');
  assert.deepEqual(called, ['dashscope:qwen-turbo'], '不再换模型');
  assert.ok(!logs.join('\n').includes('"event":"failover-switch"'), '不记录切换');
});

test('容灾：候选与兜底全部不可用时抛出汇总错误，不去给用户一个含糊的「暂时无法连接」', async () => {
  const config = makeConfig();
  const calls = [];
  const streamImpl = async function* (opts) {
    calls.push(`${opts.provider}:${opts.model}`);
    throw new Error('无法连接模型服务');
  };
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const { deps } = adapterDeps(config, { decide, streamImpl });
  const adapter = createRouteAdapter(deps);

  const { error } = await runStream(adapter);
  assert.ok(error, '全部失败必须明确报错');
  assert.match(error.message, /均不可用/);
  for (const model of ['dashscope:qwen-turbo', 'ollama:deepseek-r1', 'dashscope:qwen-max']) {
    assert.ok(error.message.includes(model), `错误消息应列出尝试过的模型：${model}`);
  }
  assert.deepEqual(calls, ['dashscope:qwen-turbo', 'ollama:deepseek-r1', 'dashscope:qwen-max'], '按 首选→候选→兜底 顺序试完');
});

test('容灾：已输出内容后断开则不换模型（避免重复回复），抛明确错误', async () => {
  const config = makeConfig();
  const called = [];
  const streamImpl = async function* (opts) {
    called.push(`${opts.provider}:${opts.model}`);
    yield { text: '前半段已经发给用户了' };
    throw new Error('ECONNRESET');
  };
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const { deps } = adapterDeps(config, { decide, streamImpl });
  const adapter = createRouteAdapter(deps);

  const { chunks, error } = await runStream(adapter);
  assert.equal(chunks.length, 1, '已输出的内容已经交给宿主，不能撤回');
  assert.ok(error);
  assert.match(error.message, /输出过程中|已输出部分内容/);
  assert.deepEqual(called, ['dashscope:qwen-turbo'], '已输出后不再尝试其它模型');
});

test('容灾：route.failover=false 时不切换，失败即报错', async () => {
  const config = makeConfig();
  config.route.failover = false;
  const called = [];
  const streamImpl = async function* (opts) {
    called.push(`${opts.provider}:${opts.model}`);
    throw new Error('无法连接模型服务');
  };
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const { deps } = adapterDeps(config, { decide, streamImpl });
  const adapter = createRouteAdapter(deps);

  const { error } = await runStream(adapter);
  assert.ok(error);
  assert.deepEqual(called, ['dashscope:qwen-turbo'], '开关关闭时只试首选模型');
});

test('容灾：有备选模型时不原地重试（route.retries 只作用于单模型场景）', async () => {
  const config = makeConfig();
  config.route.retries = 2;
  const called = [];
  const streamImpl = async function* (opts) {
    called.push(`${opts.provider}:${opts.model}`);
    if (opts.model === 'qwen-turbo') throw new Error('无法连接模型服务');
    yield { text: '备选的回复' };
  };
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const { deps } = adapterDeps(config, { decide, streamImpl });
  const adapter = createRouteAdapter(deps);

  const { chunks, error } = await runStream(adapter);
  assert.equal(error, null);
  assert.equal(chunks.length, 1);
  assert.deepEqual(called, ['dashscope:qwen-turbo', 'ollama:deepseek-r1'], '失败一次就换模型，不在同一模型上空耗重试');
});

test('buildFailoverChain：首选→候选→兜底 去重、剔除自身、上限 4 个', () => {
  const chain = buildFailoverChain('a:m1', ['a:m2', 'a:m1', `${ROUTE_PROVIDER}:${ROUTE_MODEL}`, 'b:m3', 'c:m4', 'd:m5'], 'a:fallback');
  assert.deepEqual(chain, ['a:m1', 'a:m2', 'b:m3', 'c:m4'], '自身体/重复项被剔除，最多 4 个模型');
  assert.deepEqual(buildFailoverChain('a:m1', []), ['a:m1'], '无候选无兜底时只有首选');
  assert.deepEqual(buildFailoverChain('a:m1', ['badkey'], 'a:fb'), ['a:m1', 'a:fb'], '无效标识不进链');
});
