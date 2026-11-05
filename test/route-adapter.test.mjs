import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteAdapter, ROUTE_PROVIDER, ROUTE_MODEL, extractAttachmentHints, lastUserText, normalizeMultimodalInput, describeCallShape } from '../dist/route-adapter.js';

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

test('adapter.stream：转发目标模型失败自动切换兜底模型（未输出内容）', async () => {
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
  assert.equal(chunks[0].model, 'qwen-max', '转发失败后改用兜底模型回复');
  assert.ok(logs.some((l) => l.includes('fallback-after-error')), '记录转发失败切兜底事件');
});

test('adapter.stream：兜底模型就是失败目标模型时不重试，直接抛错', async () => {
  const config = makeConfig({ route: { ...makeConfig().route, imRoute: { ...makeConfig().route.imRoute, fallbackModel: 'dashscope:qwen-turbo' } } });
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } });
  const streamImpl = async function* () { throw new Error('upstream down'); };
  const { deps } = adapterDeps(config, { decide, streamImpl });
  const adapter = createRouteAdapter(deps);

  await assert.rejects(
    async () => { for await (const _ of collectStream(adapter, '服务器挂了')) { /* drain */ } },
    /调用失败/,
  );
});

test('adapter.stream：已输出部分内容后失败不切兜底（避免重复回复）', async () => {
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
    /调用失败/,
  );
  assert.ok(!logs.some((l) => l.includes('fallback-after-error')), '已输出内容时不切换兜底');
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
