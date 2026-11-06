import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDecisionSlots,
  decisionPoolConfig,
  DecisionScheduler,
  defaultDecisionScheduler,
  slotKeyOf,
} from '../dist/decision-pool.js';
import { createDecisionRunner } from '../dist/route-engine.js';
import { sanitizeImRoute } from '../dist/store.js';

/** 决策提供方最小对象。 */
function provider(id, extra = {}) {
  return {
    id,
    name: id,
    format: 'laya',
    endpoint: 'systemone',
    baseUrl: `http://${id}:8000`,
    apiKey: '',
    modelNames: [],
    categoryId: '',
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

/** 最小插件配置（含路由 + imRoute 决策提供方）。 */
function makeConfig(providers, pool = {}) {
  return {
    version: 1,
    route: {
      active: true,
      strategy: 'category',
      lb: 'round-robin',
      weights: {},
      fallback: 'random',
      timeoutMs: 60000,
      retries: 0,
      failover: true,
      imRoute: {
        enabled: true,
        decisionProviderId: providers[0]?.id ?? '',
        decisionProviderIds: providers.map((item) => item.id),
        decisionPool: {
          enabled: true,
          defaultLimit: 1,
          queueTimeoutMs: 8000,
          sticky: true,
          primaryProviderId: '',
          primaryModel: '',
          limits: {},
          weights: {},
          ...pool,
        },
        questions: {},
        rules: [],
        fallbackModel: 'dashscope:qwen-max',
        unknownUser: 'ignore',
        channels: ['dingtalk'],
      },
    },
    categories: [],
    roles: [],
    depts: [],
    users: [],
    sidebar: { mode: 'auto' },
    decisionProviders: providers,
    userDefaults: { roleId: '' },
    modelProfiles: {},
    typeSceneList: [],
    logRetentionDays: 30,
  };
}

test('buildDecisionSlots：同一 API 下的多个模型各自成槽，本地 laya 只占一槽', () => {
  // generic 提供方填了 2 个模型名 → 2 个槽；laya 提供方 → 1 个槽（请求不带 model）
  const cfg = makeConfig([
    provider('dp_cloud', { format: 'generic', modelNames: ['m1', 'm2'] }),
    provider('dp_laya'),
  ]);
  const slots = buildDecisionSlots(cfg, ['dp_cloud', 'dp_laya']);
  assert.deepEqual(slots.map((slot) => slot.key), ['dp_cloud::m1', 'dp_cloud::m2', 'dp_laya::']);
  assert.equal(slots[0].limit, 1, '默认每模型并发上限 1');
  assert.equal(slots[0].weight, 1, '默认权重 1');
});

test('buildDecisionSlots：并发上限 / 权重 / 主用按 providerId::model 覆盖', () => {
  const cfg = makeConfig(
    [provider('dp_cloud', { format: 'openai', modelNames: ['big', 'small'] })],
    {
      defaultLimit: 1,
      limits: { 'dp_cloud::big': 2, 'dp_cloud::small': 8 },
      weights: { 'dp_cloud::small': 3 },
      primaryProviderId: 'dp_cloud',
      primaryModel: 'big',
    },
  );
  const slots = buildDecisionSlots(cfg, ['dp_cloud']);
  const big = slots.find((slot) => slot.key === 'dp_cloud::big');
  const small = slots.find((slot) => slot.key === 'dp_cloud::small');
  assert.equal(big.limit, 2);
  assert.equal(small.limit, 8, '弱模型可给更高上限吃点小任务');
  assert.equal(small.weight, 3);
  assert.equal(big.primary, true, '主用槽标记');
  assert.equal(small.primary, false);
  assert.equal(slotKeyOf('dp_cloud', 'big'), 'dp_cloud::big');
});

test('决策池配置清洗：非法值回落默认，limits/weights 只保留整数', () => {
  const pool = sanitizeImRoute({
    enabled: true,
    decisionPool: {
      enabled: 'yes',
      defaultLimit: 999,
      queueTimeoutMs: -5,
      sticky: 'no',
      primaryProviderId: '  dp_a  ',
      limits: { 'dp_a::': 3, '': 2, 'dp_b::': 'x' },
      weights: { 'dp_a::': 99 },
    },
  }).decisionPool;
  assert.equal(pool.enabled, true, '非布尔回落默认 true');
  assert.equal(pool.defaultLimit, 32, '上限截断');
  assert.equal(pool.queueTimeoutMs, 0, '负数截断到 0');
  assert.equal(pool.sticky, true, '非布尔回落默认 true');
  assert.equal(pool.primaryProviderId, 'dp_a');
  assert.deepEqual(pool.limits, { 'dp_a::': 3 }, '空键与非数字丢弃');
  assert.deepEqual(pool.weights, { 'dp_a::': 5 }, '权重截断到 5');
  assert.equal(decisionPoolConfig({}).queueTimeoutMs, 8000, '缺省排队上限 8s');
});

test('并发分流：两个槽各接一个请求，第三个排队超时返回 null', async () => {
  const scheduler = new DecisionScheduler();
  const cfg = makeConfig([provider('dp_a'), provider('dp_b')]);
  const slots = buildDecisionSlots(cfg, ['dp_a', 'dp_b']);

  const first = await scheduler.acquire(slots, { queueTimeoutMs: 0 });
  const second = await scheduler.acquire(slots, { queueTimeoutMs: 0 });
  assert.ok(first && second);
  assert.notEqual(first.slot.key, second.slot.key, '两个请求落到不同槽（不排队）');

  const started = Date.now();
  const third = await scheduler.acquire(slots, { queueTimeoutMs: 60 });
  assert.equal(third, null, '全部满额且排队超时 → null（上层落兜底）');
  assert.ok(Date.now() - started >= 50, '确实等待了排队时长');

  scheduler.release(first.slot, { ok: true });
  const fourth = await scheduler.acquire(slots, { queueTimeoutMs: 60 });
  assert.ok(fourth, '释放空位后立刻能接上');
  assert.equal(fourth.slot.key, first.slot.key);
  scheduler.reset();
});

test('忙了自动换空闲：某槽在途未满上限时才可选，满额自动跳过', async () => {
  const scheduler = new DecisionScheduler();
  // dp_a 上限 1、dp_b 上限 1：a 被占后新请求只能去 b
  const cfg = makeConfig([provider('dp_a'), provider('dp_b')], { limits: { 'dp_a::': 1 } });
  const slots = buildDecisionSlots(cfg, ['dp_a', 'dp_b']);
  const held = await scheduler.acquire(slots, { queueTimeoutMs: 0, sticky: false });
  assert.equal(held.slot.key, 'dp_a::');
  const next = await scheduler.acquire(slots, { queueTimeoutMs: 0, sticky: false });
  assert.equal(next.slot.key, 'dp_b::', '第一个模型在忙 → 自动换空闲的');
  scheduler.reset();
});

test('全部满额时排队等待，空位释放后接手（waitMs > 0）', async () => {
  const scheduler = new DecisionScheduler();
  const cfg = makeConfig([provider('dp_a'), provider('dp_b')]);
  const slots = buildDecisionSlots(cfg, ['dp_a', 'dp_b']);
  const a = await scheduler.acquire(slots, { queueTimeoutMs: 0 });
  const b = await scheduler.acquire(slots, { queueTimeoutMs: 0 });
  assert.ok(a && b);
  setTimeout(() => scheduler.release(a.slot, { ok: true }), 30);
  const waited = await scheduler.acquire(slots, { queueTimeoutMs: 200 });
  assert.ok(waited, '排队等到空位');
  assert.ok(waited.waitMs >= 20, `排队时长被记录（${waited.waitMs}ms）`);
  assert.equal(waited.slot.key, 'dp_a::');
  scheduler.reset();
});

test('主用槽只作优先级：同等空闲时先选主用，不强制独占', async () => {
  const scheduler = new DecisionScheduler();
  const cfg = makeConfig([provider('dp_a'), provider('dp_b')], {
    primaryProviderId: 'dp_b',
    primaryModel: '',
  });
  const slots = buildDecisionSlots(cfg, ['dp_a', 'dp_b']);
  const first = await scheduler.acquire(slots, { queueTimeoutMs: 0, sticky: false });
  assert.equal(first.slot.key, 'dp_b::', '主用空闲时优先');
  const second = await scheduler.acquire(slots, { queueTimeoutMs: 0, sticky: false });
  assert.equal(second.slot.key, 'dp_a::', '主用已忙 → 分流给其它空闲模型');
  scheduler.reset();
});

test('会话粘性：同一会话优先复用上次成功的槽，关闭粘性则重新挑', async () => {
  const scheduler = new DecisionScheduler();
  const cfg = makeConfig([provider('dp_a'), provider('dp_b')]);
  const slots = buildDecisionSlots(cfg, ['dp_a', 'dp_b']);
  const a = await scheduler.acquire(slots, { sessionKey: 'user-1', queueTimeoutMs: 0 });
  assert.equal(a.slot.key, 'dp_a::');
  scheduler.release(a.slot, { ok: true, sessionKey: 'user-1' });
  // dp_b 更久未用（LRU 本会选 b），但粘性把同一会话拉回 a
  const again = await scheduler.acquire(slots, { sessionKey: 'user-1', queueTimeoutMs: 0 });
  assert.equal(again.slot.key, 'dp_a::', '同会话固定同模型，避免判定口径飘');
  scheduler.release(again.slot, { ok: true, sessionKey: 'user-1' });
  const noSticky = await scheduler.acquire(slots, { sessionKey: 'user-1', sticky: false, queueTimeoutMs: 0 });
  assert.equal(noSticky.slot.key, 'dp_b::', '关闭粘性后按最少在途重新挑');
  scheduler.reset();
});

test('权重：相同在途数下，权重高的槽利用率更低、更能被选中', async () => {
  const scheduler = new DecisionScheduler();
  const cfg = makeConfig([provider('dp_a'), provider('dp_b')], {
    defaultLimit: 2,
    weights: { 'dp_a::': 1, 'dp_b::': 2 },
  });
  const slots = buildDecisionSlots(cfg, ['dp_a', 'dp_b']);
  // 各占一个在途 → 利用率 a = 1/2/1 = 0.5，b = 1/2/2 = 0.25 → 再挑一定选 b
  const a1 = await scheduler.acquire(slots, { queueTimeoutMs: 0, sticky: false });
  const b1 = await scheduler.acquire(slots, { queueTimeoutMs: 0, sticky: false });
  assert.deepEqual([a1.slot.key, b1.slot.key], ['dp_a::', 'dp_b::']);
  const next = await scheduler.acquire(slots, { queueTimeoutMs: 0, sticky: false });
  assert.equal(next.slot.key, 'dp_b::', '权重高的槽胜出');
  scheduler.reset();
});

test('createDecisionRunner：模型失败后换下一个空闲槽，并给失败槽冷却', async () => {
  const scheduler = new DecisionScheduler();
  const cfg = makeConfig([provider('dp_a'), provider('dp_b')]);
  const calls = [];
  const runner = createDecisionRunner({
    getConfig: () => cfg,
    scheduler,
    execute: async (prov) => {
      calls.push(prov.id);
      if (prov.id === 'dp_a') throw new Error('a down');
      return { model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } };
    },
  });
  const opts = { providerIds: ['dp_a', 'dp_b'], state: 'hi', questions: {}, sessionKey: 'u1' };

  const r1 = await runner.run(opts);
  assert.ok(r1);
  assert.equal(r1.providerId, 'dp_b');
  assert.equal(r1.failover, true, '首个失败后自动换下一个');
  assert.equal(r1.model, '', '本地 laya 槽不带模型名');

  // 冷却期内不再打 dp_a：第二次直接 dp_b，且不算故障转移
  const r2 = await runner.run(opts);
  assert.equal(r2.providerId, 'dp_b');
  assert.equal(r2.failover, false);
  assert.deepEqual(calls, ['dp_a', 'dp_b', 'dp_b']);
  scheduler.reset();
});

test('createDecisionRunner：关闭并发调度时回到按提供方轮询', async () => {
  const scheduler = new DecisionScheduler();
  const cfg = makeConfig([provider('dp_a'), provider('dp_b')], { enabled: false });
  const calls = [];
  const runner = createDecisionRunner({
    getConfig: () => cfg,
    scheduler,
    execute: async (prov) => {
      calls.push(prov.id);
      if (prov.id === 'dp_a') throw new Error('a down');
      return { model: { response: { type: 'choice', choice: 'ollama:deepseek-r1' } } };
    },
  });
  const opts = { providerIds: ['dp_a', 'dp_b'], state: 'hi', questions: {} };
  const r1 = await runner.run(opts);
  assert.equal(r1.providerId, 'dp_b');
  assert.equal(r1.failover, true);
  const r2 = await runner.run(opts);
  assert.equal(r2.providerId, 'dp_b');
  assert.equal(r2.failover, false);
  assert.deepEqual(calls, ['dp_a', 'dp_b', 'dp_b'], '轮询起始轮转 + 顺序故障转移');
  scheduler.reset();
});

test('全局调度器可 reset，供生产进程与测试隔离状态', () => {
  defaultDecisionScheduler.reset();
  const cfg = makeConfig([provider('dp_a')]);
  const slots = buildDecisionSlots(cfg, ['dp_a']);
  assert.equal(defaultDecisionScheduler.stats(slots)[0].inflight, 0);
});
