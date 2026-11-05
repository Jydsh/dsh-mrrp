import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchProviderModels, testProvider, makeLayaDecide, openaiChatDecide, extractChatChoice, defaultLayaQuestions } from '../dist/decision.js';

// 用 stub fetch 验证 URL / 请求体构造，不发真实网络。
function withFetch(fn, calls) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ id: 'qwen-max' }], ok: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try { return fn(); } finally { globalThis.fetch = original; }
}

test('laya systemone 端点：POST /v1/systemone，无 model 字段', async () => {
  const calls = [];
  await withFetch(async () => {
    const r = await testProvider({ format: 'laya', endpoint: 'systemone', baseUrl: 'http://127.0.0.1:8000' });
    assert.equal(r.ok, true);
  }, calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/v1/systemone');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, undefined);
  assert.ok(body.questions.reachable);
});

test('laya decisions 端点：POST /v1/decisions，自动带 model: laya 与 Bearer', async () => {
  const calls = [];
  await withFetch(async () => {
    const r = await testProvider({ format: 'laya', endpoint: 'decisions', baseUrl: 'https://router-api.0g.ai', apiKey: 'sk-test' });
    assert.equal(r.ok, true);
  }, calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://router-api.0g.ai/v1/decisions');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'laya');
  assert.match(calls[0].init.headers.authorization, /Bearer sk-test/);
});

test('makeLayaDecide decisions 端点返回原始响应', async () => {
  const calls = [];
  const fn = makeLayaDecide(() => ({ baseUrl: 'https://router-api.0g.ai', apiKey: 'sk-test', endpoint: 'decisions' }));
  const out = await withFetch(() => fn({ state: 'test', questions: { q: { type: 'noul' } } }), calls);
  assert.ok(out);
  assert.equal(calls[0].url, 'https://router-api.0g.ai/v1/decisions');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'laya');
  assert.equal(body.state, 'test');
  assert.equal(body.questions.q.type, 'noul');
});

test('makeLayaDecide 缺省端点走 systemone', async () => {
  const calls = [];
  const fn = makeLayaDecide(() => ({ baseUrl: 'http://127.0.0.1:8000', apiKey: '' }));
  await withFetch(() => fn({ state: 'x' }), calls);
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/v1/systemone');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, undefined);
  assert.ok(body.questions.verdict);
});

test('makeLayaDecide 缺 state 抛错，未配置提供方抛指引', async () => {
  const fn = makeLayaDecide(() => null);
  await assert.rejects(() => fn({}), /state 必填/);
  await assert.rejects(() => fn({ state: 'x' }), /MRRP 控制台/);
});

test('默认问题为一个简单 choice（yes/no）', () => {
  const q = defaultLayaQuestions();
  assert.ok(q.verdict);
  assert.equal(q.verdict.type, 'choice');
  assert.ok(q.verdict.criteria.yes && q.verdict.criteria.no);
});

test('makeLayaDecide：OpenAI 兼容提供方 systemone 请求体带判定模型名', async () => {
  const calls = [];
  const fn = makeLayaDecide(() => ({ baseUrl: 'https://llm-xxx.aliyuncs.com/compatible-mode', apiKey: 'sk-test', endpoint: 'systemone', model: 'decision-model-preview' }));
  const out = await withFetch(() => fn({ state: 'T-1001 订单未到账', questions: { department: { type: 'choice', instructions: '归谁', criteria: { billing: '支付', technical: '故障' } } } }), calls);
  assert.ok(out);
  assert.equal(calls[0].url, 'https://llm-xxx.aliyuncs.com/compatible-mode/v1/systemone');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'decision-model-preview');
  assert.equal(body.state, 'T-1001 订单未到账');
  assert.equal(body.questions.department.type, 'choice');
  assert.match(calls[0].init.headers.authorization, /Bearer sk-test/);
});

test('makeLayaDecide：decisions 端点请求体 model 可被提供方模型名覆盖', async () => {
  const calls = [];
  const fn = makeLayaDecide(() => ({ baseUrl: 'https://router-api.0g.ai', apiKey: 'sk', endpoint: 'decisions', model: 'decision-model-preview' }));
  await withFetch(() => fn({ state: 'x' }), calls);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'decision-model-preview', '提供方指定模型名优先于默认 laya');
});

test('openaiChatDecide：OpenAI 兼容对话判定请求与标准化解析', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"choice":"ollama:deepseek-r1","reasoning":"深度推理"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const fn = openaiChatDecide(() => ({ baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-test', model: 'deepseek-ai/DeepSeek-R1' }));
    const out = await fn({ state: '写代码', questions: { model: { type: 'choice', instructions: '选模型', criteria: { a: 'x', b: 'y' } } } });
    assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/chat/completions');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'deepseek-ai/DeepSeek-R1');
    assert.equal(body.temperature, 0);
    assert.ok(body.messages[0].content.includes('只输出一个严格 JSON'), 'system 提示词要求 JSON 判定输出');
    assert.ok(body.messages[1].content.includes('写代码'));
    // 标准化 Laya 判定形状：answers.model.choice 供上层直接复用
    assert.equal(out.answers.model.type, 'choice');
    assert.equal(out.answers.model.choice, 'ollama:deepseek-r1');
    assert.equal(out.answers.model.reasoning, '深度推理');
  } finally { globalThis.fetch = original; }
});

test('openaiChatDecide：围栏 JSON、正则兜底与无 choice 抛错', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"choice":"b","reasoning":"快"}\n```' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const fn = openaiChatDecide(() => ({ baseUrl: 'http://x', apiKey: '', model: 'm' }));
    const out = await fn({ state: 's' });
    assert.equal(out.answers.model.choice, 'b');
  } finally { globalThis.fetch = original; }

  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '我选 "choice": "c" 因为快' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const fn = openaiChatDecide(() => ({ baseUrl: 'http://x', apiKey: '', model: 'm' }));
    const out = await fn({ state: 's' });
    assert.equal(out.answers.model.choice, 'c');
  } finally { globalThis.fetch = original; }

  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '抱歉无法判断' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const fn = openaiChatDecide(() => ({ baseUrl: 'http://x', apiKey: '', model: 'm' }));
    await assert.rejects(() => fn({ state: 's' }), /判定输出未包含有效 choice/);
  } finally { globalThis.fetch = original; }
});

test('extractChatChoice：直接解析纯 JSON 输出', () => {
  const { choice, reasoning } = extractChatChoice({ choices: [{ message: { content: '{"choice":"a","reasoning":"r"}' } }] });
  assert.equal(choice, 'a');
  assert.equal(reasoning, 'r');
});
