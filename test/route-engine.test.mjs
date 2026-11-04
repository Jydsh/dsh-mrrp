import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectUserModels,
  collectUserModelsPrioritized,
  extractDecisionValues,
  extractReasoning,
  extractEvent,
  flattenUserModels,
  parseModelKey,
  pruneRouteLogDir,
  pruneRouteLogFile,
  routeLogFileName,
  routeLogPathFor,
  sessionIdOf,
  builtinModelChoiceQuestion,
  resolveTargetModel,
  createImRouting,
} from '../dist/route-engine.js';
import {
  lastUserText,
  pickedModelFrom,
  resolveSenderFor,
  routeCfgFingerprint,
} from '../dist/route-adapter.js';

/** 构造一份最小配置（含分类 / 角色 / 部门 / 用户 / 决策提供方）。 */
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
      { id: 'cat_default', name: '默认', desc: '', modelIds: [], isDefault: true },
      { id: 'cat_ops', name: '运维', desc: '', modelIds: ['dashscope:qwen-max', 'ollama:deepseek-r1'], isDefault: false },
      { id: 'cat_urgent', name: '紧急', desc: '', modelIds: ['dashscope:qwen-turbo'], isDefault: false },
    ],
    roles: [
      {
        id: 'role_ops', name: '运维员', deptIds: ['dept_it'],
        categoryBindings: [{ categoryId: 'cat_ops', modelIds: ['ollama:deepseek-r1', 'dashscope:qwen-turbo'] }], desc: '',
      },
      {
        id: 'role_sales', name: '销售员', deptIds: [],
        categoryBindings: [{ categoryId: 'cat_urgent', modelIds: ['dashscope:qwen-turbo'] }], desc: '',
      },
    ],
    depts: [
      { id: 'dept_it', name: 'IT 部', parentId: '', roleIds: ['role_ops'] },
      { id: 'dept_mkt', name: '市场部', parentId: '', roleIds: [] },
    ],
    users: [
      { id: 'staff_001', name: '李鹏', roleId: '', deptIds: ['dept_it'], note: '' },
      { id: 'staff_002', name: '王芳', roleId: 'role_sales', deptIds: ['dept_mkt'], note: '' },
      { id: 'staff_003', name: '未绑定', roleId: '', deptIds: [], note: '' },
    ],
    sidebar: { mode: 'auto' },
    decisionProviders: [
      { id: 'dp_laya', name: '本地 Laya', format: 'laya', endpoint: 'systemone', baseUrl: 'http://127.0.0.1:8000', apiKey: '', modelNames: [], categoryId: '', enabled: true, createdAt: '', updatedAt: '' },
    ],
    ...overrides,
  };
}

const quiet = { warn() {}, info() {}, error() {}, debug() {} };

function depsFor(config, decide) {
  return { getConfig: () => config, logger: quiet, ...(decide ? { decide } : {}) };
}

test('parseModelKey：合法 / 非法', () => {
  assert.deepEqual(parseModelKey('dashscope:qwen-max'), { provider: 'dashscope', model: 'qwen-max' });
  assert.equal(parseModelKey(''), null);
  assert.equal(parseModelKey('no-colon'), null);
  assert.equal(parseModelKey(':model'), null);
  assert.equal(parseModelKey('provider:'), null);
});

test('extractDecisionValues：兼容 decisions 数组 / 顶层映射 / 内嵌 response', () => {
  const a = extractDecisionValues({
    decisions: [
      { question: 'department', response: { type: 'choice', choice: 'ops' } },
      { question: 'urgency', response: { type: 'choice', choice: 'high' } },
    ],
  });
  assert.deepEqual(a, { department: 'ops', urgency: 'high' });

  const b = extractDecisionValues({ department: 'sales', urgency: 'low' });
  assert.deepEqual(b, { department: 'sales', urgency: 'low' });

  const c = extractDecisionValues({ question: 'model', response: { type: 'choice', choice: 'ollama:deepseek-r1' } });
  assert.deepEqual(c, { model: 'ollama:deepseek-r1' });
});

test('extractReasoning：从多种返回形状提取选择理由', () => {
  assert.equal(extractReasoning({ model: { response: { type: 'choice', choice: 'a:x', reasoning: ' 该问题涉及复杂推理 ' } } }), '该问题涉及复杂推理');
  assert.equal(extractReasoning({ answers: [{ choice: 'a:x', reasoning: '快速响应更合适' }] }), '快速响应更合适');
  assert.equal(extractReasoning({ reasoning: '顶层理由' }), '顶层理由');
  assert.equal(extractReasoning({ model: { response: { type: 'choice', choice: 'a:x' } } }), undefined);
  assert.equal(extractReasoning(null), undefined);
});

test('routeCfgFingerprint：纳入影响候选池的配置（模型画像/分类/角色/部门/用户/默认角色）', () => {
  const cfg = makeConfig().route.imRoute;
  const base = makeConfig();
  const f1 = routeCfgFingerprint(cfg, base);
  // 仅改模型画像 -> 指纹变化（决策缓存失效，新画像立即生效）
  const f2 = routeCfgFingerprint(cfg, makeConfig({ modelProfiles: { 'ollama:deepseek-r1': { type: '代码', scene: 'x' } } }));
  assert.notEqual(f1, f2);
  // 仅改分类绑定 -> 指纹变化
  const changedCat = JSON.parse(JSON.stringify(base.categories));
  changedCat[0].modelIds = ['other:model'];
  const f3 = routeCfgFingerprint(cfg, { ...base, categories: changedCat });
  assert.notEqual(f1, f3);
  // 未传配置 -> 与旧行为一致（只含 imRoute）
  const f4 = routeCfgFingerprint(cfg);
  assert.notEqual(f1, f4);
  assert.equal(routeCfgFingerprint(cfg), routeCfgFingerprint(cfg));
});

test('collectUserModels：用户直接角色 + 部门角色按分类聚合', () => {
  const config = makeConfig();
  const byDept = collectUserModels(config, config.users[0]); // staff_001 -> dept_it -> role_ops
  assert.deepEqual([...byDept.get('cat_ops')].sort(), ['dashscope:qwen-turbo', 'ollama:deepseek-r1']);
  const byRole = collectUserModels(config, config.users[1]); // staff_002 -> role_sales
  assert.deepEqual([...byRole.get('cat_urgent')], ['dashscope:qwen-turbo']);
});

test('flattenUserModels：多分类展平并去重', () => {
  const map = new Map([['c1', new Set(['a:x', 'b:y'])], ['c2', new Set(['b:y', 'c:z'])]]);
  assert.deepEqual(flattenUserModels(map), ['a:x', 'b:y', 'c:z']);
});

test('builtinModelChoiceQuestion：候选 -> choice 判定问题', () => {
  const q = builtinModelChoiceQuestion([{ key: 'a:x', name: 'X' }, { key: 'b:y', name: 'Y' }]);
  assert.equal(q.type, 'choice');
  assert.deepEqual(q.criteria, { 'a:x': 'X', 'b:y': 'Y' });
  assert.ok(q.instructions.includes('候选模型'));
});

test('builtinModelChoiceQuestion：候选带类型/擅长场景 + 决策上下文（方案完善）', () => {
  const q = builtinModelChoiceQuestion(
    [{ key: 'a:x', name: 'X', type: '推理', scene: '复杂推理、长链思考' }, { key: 'b:y', name: 'Y', type: '快速' }],
    '发送者：测试用户；候选授权来源：用户直接角色 1 个模型 / 部门继承 2 个模型。',
  );
  assert.equal(q.criteria['a:x'], 'X；类型：推理；擅长：复杂推理、长链思考');
  assert.equal(q.criteria['b:y'], 'Y；类型：快速');
  assert.ok(q.instructions.includes('state 中是用户的问题正文'));
  assert.ok(q.instructions.includes('背景：发送者：测试用户'));
  assert.ok(q.instructions.includes('reasoning'));
});

test('resolveTargetModel：决策问题携带模型类型画像与发送者上下文（方案完善）', async () => {
  const config = makeConfig();
  let captured = null;
  const deps = depsFor(config, async () => ({ model: { response: { type: 'choice', choice: 'ollama:deepseek-r1', reasoning: '服务器问题需要深度排查能力' } } }));
  deps.onDecide = (phase, detail) => { if (phase === 'before') captured = detail; };
  const outcome = await resolveTargetModel(deps, config.route.imRoute, 'staff_001', '服务器挂了怎么排查');
  assert.equal(outcome.model, 'ollama:deepseek-r1');
  assert.equal(outcome.reasoning, '服务器问题需要深度排查能力');
  assert.ok(captured && captured.questions && captured.questions.model);
  const question = captured.questions.model;
  assert.equal(question.type, 'choice');
  // 画像来自分类：deepseek-r1 注册在 cat_ops（运维），qwen-turbo 注册在 cat_urgent（紧急）
  assert.ok(question.criteria['ollama:deepseek-r1'].includes('类型：运维'));
  assert.ok(question.criteria['dashscope:qwen-turbo'].includes('类型：紧急'));
  assert.ok(question.instructions.includes('发送者：李鹏'));
  assert.ok(question.instructions.includes('候选授权来源：用户直接角色 0 个模型 / 部门继承 2 个模型'));
});

test('resolveTargetModel：modelProfiles 手动画像覆盖分类画像（方案5）', async () => {
  const config = makeConfig({
    modelProfiles: { 'ollama:deepseek-r1': { type: '代码', scene: '工程代码生成与重构' } },
  });
  let captured = null;
  const deps = depsFor(config, async () => ({ model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } }));
  deps.onDecide = (phase, detail) => { if (phase === 'before') captured = detail; };
  const outcome = await resolveTargetModel(deps, config.route.imRoute, 'staff_001', '写一段代码');
  assert.equal(outcome.model, 'ollama:deepseek-r1');
  assert.equal(captured.questions.model.criteria['ollama:deepseek-r1'], 'deepseek-r1；类型：代码；擅长：工程代码生成与重构');
  // 未配置手动画像的模型仍回退分类画像
  assert.ok(captured.questions.model.criteria['dashscope:qwen-turbo'].includes('类型：紧急'));
});

test('resolveTargetModel：modelProfiles 类型多选（数组）全部带进决策问题', async () => {
  const config = makeConfig({
    modelProfiles: {
      'ollama:deepseek-r1': { type: ['代码', '推理'], scene: '工程代码生成与重构' },
      'dashscope:qwen-turbo': { type: ['对话', '快速'], scene: '日常问答与轻量任务' },
    },
  });
  let captured = null;
  const deps = depsFor(config, async () => ({ model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } }));
  deps.onDecide = (phase, detail) => { if (phase === 'before') captured = detail; };
  const outcome = await resolveTargetModel(deps, config.route.imRoute, 'staff_001', '看下这张图里的代码');
  assert.equal(outcome.model, 'ollama:deepseek-r1');
  assert.equal(captured.questions.model.criteria['ollama:deepseek-r1'], 'deepseek-r1；类型：代码、推理；擅长：工程代码生成与重构');
  assert.equal(captured.questions.model.criteria['dashscope:qwen-turbo'], 'qwen-turbo；类型：对话、快速；擅长：日常问答与轻量任务');
});

test('extractEvent：钉钉消息顶层 senderId + source 懒函数（实测根因修复）', () => {
  const event = {
    type: 'user/message',
    data: {
      senderId: 'staff_001',
      senderName: '李鹏',
      content: '服务器挂了',
      source: () => ({ kind: 'plugin:dsh-im', channel: 'dingtalk', senderId: 'staff_001', senderName: '李鹏' }),
    },
  };
  assert.deepEqual(extractEvent(event), { channel: 'dingtalk', senderId: 'staff_001', senderName: '李鹏', text: '服务器挂了' });
});

test('extractEvent：source 对象 + contextSource 姓名闭包', () => {
  const event = {
    type: 'user/message',
    data: {
      senderId: 'staff_002',
      content: 'hi',
      source: { kind: 'plugin:dsh-im', channel: 'dingtalk' },
      contextSource: () => ({ senderName: '王芳' }),
    },
  };
  assert.deepEqual(extractEvent(event), { channel: 'dingtalk', senderId: 'staff_002', senderName: '王芳', text: 'hi' });
});

test('extractEvent：kind 缺失不排除（对齐 dsh-im 容错），非 user/message 与快照排除', () => {
  // 无 kind、无 senderId（如 DSH Web 输入）-> 不提取
  assert.equal(extractEvent({ type: 'user/message', data: { source: () => ({ channel: 'web' }), text: 'x' } }), null);
  // 非 user/message
  assert.equal(extractEvent({ type: 'turn/start', data: {} }), null);
  // 快照类事件（自动回复上下文）排除
  assert.equal(extractEvent({ type: 'user/message', data: { source: { kind: 'plugin:dsh-im', form: 'snapshot' }, senderId: 's', text: 'x' } }), null);
  // 显式非 IM 来源排除
  assert.equal(extractEvent({ type: 'user/message', data: { source: { kind: 'other-plugin' }, senderId: 's', text: 'x' } }), null);
});

test('extractEvent：agent/inbox/spliced 事件从 inserted 最后一条提取发送者（实测根因修复）', () => {
  const event = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-turn',
      start: 42,
      inserted: [
        { role: 'user', content: '早', senderId: 'staff_003', senderName: '赵六', source: { kind: 'plugin:dsh-im', channel: 'dingtalk' } },
        { role: 'user', content: '服务器挂了', senderId: 'staff_001', senderName: '李鹏', source: { kind: 'plugin:dsh-im', channel: 'dingtalk' } },
      ],
    },
  };
  assert.deepEqual(extractEvent(event), { channel: 'dingtalk', senderId: 'staff_001', senderName: '李鹏', text: '服务器挂了' });
});

test('extractEvent：agent/inbox/spliced 无 senderId（agent 自身注入）或纯删除不建映射', () => {
  // 无 senderId -> 不提取（避免 agent 注入的 prompt 污染映射）
  assert.equal(extractEvent({ type: 'agent/inbox/spliced', data: { inserted: [{ role: 'user', content: '你是一个助手' }] } }), null);
  // outcome='canceled' 是纯删除，无新消息
  assert.equal(extractEvent({ type: 'agent/inbox/spliced', data: { outcome: 'canceled', inserted: [] } }), null);
  // empty inserted
  assert.equal(extractEvent({ type: 'agent/inbox/spliced', data: { inserted: [] } }), null);
});

test('extractEvent：agent/inbox/inserted 事件从 data.message 提取发送者', () => {
  const event = {
    type: 'agent/inbox/inserted',
    data: { message: { role: 'user', content: 'hi', senderId: 'staff_002', senderName: '王芳', source: { kind: 'plugin:dsh-im', channel: 'dingtalk' } } },
  };
  assert.deepEqual(extractEvent(event), { channel: 'dingtalk', senderId: 'staff_002', senderName: '王芳', text: 'hi' });
});

test('extractEvent：<dsh_im_source> 前缀块解析 senderId/senderName 并剥离正文（实测根因修复）', () => {
  const event = {
    type: 'agent/inbox/spliced',
    data: {
      inserted: [{
        role: 'user',
        content: '<dsh_im_source>\n  kind: user\n  senderId: 021724185801860353\n  senderName: 李鹏\n  channel: dingtalk\n</dsh_im_source>\n\n服务器又挂了',
        source: { kind: 'user', rpcId: 'dingtalk-abc', clientTimeZone: 'Asia/Shanghai' },
      }],
    },
  };
  assert.deepEqual(extractEvent(event), { channel: '', senderId: '021724185801860353', senderName: '李鹏', text: '服务器又挂了' });
});

test('extractEvent：<dsh_im_source> 前缀块在 ContentBlock[] 数组 content 中也能解析', () => {
  const event = {
    type: 'agent/inbox/inserted',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<dsh_im_source>senderId: staff_007</dsh_im_source>\n\n帮我查一下' }],
        source: { kind: 'user', rpcId: 'dingtalk-xyz' },
      },
    },
  };
  assert.deepEqual(extractEvent(event), { channel: '', senderId: 'staff_007', senderName: '', text: '帮我查一下' });
});

test('sessionIdOf：session.id / session.header.id / 空', () => {
  assert.equal(sessionIdOf({ id: 's1' }), 's1');
  assert.equal(sessionIdOf({ header: { id: 's2' } }), 's2');
  assert.equal(sessionIdOf(null), '');
  assert.equal(sessionIdOf({}), '');
});

test('resolveTargetModel：未注册用户 ignore 不路由 / fallback 用兜底', async () => {
  const config = makeConfig();
  assert.equal(await resolveTargetModel(depsFor(config), config.route.imRoute, 'unknown_sender', '你好'), null);
  const fb = makeConfig({
    route: { ...makeConfig().route, imRoute: { ...makeConfig().route.imRoute, unknownUser: 'fallback' } },
  });
  const outcome = await resolveTargetModel(depsFor(fb), fb.route.imRoute, 'unknown_sender', '你好');
  assert.deepEqual(outcome, { model: 'dashscope:qwen-max', source: 'unknown-fallback', candidates: [], sources: { direct: [], inherited: [] } });
});

test('collectUserModelsPrioritized：直接角色在前（显式授权最高），部门继承并集去重（方案 B）', () => {
  const config = makeConfig({
    users: [{ id: 'staff_mix', name: '混合', roleId: 'role_sales', deptIds: ['dept_it'], note: '' }],
  });
  const { direct, inherited } = collectUserModelsPrioritized(config, config.users[0]);
  assert.deepEqual(direct, ['dashscope:qwen-turbo']); // role_sales -> cat_urgent
  assert.deepEqual(inherited, ['ollama:deepseek-r1']); // dept_it -> role_ops，已含 qwen-turbo 被去重
});

test('resolveTargetModel：直接角色候选排序在前（方案 B）', async () => {
  const config = makeConfig({
    users: [{ id: 'staff_mix', name: '混合', roleId: 'role_sales', deptIds: ['dept_it'], note: '' }],
  });
  const outcome = await resolveTargetModel(depsFor(config, async () => ({ model: { response: { type: 'choice', choice: 'dashscope:qwen-turbo' } } })), config.route.imRoute, 'staff_mix', '服务器挂了');
  assert.deepEqual(outcome.candidates, ['dashscope:qwen-turbo', 'ollama:deepseek-r1']);
  assert.deepEqual(outcome.sources, { direct: ['dashscope:qwen-turbo'], inherited: ['ollama:deepseek-r1'] });
  assert.equal(outcome.model, 'dashscope:qwen-turbo');
  assert.equal(outcome.source, 'laya');
});

test('resolveTargetModel：用户候选唯一直接用（user 来源）', async () => {
  const config = makeConfig({
    roles: [
      { id: 'role_sales', name: '销售员', deptIds: [], categoryBindings: [{ categoryId: 'cat_urgent', modelIds: ['dashscope:qwen-turbo'] }], desc: '' },
    ],
  });
  const outcome = await resolveTargetModel(depsFor(config), config.route.imRoute, 'staff_002', '你好');
  assert.deepEqual(outcome, { model: 'dashscope:qwen-turbo', source: 'user', candidates: ['dashscope:qwen-turbo'], sources: { direct: ['dashscope:qwen-turbo'], inherited: [] } });
});

test('resolveTargetModel：多候选 laya 决策命中（laya 来源）', async () => {
  const config = makeConfig();
  const decide = async () => ({ model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } });
  const outcome = await resolveTargetModel(depsFor(config, decide), config.route.imRoute, 'staff_001', '服务器挂了');
  assert.equal(outcome.source, 'laya');
  assert.equal(outcome.model, 'ollama:deepseek-r1');
  assert.deepEqual(outcome.candidates, ['ollama:deepseek-r1', 'dashscope:qwen-turbo']);
  assert.deepEqual(outcome.decision, { choice: 'ollama:deepseek-r1' });
});

test('resolveTargetModel：Laya 真实响应（顶层 model 元数据污染）仍命中候选（实测根因修复）', async () => {
  const config = makeConfig();
  const decide = async () => ({
    model: 'laya-rl-agent',
    answers: {
      model: {
        type: 'choice',
        choice: 'ollama:deepseek-r1',
        probabilities: { 'ollama:deepseek-r1': 1, 'dashscope:qwen-turbo': 0 },
        confidence: 1,
        answer_confidence: 1,
        action: { act_probability: 1 },
        x_jev_confidence: 1,
      },
    },
    usage: { input_tokens: 180, output_tokens: 0, state_tokens: 44, truncated: false, truncated_questions: [] },
    routing: { model: 'multilingual', repo: 'convaiinnovations/laya/multilingual', reason: 'Latin script, using default (multilingual)' },
  });
  const outcome = await resolveTargetModel(depsFor(config, decide), config.route.imRoute, 'staff_001', '讲的笑话');
  assert.equal(outcome.source, 'laya');
  assert.equal(outcome.model, 'ollama:deepseek-r1');
  assert.deepEqual(outcome.candidates, ['ollama:deepseek-r1', 'dashscope:qwen-turbo']);
  assert.ok(outcome.decision);
  assert.equal(outcome.decision.choice, 'ollama:deepseek-r1');
});

test('resolveTargetModel：用户无绑定分类模型（候选池为空）-> 直接兜底，不调 Laya', async () => {
  const config = makeConfig({ users: [
    { id: 'staff_003', name: '未绑定', roleId: '', deptIds: [], note: '' },
  ] });
  let decideCalls = 0;
  const deps = depsFor(config, async () => { decideCalls += 1; return { model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } }; });
  deps.onDecide = () => { decideCalls += 1; };
  const outcome = await resolveTargetModel(deps, config.route.imRoute, 'staff_003', 'x');
  assert.equal(outcome.source, 'fallback');
  assert.equal(outcome.model, 'dashscope:qwen-max');
  assert.equal(decideCalls, 0, '候选池为空时必须短路走兜底，不得发起 Laya 决策');
});

test('resolveTargetModel：决策未命中候选 / 决策抛错 / 无决策提供方 -> 兜底', async () => {
  const config = makeConfig();
  // 未命中
  const miss = await resolveTargetModel(depsFor(config, async () => ({ model: 'other:x' })), config.route.imRoute, 'staff_001', 'x');
  assert.equal(miss.source, 'fallback');
  assert.equal(miss.model, 'dashscope:qwen-max');
  // 抛错
  const boom = await resolveTargetModel(depsFor(config, async () => { throw new Error('timeout'); }), config.route.imRoute, 'staff_001', 'x');
  assert.equal(boom.source, 'fallback');
  // 无决策提供方配置
  const noDp = makeConfig({
    route: { ...makeConfig().route, imRoute: { ...makeConfig().route.imRoute, decisionProviderId: '' } },
  });
  const noDpOut = await resolveTargetModel(depsFor(noDp), noDp.route.imRoute, 'staff_001', 'x');
  assert.equal(noDpOut.source, 'fallback');
});

test('pickedModelFrom：决策输出命中候选', () => {
  assert.equal(pickedModelFrom({ model: { response: { choice: 'a:x' } } }, ['a:x', 'b:y']), 'a:x');
  assert.equal(pickedModelFrom({ model: 'b:y' }, ['a:x', 'b:y']), 'b:y');
  assert.equal(pickedModelFrom({ model: 'c:z' }, ['a:x']), null);
  assert.equal(pickedModelFrom(null, ['a:x']), null);
});

test('pickedModelFrom：Laya 真实响应（顶层 model / routing.model 元数据）命中候选（实测根因修复）', () => {
  const raw = {
    model: 'laya-rl-agent',
    answers: {
      model: {
        type: 'choice',
        choice: 'ollama:deepseek-r1',
        probabilities: { 'ollama:deepseek-r1': 1, 'dashscope:qwen-turbo': 0 },
        confidence: 1,
        answer_confidence: 1,
        action: { act_probability: 1 },
        x_jev_confidence: 1,
      },
    },
    usage: { input_tokens: 180, output_tokens: 0, state_tokens: 44, truncated: false, truncated_questions: [] },
    routing: { model: 'multilingual', repo: 'convaiinnovations/laya/multilingual', reason: 'Latin script, using default (multilingual)' },
  };
  assert.equal(pickedModelFrom(raw, ['ollama:deepseek-r1', 'dashscope:qwen-turbo']), 'ollama:deepseek-r1');
});

test('lastUserText：取最后一条 user 消息文本（字符串 / 多模态数组）', () => {
  assert.equal(lastUserText({ messages: [{ role: 'user', content: 'hello' }] }), 'hello');
  assert.equal(lastUserText({ messages: [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: [{ type: 'text', text: 'new' }] },
  ] }), 'new');
  assert.equal(lastUserText({ messages: [{ role: 'assistant', content: 'x' }] }), '');
  assert.equal(lastUserText({}), '');
});

test('createImRouting：订阅 -> 会话映射 -> resolveSender / 渠道过滤 / 取消订阅', async () => {
  const listeners = new Map();
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const config = makeConfig();
  const engine = createImRouting(ctx, depsFor(config));
  engine.start();
  assert.equal(engine.status().subscribed, true);

  // 钉钉消息（source 懒函数 + 顶层 senderId）-> 映射
  await listeners.get('session/event')({ id: 'sess_1' }, {
    type: 'user/message',
    data: {
      senderId: 'staff_001',
      senderName: '李鹏',
      content: '服务器挂了',
      source: () => ({ kind: 'plugin:dsh-im', channel: 'dingtalk' }),
    },
  });
  assert.deepEqual(engine.resolveSender('sess_1'), { senderId: 'staff_001', senderName: '李鹏' });
  assert.equal(engine.status().mappedCount, 1);

  // 其它渠道（wecom 不在 channels）-> 不映射
  await listeners.get('session/event')({ id: 'sess_2' }, {
    type: 'user/message',
    data: { senderId: 'staff_002', content: 'x', source: () => ({ kind: 'plugin:dsh-im', channel: 'wecom' }) },
  });
  assert.equal(engine.resolveSender('sess_2'), null);
  assert.equal(engine.status().mappedCount, 1);

  // 无会话 id -> 不映射
  await listeners.get('session/event')({}, {
    type: 'user/message',
    data: { senderId: 'staff_002', content: 'x', source: () => ({ kind: 'plugin:dsh-im', channel: 'dingtalk' }) },
  });
  assert.equal(engine.status().mappedCount, 1);

  // 会话 id 派生匹配兜底（sess_1 前缀）
  assert.deepEqual(engine.resolveSender('sess_1-extra'), { senderId: 'staff_001', senderName: '李鹏' });

  engine.stop();
  assert.equal(engine.status().subscribed, false);
  assert.equal(listeners.has('session/event'), false);
});

test('createImRouting：事件无 senderId 时经 dingtalk 桥映射解析发送者', async () => {
  const listeners = new Map();
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const config = makeConfig();
  config.users.push({ id: 'staff_009', name: '桥用户', roleId: '', deptIds: [], note: '' });
  const deps = depsFor(config);
  deps.dingtalkBridge = { readSessions: async () => new Map([['sess_9', 'staff_009']]) };
  const engine = createImRouting(ctx, deps);
  engine.start();
  // 桥映射异步加载，等一拍
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(engine.resolveSender('sess_9'), { senderId: 'staff_009', senderName: '桥用户' });
  assert.equal(engine.status().bridgeSessions, 1);
  // 派生会话 id 的包含匹配也命中桥映射
  assert.deepEqual(engine.resolveSender('sess_9-extra'), { senderId: 'staff_009', senderName: '桥用户' });
  engine.stop();
});

test('createImRouting：无 dingtalkBridge 时不影响事件观测映射', async () => {
  const listeners = new Map();
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const engine = createImRouting(ctx, depsFor(makeConfig()));
  engine.start();
  await listeners.get('session/event')({ id: 'sess_1' }, {
    type: 'user/message',
    data: { senderId: 'staff_001', content: 'x', source: () => ({ kind: 'plugin:dsh-im', channel: 'dingtalk' }) },
  });
  assert.deepEqual(engine.resolveSender('sess_1'), { senderId: 'staff_001', senderName: '' });
  assert.equal(engine.status().mappedCount, 1);
  engine.stop();
});

test('createImRouting：无 ctx.on 时未订阅且不抛错', () => {
  const engine = createImRouting({}, depsFor(makeConfig()));
  engine.start();
  assert.equal(engine.status().subscribed, false);
  assert.equal(engine.resolveSender('sess_1'), null);
  engine.stop();
});

test('pruneRouteLogFile：删除超过 30 天日志行，保留新行与坏行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-prune-'));
  const file = join(dir, 'route-decision.log');
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const oldLine = JSON.stringify({ ts: new Date(now - 40 * day).toISOString(), event: 'route', model: 'a' });
  const freshLine = JSON.stringify({ ts: new Date(now - 1 * day).toISOString(), event: 'route', model: 'b' });
  const badLine = 'not-json {{';
  writeFileSync(file, `${oldLine}\n${freshLine}\n${badLine}\n`, 'utf8');

  const removed = pruneRouteLogFile(file, 30, now);
  assert.equal(removed, 1);
  const kept = readFileSync(file, 'utf8');
  assert.equal(kept.includes(oldLine), false, '40 天前的行应被删除');
  assert.equal(kept.includes(freshLine), true, '1 天前的行应保留');
  assert.equal(kept.includes(badLine), true, '坏行应保留');

  // 幂等：再跑一次没有可删内容
  assert.equal(pruneRouteLogFile(file, 30, now), 0);
  rmSync(dir, { recursive: true, force: true });
});

test('pruneRouteLogFile：文件不存在 / 参数非法时返回 0 不抛错', () => {
  assert.equal(pruneRouteLogFile(join(tmpdir(), 'mrrp-no-such-' + Date.now() + '.log'), 30), 0);
  assert.equal(pruneRouteLogFile('', 30), 0);
  assert.equal(pruneRouteLogFile('/some/path.log', 0), 0);
  assert.equal(pruneRouteLogFile('/some/path.log', -1), 0);
});

test('routeLogFileName / routeLogPathFor：按天命名 route-decision-YYYY-MM-DD.log', () => {
  assert.equal(routeLogFileName(new Date(2026, 10, 4)), 'route-decision-2026-11-04.log');
  assert.equal(routeLogFileName(new Date(2026, 0, 9)), 'route-decision-2026-01-09.log');
  assert.equal(routeLogPathFor('C:/logs', new Date(2026, 6, 1)), join('C:/logs', 'route-decision-2026-07-01.log'));
});

test('pruneRouteLogDir：删除超过保留天数的按天文件，保留近期文件与无关文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-prune-dir-'));
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const old = join(dir, routeLogFileName(new Date(now - 40 * day)));
  const fresh = join(dir, routeLogFileName(new Date(now - 1 * day)));
  const today = join(dir, routeLogFileName(new Date(now)));
  const other = join(dir, 'unrelated.txt');
  writeFileSync(old, 'x\n');
  writeFileSync(fresh, 'x\n');
  writeFileSync(today, 'x\n');
  writeFileSync(other, 'x\n');

  const removed = pruneRouteLogDir(dir, 30, now);
  assert.equal(removed, 1, '只删除 40 天前的按天文件');
  assert.equal(readFileSync(fresh, 'utf8'), 'x\n');
  assert.equal(readFileSync(today, 'utf8'), 'x\n');
  assert.equal(readFileSync(other, 'utf8'), 'x\n');

  // 目录不存在 / 参数非法返回 0
  assert.equal(pruneRouteLogDir(join(dir, 'nope'), 30), 0);
  assert.equal(pruneRouteLogDir('', 30), 0);
  rmSync(dir, { recursive: true, force: true });
});
