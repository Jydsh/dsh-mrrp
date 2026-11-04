import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, name, inject } from '../dist/index.js';

// 模拟 DSH host 的 ctx：connection.fetch.register + llm 只读发现 + effect/provide。
function makeHost({ providers, models } = {}) {
  const registrations = [];
  const provided = {};
  const effects = [];
  const llm = {
    listProviders: () => (providers ?? []),
    listModels: async (pid) => (models ?? []).filter((m) => m.provider === pid),
  };
  const ctx = {
    llm,
    connection: {
      fetch: {
        register: (opts) => {
          registrations.push(opts);
          return () => { /* dispose */ };
        },
      },
    },
    inject: (deps, fn) => {
      // 触发一次注入回调（携带 connection 上下文）
      fn({ connection: ctx.connection });
    },
    effect: (fn, tag) => effects.push({ fn, tag }),
    provide: (k, v) => { provided[k] = v; },
    logger: () => console,
  };
  return { ctx, registrations, provided, effects };
}

let handler;      // 注册后的 /api/mrrp fetch 处理器
let registrations;
let provided;
let store;
let imSenders;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-rpc-'));
  // 注入内存 fake dsh-im 读取器：用例通过 insertImSender 填充，不依赖真实用户文件系统。
  const imSendersLocal = new Map();
  const fakeIm = {
    async readSenders() {
      let i = 0;
      return [...imSendersLocal.entries()].map(([senderId, senderName]) => ({ senderId, senderName, lastAt: ++i, count: 1, source: 'test' }));
    },
    async resolveName(senderId) { return imSendersLocal.get(senderId) ?? null; },
  };
  imSenders = imSendersLocal;
  const host = makeHost({
    providers: [{ id: 'dashscope' }, { id: 'ollama' }],
    models: [
      { provider: 'dashscope', id: 'qwen-max', name: 'Qwen Max' },
      { provider: 'ollama', id: 'deepseek-r1', name: 'DeepSeek R1' },
    ],
  });
  registrations = host.registrations;
  provided = host.provided;
  await apply(host.ctx, { configPath: join(dir, 'config.json'), im: fakeIm, autoSyncIm: false });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].path, '/api/mrrp');
  assert.deepEqual(registrations[0].methods, ['POST']);
  handler = registrations[0].fetch;
});

function insertImSender(id, name) {
  imSenders.set(id, name);
}

function makeRequest(message) {
  return {
    method: 'POST',
    headers: { get: () => 'application/json' },
    async json() { return message; },
  };
}

async function rpc(method, payload, rpcId = 'r1') {
  const res = await handler(makeRequest({ type: 'client-request', rpcId, method: 'mrrp', payload: { method, payload } }));
  const body = await res.json();
  assert.equal(body.type, 'server-response');
  assert.equal(body.rpcId, rpcId);
  return body.result;
}

test('插件导出：name / inject', () => {
  assert.equal(name, 'dsh-mrrp');
  assert.deepEqual(inject, ['connection', 'llm']);
});

test('非 JSON content-type 返回 415', async () => {
  const res = await handler({ method: 'POST', headers: { get: () => 'text/plain' }, async json() { return {}; } });
  assert.equal(res.status, 415);
});

test('status 返回统计与模型发现状态', async () => {
  const r = await rpc('status');
  assert.equal(r.ok, true);
  assert.equal(r.value.providers, 2);
  assert.equal(r.value.models, 2);
  assert.equal(r.value.categories, 1); // 默认分类
  assert.equal(r.value.llmError, null);
});

test('providers.list / models.list 只读发现', async () => {
  const rp = await rpc('providers.list');
  assert.deepEqual(rp.value.providers.map((p) => p.id), ['dashscope', 'ollama']);
  const rm = await rpc('models.list');
  assert.equal(rm.value.models.length, 2);
  assert.ok(rm.value.models.every((m) => typeof m.key === 'string'));
});

test('categories.create 重复名返回 duplicate-name', async () => {
  const a = await rpc('categories.create', { name: '测试分类', desc: 'x' });
  assert.equal(a.ok, true);
  const id = a.value.category.id;
  const b = await rpc('categories.create', { name: '测试分类' });
  assert.equal(b.ok, false);
  assert.equal(b.error.code, 'duplicate-name');
  return { id };
});

test('categories.bind 同一模型只属于一个分类（从其它分类移除）', async () => {
  const a1 = await rpc('categories.create', { name: '绑定测试A' });
  const id = a1.value.category.id;
  const r2 = await rpc('categories.create', { name: '绑定测试B' });
  const catB = r2.value.category.id;
  await rpc('categories.bind', { id, modelIds: ['dashscope:qwen-max'] });
  await rpc('categories.bind', { id: catB, modelIds: ['dashscope:qwen-max'] });
  const list = await rpc('categories.list');
  const a = list.value.categories.find((c) => c.id === id);
  const b = list.value.categories.find((c) => c.id === catB);
  assert.ok(!a.modelIds.includes('dashscope:qwen-max'));
  assert.ok(b.modelIds.includes('dashscope:qwen-max'));
});

test('categories.delete 默认分类受保护', async () => {
  const list = await rpc('categories.list');
  const def = list.value.categories.find((c) => c.isDefault);
  const r = await rpc('categories.delete', { id: def.id });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'default-protected');
});

test('route.get / route.save 往返', async () => {
  const g = await rpc('route.get');
  assert.equal(g.ok, true);
  assert.equal(g.value.route.strategy, 'category');
  const s = await rpc('route.save', { route: { lb: 'weighted', timeoutMs: 30000 } });
  assert.equal(s.value.route.lb, 'weighted');
  assert.equal(s.value.route.timeoutMs, 30000);
});

test('route.save 携带 imRoute（IM 消息路由配置）往返与清洗', async () => {
  const s = await rpc('route.save', {
    route: {
      imRoute: {
        enabled: true,
        decisionProviderId: 'dp_1',
        questions: {
          department: { type: 'choice', instructions: '判断部门', criteria: { ops: '运维', sales: '销售' } },
          bad: { type: 'nope' }, // 非法 type 被清洗为 noul
        },
        rules: [
          { field: 'department', value: 'ops', categoryId: 'cat_x' },
          { field: 'department', value: '', categoryId: 'cat_y' },
          { field: '', value: 'x', categoryId: 'cat_x' }, // 缺 field -> 丢弃
        ],
        fallbackModel: 'dashscope:qwen-max',
        unknownUser: 'fallback',
        channels: ['dingtalk', 'wecom'],
      },
    },
  });
  assert.equal(s.ok, true);
  const im = s.value.route.imRoute;
  assert.equal(im.enabled, true);
  assert.equal(im.decisionProviderId, 'dp_1');
  assert.equal(im.questions.department.type, 'choice');
  assert.equal(im.questions.bad.type, 'noul');
  assert.equal(im.rules.length, 2);
  assert.equal(im.rules[0].value, 'ops');
  assert.equal(im.rules[1].value, '');
  assert.equal(im.fallbackModel, 'dashscope:qwen-max');
  assert.equal(im.unknownUser, 'fallback');
  assert.deepEqual(im.channels, ['dingtalk', 'wecom']);
  // 缺省 channels 时默认钉钉
  const d = await rpc('route.save', { route: { imRoute: { enabled: false, decisionProviderId: '', questions: {}, rules: [], fallbackModel: '', unknownUser: 'ignore' } } });
  assert.deepEqual(d.value.route.imRoute.channels, ['dingtalk']);
  assert.equal(d.value.route.imRoute.enabled, false);
  assert.equal(d.value.route.imRoute.unknownUser, 'ignore');
});

test('route.im.status 返回引擎订阅状态（测试 host 无 ctx.on -> 未订阅）', async () => {
  const r = await rpc('route.im.status');
  assert.equal(r.ok, true);
  assert.equal(r.value.subscribed, false);
  assert.equal(r.value.enabled, false);
  assert.ok(Number.isInteger(r.value.mappedCount));
});

test('roles / depts / users 列表与保存', async () => {
  const roles = await rpc('roles.save', { roles: [{ id: 'role_r', name: '调度员', deptIds: [], categoryBindings: [] }] });
  assert.equal(roles.ok, true);
  const depts = await rpc('depts.save', { depts: [{ id: 'dept_d', name: '调度中心', roleIds: ['role_r'] }] });
  assert.equal(depts.ok, true);
  const users = await rpc('users.save', { users: [{ id: 'usr_u', name: '何工', roleId: 'role_r', deptIds: ['dept_d'] }] });
  assert.equal(users.ok, true);
  const lu = await rpc('users.list');
  assert.equal(lu.value.users.length, 1);
  assert.equal(lu.value.users[0].name, '何工');
  assert.equal(lu.value.roles.length, 1);
  assert.equal(lu.value.depts.length, 1);
});

test('角色 ↔ 部门双向绑定同步（部门侧配置角色 → 角色侧自动显示）', async () => {
  await rpc('roles.save', { roles: [{ id: 'role_a', name: '安全员', deptIds: [], categoryBindings: [] }] });
  const saved = await rpc('depts.save', { depts: [{ id: 'dept_x', name: '安全科', roleIds: ['role_a'] }] });
  assert.equal(saved.ok, true);
  const roles = await rpc('roles.list');
  const roleA = roles.value.roles.find((r) => r.id === 'role_a');
  assert.deepEqual(roleA.deptIds, ['dept_x']);
  const deptX = roles.value.depts.find((d) => d.id === 'dept_x');
  assert.deepEqual(deptX.roleIds, ['role_a']);
});

test('角色 ↔ 部门双向绑定同步（角色侧配置部门 → 部门侧自动显示）', async () => {
  await rpc('depts.save', { depts: [{ id: 'dept_y', name: '运维科', roleIds: [] }] });
  const saved = await rpc('roles.save', { roles: [{ id: 'role_b', name: '运维员', deptIds: ['dept_y'], categoryBindings: [] }] });
  assert.equal(saved.ok, true);
  const lr = await rpc('roles.list');
  const deptY = lr.value.depts.find((d) => d.id === 'dept_y');
  assert.deepEqual(deptY.roleIds, ['role_b']);
});

test('部门树：depts.list 返回 users；删除父部门后子部门提升为顶级', async () => {
  await rpc('depts.save', { depts: [
    { id: 'dept_root', name: '总部', parentId: '', roleIds: [] },
    { id: 'dept_sub', name: '调度中心', parentId: 'dept_root', roleIds: [] },
    { id: 'dept_leaf', name: '调度一组', parentId: 'dept_sub', roleIds: [] },
  ] });
  await rpc('users.save', { users: [{ id: 'usr_tree', name: '树用户', roleId: '', deptIds: ['dept_sub'] }] });
  const ld = await rpc('depts.list');
  assert.ok(Array.isArray(ld.value.users)); // depts.list 返回 users（用于显示部门内用户）
  assert.equal(ld.value.users.some((u) => u.id === 'usr_tree'), true);
  assert.equal(ld.value.depts.find((d) => d.id === 'dept_sub').parentId, 'dept_root');
  // 删除父部门：子部门 parentId 悬空 → host 自动提升为顶级
  await rpc('depts.save', { depts: [
    { id: 'dept_sub', name: '调度中心', parentId: '', roleIds: [] },
    { id: 'dept_leaf', name: '调度一组', parentId: 'dept_sub', roleIds: [] },
  ] });
  const ld2 = await rpc('depts.list');
  assert.equal(ld2.value.depts.find((d) => d.id === 'dept_sub').parentId, '');
});

test('部门树：循环上级引用被拒绝', async () => {
  const r = await rpc('depts.save', { depts: [
    { id: 'dept_c1', name: '甲', parentId: 'dept_c2', roleIds: [] },
    { id: 'dept_c2', name: '乙', parentId: 'dept_c1', roleIds: [] },
  ] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid-dept-cycle');
});

test('删除部门 / 角色后清理用户引用', async () => {
  await rpc('roles.save', { roles: [{ id: 'role_c', name: '待删角色', deptIds: [], categoryBindings: [] }] });
  await rpc('depts.save', { depts: [{ id: 'dept_z', name: '待删部门', roleIds: ['role_c'] }] });
  await rpc('users.save', { users: [{ id: 'usr_v', name: '测试员', roleId: 'role_c', deptIds: ['dept_z'] }] });
  await rpc('depts.save', { depts: [] });
  const lr = await rpc('roles.list');
  assert.deepEqual(lr.value.depts, []);
  await rpc('roles.save', { roles: [] });
  const lu = await rpc('users.list');
  assert.equal(lu.value.users[0].roleId, '');
  assert.deepEqual(lu.value.users[0].deptIds, []);
});

test('users.resolve：按 senderId 解析姓名（create:false 不建用户）', async () => {
  insertImSender('ou_aaa', '张三');
  const r = await rpc('users.resolve', { senderId: 'ou_aaa', create: false });
  assert.equal(r.value.name, '张三');
  assert.equal(r.value.created, false);
  assert.equal(r.value.user, null);
  // create:false 时不创建；但 users.list 的自动同步仍会把该 sender 补进用户表（预期行为）
  const lu = await rpc('users.list');
  assert.equal(lu.value.users.some((u) => u.id === 'ou_aaa'), true);
  assert.equal(lu.value.users.find((u) => u.id === 'ou_aaa').name, '张三');
});

test('users.resolve：首次 senderId 自动创建用户，再次解析返回既有用户', async () => {
  insertImSender('ou_bbb', '李四');
  const r1 = await rpc('users.resolve', { senderId: 'ou_bbb' });
  assert.equal(r1.value.created, true);
  assert.equal(r1.value.user.id, 'ou_bbb');
  assert.equal(r1.value.user.name, '李四');
  const r2 = await rpc('users.resolve', { senderId: 'ou_bbb' });
  assert.equal(r2.value.created, false);
  assert.equal(r2.value.user.id, 'ou_bbb');
});

test('users.resolve 不带 senderId：返回 dsh-im 发送者列表', async () => {
  const r = await rpc('users.resolve', {});
  assert.ok(Array.isArray(r.value.senders));
  assert.ok(r.value.senders.some((s) => s.senderId === 'ou_aaa'));
});

test('users.syncIm：自动创建缺失用户', async () => {
  insertImSender('ou_ccc', '王五');
  const r = await rpc('users.syncIm', {});
  assert.equal(r.value.created, 1);
  const found = r.value.users.find((u) => u.id === 'ou_ccc');
  assert.equal(found.name, '王五');
});

test('users.list 自动同步 dsh-im 新发送者', async () => {
  insertImSender('ou_ddd', '赵六');
  const r = await rpc('users.list', {});
  const found = r.value.users.find((u) => u.id === 'ou_ddd');
  assert.equal(found.name, '赵六');
});

test('用户 ID 保留任意 senderId（不强制 usr_ 前缀）', async () => {
  const saved = await rpc('users.save', { users: [{ id: 'staff_AB-12', name: '测试员', roleId: '', deptIds: [] }] });
  assert.equal(saved.ok, true);
  const lu = await rpc('users.list');
  const found = lu.value.users.find((u) => u.id === 'staff_AB-12');
  assert.equal(found.name, '测试员');
});

test('sidebar-entry 设置 show/hide/auto', async () => {
  const s = await rpc('sidebar-entry.set', { mode: 'show' });
  assert.equal(s.value.visible, true);
  const h2 = await rpc('sidebar-entry.set', { mode: 'hide' });
  assert.equal(h2.value.visible, false);
  const g = await rpc('sidebar-entry.get');
  assert.equal(g.value.mode, 'hide');
});

test('未知方法返回 unknown-method', async () => {
  const r = await rpc('no.such.method');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unknown-method');
});

test('config.get 返回可序列化配置', async () => {
  const r = await rpc('config.get');
  assert.equal(r.ok, true);
  assert.equal(r.value.config.version, 1);
});

test('apply 提供 dshMrrpClient', () => {
  assert.ok(provided.dshMrrpClient);
  assert.equal(provided.dshMrrpClient.version, 1);
});

test('decision.save / list / delete 提供方增删查', async () => {
  const saved = await rpc('decision.save', {
    provider: { id: '', name: 'Laya 本地', format: 'laya', baseUrl: 'http://127.0.0.1:8000', apiKey: '', modelNames: ['english'], categoryId: '', enabled: true },
  });
  assert.equal(saved.ok, true);
  const id = saved.value.provider.id;
  assert.match(id, /^dp_/);
  const listed = await rpc('decision.list');
  assert.equal(listed.value.providers.length, 1);
  assert.equal(listed.value.providers[0].name, 'Laya 本地');
  // 更新同一 id
  const updated = await rpc('decision.save', {
    provider: { id, name: 'Laya 改名', format: 'laya', baseUrl: 'http://127.0.0.1:8000', modelNames: ['english', 'multilingual'] },
  });
  assert.equal(updated.value.provider.id, id);
  assert.equal(updated.value.provider.name, 'Laya 改名');
  const del = await rpc('decision.delete', { id });
  assert.equal(del.ok, true);
  const after = await rpc('decision.list');
  assert.equal(after.value.providers.length, 0);
});

test('decision.save 非法提供方返回 bad-request', async () => {
  const r = await rpc('decision.save', { provider: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad-request');
});

test('decision.fetch laya 返回内置检查点 manual=true', async () => {
  const r = await rpc('decision.fetch', {
    provider: { format: 'laya', baseUrl: 'http://127.0.0.1:8000', apiKey: '' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.manual, true);
  assert.ok(r.value.models.some((m) => m.id === 'english'));
  assert.ok(r.value.models.some((m) => m.id === 'typed-decisions'));
});

test('decision.fetch 非法地址提示协议', async () => {
  const r = await rpc('decision.fetch', { provider: { format: 'openai', baseUrl: 'localhost:8000' } });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /http/);
});
