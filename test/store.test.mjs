import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_CATEGORIES,
  DEFAULT_CONFIG,
  sanitizeConfig,
  sanitizeCategory,
  sanitizeDecisionProvider,
  sanitizeUser,
  sanitizeLogDir,
  resolveRouteLogDir,
  probeLogDir,
  MrrpConfigStore,
} from '../dist/store.js';

test('DEFAULT_CATEGORIES 预置 5 个分类，首个为默认', () => {
  assert.equal(DEFAULT_CATEGORIES.length, 5);
  assert.equal(DEFAULT_CATEGORIES[0].isDefault, true);
  assert.equal(DEFAULT_CATEGORIES[0].name, '深度推理');
});

test('sanitizeConfig 空输入自动补一个默认分类', () => {
  const cfg = sanitizeConfig({});
  assert.ok(cfg.categories.some((c) => c.isDefault));
  assert.ok(cfg.categories.some((c) => c.name === '深度推理'));
  assert.equal(cfg.route.active, true);
  assert.equal(cfg.sidebar.mode, 'auto');
});

test('sanitizeCategory 清洗非法字段', () => {
  const c = sanitizeCategory({
    name: '  新分类  ',
    desc: '描述',
    modelIds: ['m1', '', 'm2', 'm1'],
    isDefault: 'yes',
  });
  assert.equal(c.name, '新分类');
  assert.deepEqual(c.modelIds, ['m1', 'm2']);
  assert.equal(c.isDefault, false);
  assert.match(c.id, /^cat_/);
});

test('sanitizeUser：id 保留任意 senderId，旧 deptId 迁移为多部门', () => {
  const u = sanitizeUser({ id: 'ou_xxx-123', name: ' 张三 ', roleId: 'role_1', deptId: 'dept_1', note: 'n' });
  assert.equal(u.id, 'ou_xxx-123'); // 唯一标识保留原样（不强制 usr_ 前缀）
  assert.equal(u.name, '张三');
  assert.deepEqual(u.deptIds, ['dept_1']);
  const u2 = sanitizeUser({ id: '', name: '空ID' });
  assert.match(u2.id, /^usr_/);
  const u3 = sanitizeUser({ id: '  staff_AB-12  ', name: '带空格' });
  assert.equal(u3.id, 'staff_AB-12'); // trim 后保留
});

test('sanitizeDecisionProvider 清洗提供方字段与非法格式', () => {
  const p = sanitizeDecisionProvider({
    id: '',
    name: '  Laya 本地  ',
    format: 'bogus',
    baseUrl: ' http://127.0.0.1:8000 ',
    apiKey: '',
    modelNames: ['english', '', 'multilingual', 'english'],
    categoryId: 'cat_1',
    enabled: false,
  });
  assert.match(p.id, /^dp_/);
  assert.equal(p.name, 'Laya 本地');
  assert.equal(p.format, 'laya'); // 非法格式回退 laya
  assert.equal(p.baseUrl, 'http://127.0.0.1:8000');
  assert.deepEqual(p.modelNames, ['english', 'multilingual']);
  assert.equal(p.categoryId, 'cat_1');
  assert.equal(p.enabled, false);
  // 非法格式 + 缺 id 也会自动生成 id
  const p2 = sanitizeDecisionProvider({ format: 'x', name: '' });
  assert.match(p2.id, /^dp_/);
  assert.equal(p2.format, 'laya');
  assert.equal(p2.endpoint, 'systemone'); // 缺省回退本地端点
  assert.equal(p2.name, '未命名提供方');
  assert.equal(p2.enabled, true);
  // decisions 端点保留
  const p3 = sanitizeDecisionProvider({ format: 'laya', endpoint: 'decisions', baseUrl: 'https://router-api.0g.ai' });
  assert.equal(p3.endpoint, 'decisions');
  assert.equal(p3.baseUrl, 'https://router-api.0g.ai');
});

test('sanitizeConfig 接受 decisionProviders 且限制数量', () => {
  const cfg = sanitizeConfig({
    decisionProviders: Array.from({ length: 60 }, (_, i) => ({
      name: `p${i}`, format: 'openai', baseUrl: `http://x${i}:8000`,
    })),
  });
  assert.ok(Array.isArray(cfg.decisionProviders));
  assert.ok(cfg.decisionProviders.length <= 50);
  assert.equal(cfg.decisionProviders[0].format, 'openai');
});

test('sanitizeRoute 钳制超时与重试', () => {
  const r = sanitizeConfig({ route: { timeoutMs: 999999999, retries: 99, lb: 'bogus' } }).route;
  assert.equal(r.timeoutMs, 300000);
  assert.equal(r.retries, 10);
  assert.equal(r.lb, DEFAULT_CONFIG.route.lb);
});

test('sanitizeConfig logRetentionDays 钳制 1~365，缺省 30', () => {
  assert.equal(sanitizeConfig({}).logRetentionDays, 30);
  assert.equal(sanitizeConfig({ logRetentionDays: 0 }).logRetentionDays, 1);
  assert.equal(sanitizeConfig({ logRetentionDays: 999 }).logRetentionDays, 365);
  assert.equal(sanitizeConfig({ logRetentionDays: 7.6 }).logRetentionDays, 8);
  assert.equal(sanitizeConfig({ logRetentionDays: 'bogus' }).logRetentionDays, 30);
});

test('sanitizeLogDir 只接受绝对路径：相对路径 / 超长 / 含空字节一律回退默认（空串）', () => {
  const custom = process.platform === 'win32' ? 'D:\\dsh\\mrrp-logs' : '/var/log/mrrp';
  assert.equal(sanitizeLogDir(''), '');
  assert.equal(sanitizeLogDir('   '), '');
  assert.equal(sanitizeLogDir('logs'), '');
  assert.equal(sanitizeLogDir('./logs'), '');
  assert.equal(sanitizeLogDir(custom), custom);
  assert.equal(sanitizeLogDir(`  ${custom}  `), custom);
  assert.equal(sanitizeLogDir(custom + sep), custom);
  assert.equal(sanitizeLogDir(`${custom}${sep}${sep}`), custom);
  assert.equal(sanitizeLogDir('a'.repeat(600)), '');
  assert.equal(sanitizeLogDir(`${custom}\u0000x`), '');
  assert.equal(sanitizeLogDir(123), '');
  assert.equal(sanitizeConfig({}).logDir, '');
  assert.equal(sanitizeConfig({ logDir: 'relative' }).logDir, '');
  assert.equal(sanitizeConfig({ logDir: custom }).logDir, custom);
});

test('resolveRouteLogDir 未配置或非法时回退 config.json 所在目录', () => {
  const isWin = process.platform === 'win32';
  const cfgPath = isWin ? 'C:\\Users\\x\\.dsh\\config.json' : '/root/.dsh/config.json';
  const fallback = isWin ? 'C:\\Users\\x\\.dsh' : '/root/.dsh';
  const custom = isWin ? 'D:\\dsh\\mrrp-logs' : '/var/log/mrrp';
  assert.equal(resolveRouteLogDir(cfgPath, ''), fallback);
  assert.equal(resolveRouteLogDir(cfgPath, undefined), fallback);
  assert.equal(resolveRouteLogDir(cfgPath, 'relative/dir'), fallback);
  assert.equal(resolveRouteLogDir(cfgPath, custom), custom);
});

test('probeLogDir：可创建且可写的目录返回空串，不可用路径返回失败原因', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mrrp-logdir-')), 'nested', 'logs');
  assert.equal(probeLogDir(dir), '');
  assert.equal(existsSync(dir), true);
  // 用「已存在的同名文件」占位，制造无法当目录使用的情况
  const blocker = join(mkdtempSync(join(tmpdir(), 'mrrp-blocker-')), 'occupied');
  writeFileSync(blocker, 'x');
  assert.notEqual(probeLogDir(blocker), '');
});

test('sanitizeConfig typeSceneList 非法/空回退默认，合法数组去重截断', () => {
  assert.deepEqual(sanitizeConfig({}).typeSceneList, ['推理', '对话', '代码', '视觉', '长文本', '多模态', '工具调用', '快速', '其他']);
  assert.deepEqual(sanitizeConfig({ typeSceneList: 'x' }).typeSceneList, ['推理', '对话', '代码', '视觉', '长文本', '多模态', '工具调用', '快速', '其他']);
  assert.deepEqual(sanitizeConfig({ typeSceneList: ['代码', ' 代码 ', '推理', '', 3] }).typeSceneList, ['代码', '推理']);
});

test('MrrpConfigStore load 空文件回退默认配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-store-'));
  const path = join(dir, 'config.json');
  const store = new MrrpConfigStore(path);
  const cfg = await store.load();
  assert.equal(store.loaded, true);
  assert.equal(cfg.version, 1);
  assert.equal(existsSync(path), false); // 未 save 前不落盘
});

test('MrrpConfigStore save 原子写入 .tmp 再 rename', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-save-'));
  const path = join(dir, 'config.json');
  const store = new MrrpConfigStore(path);
  const cfg = await store.save({ route: { active: false }, sidebar: { mode: 'hide' } });
  assert.equal(cfg.route.active, false);
  assert.equal(cfg.sidebar.mode, 'hide');
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(`${path}.tmp`), false); // tmp 已 rename，不留残影
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onDisk.route.active, false);
  assert.ok(onDisk.categories.some((c) => c.isDefault));
});

test('MrrpConfigStore patch 只合并给定字段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-patch-'));
  const store = new MrrpConfigStore(join(dir, 'config.json'));
  await store.load();
  await store.patch({ sidebar: { mode: 'show' } });
  const cfg = store.get();
  assert.equal(cfg.sidebar.mode, 'show');
  assert.equal(cfg.route.active, true); // 未被覆盖
});
