import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchProviderModels, testProvider, makeLayaDecide, defaultLayaQuestions } from '../dist/decision.js';

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
