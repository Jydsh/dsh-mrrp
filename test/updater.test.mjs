import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeVersion,
  getCurrentVersion,
  isAtLeast,
  DEFAULT_REPO,
} from '../dist/updater.js';

test('normalizeVersion: 识别合法年月日版本（含 v 前缀 / 预发布后缀）', () => {
  assert.equal(normalizeVersion('2026.11.04'), '2026.11.04');
  assert.equal(normalizeVersion('v2026.11.04'), '2026.11.04');
  assert.equal(normalizeVersion('V2026.1.4'), '2026.1.4');
  assert.equal(normalizeVersion('2026.11.04-beta1'), '2026.11.04-beta1');
  assert.equal(normalizeVersion('v2026.11.04-rc.2'), '2026.11.04-rc.2');
});

test('normalizeVersion: 拒绝非法版本', () => {
  assert.equal(normalizeVersion(null), null);
  assert.equal(normalizeVersion(undefined), null);
  assert.equal(normalizeVersion(''), null);
  assert.equal(normalizeVersion('abc'), null);
  assert.equal(normalizeVersion('2026.11'), null);
  assert.equal(normalizeVersion('1.2.3'), null);
  assert.equal(normalizeVersion('2026-11-04'), null);
});

test('getCurrentVersion: 读 package.json 返回当前版本', () => {
  // 动态取 package.json 的 version，避免每次发版都要改测试断言
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(getCurrentVersion(), pkg.version);
});

test('isAtLeast: 年月日版本按位比较', () => {
  assert.equal(isAtLeast('2026.11.04', '2026.11.04'), true);
  assert.equal(isAtLeast('2026.11.05', '2026.11.04'), true);
  assert.equal(isAtLeast('2026.12.01', '2026.11.04'), true);
  assert.equal(isAtLeast('2026.11.04', '2026.11.05'), false);
  assert.equal(isAtLeast('2026.11.04', '2026.12.01'), false);
  assert.equal(isAtLeast('2026.11.04', '2027.1.1'), false);
  assert.equal(isAtLeast(null, '2026.11.04'), false);
  assert.equal(isAtLeast('2026.11.04', null), false);
});

test('DEFAULT_REPO: 本插件仓库路径', () => {
  assert.equal(DEFAULT_REPO, 'Jydsh/dsh-mrrp');
});
