import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureProfileConfig,
  listProfilesWithPackage,
  mrrpConfigPathFor,
  readRememberedProfile,
  rememberProfile,
  resolveProfileIdentity,
} from '../dist/profile.js';
import { detectInstallEnv } from '../dist/updater.js';

/**
 * 身份判定必须能区分 desktop / web：
 *   - 多命中时绝不猜（否则 web 里点更新会重装 desktop）；
 *   - 配置目录跟着 profile 走，识别不出时回退旧共享位置。
 */

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-profile-'));
  const home = join(dir, '.dsh');
  mkdirSync(home, { recursive: true });
  return { dir, home };
}

/** 在 <home>/profiles/<name> 里造出「已安装本包」的状态 */
function installProfile(home, name) {
  const pkgDir = join(home, 'profiles', name, 'node_modules', 'dsh-mrrp');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'dsh-mrrp', version: '2026.11.05' }),
    'utf8',
  );
  // profile 自己的 package.json：声明本包（detectInstallEnv 用它判断安装来源）
  writeFileSync(
    join(home, 'profiles', name, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-mrrp': 'link:D:/dsh/dsh-mrrp' } }),
    'utf8',
  );
}

/** 在隔离的 DSH_HOME 下跑一段同步逻辑，结束后还原环境变量 */
function withHome(home, fn, envProfile) {
  const prevHome = process.env.DSH_HOME;
  const prevProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  if (envProfile === undefined) delete process.env.DSH_PROFILE;
  else process.env.DSH_PROFILE = envProfile;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevProfile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = prevProfile;
  }
}

test('一个 profile 都没装本包：unknown，不猜，配置回退旧共享位置', () => {
  const { dir, home } = sandbox();
  try {
    withHome(home, () => {
      const id = resolveProfileIdentity();
      assert.equal(id.source, 'unknown');
      assert.equal(id.profile, null);
      assert.deepEqual(id.candidates, []);
      assert.match(mrrpConfigPathFor(id), /integrations[\\/]dsh-mrrp[\\/]config\.json$/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只有 desktop 装了本包：唯一命中即采信，配置落到该 profile 目录', () => {
  const { dir, home } = sandbox();
  try {
    installProfile(home, 'desktop');
    withHome(home, () => {
      const id = resolveProfileIdentity();
      assert.equal(id.source, 'scan');
      assert.equal(id.profile, 'desktop');
      assert.deepEqual(id.candidates, ['desktop']);
      assert.match(mrrpConfigPathFor(id), /profiles[\\/]desktop[\\/]config\.json$/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop 与 web 都装了：多命中判为 ambiguous，列出候选且不选任何一个', () => {
  const { dir, home } = sandbox();
  try {
    installProfile(home, 'desktop');
    installProfile(home, 'web');
    withHome(home, () => {
      const id = resolveProfileIdentity();
      assert.equal(id.source, 'ambiguous');
      assert.equal(id.profile, null);
      assert.deepEqual(id.candidates, ['desktop', 'web']);
      // 不猜时仍可读旧共享配置，不会让控制台变空
      assert.match(mrrpConfigPathFor(id), /integrations[\\/]dsh-mrrp[\\/]config\.json$/);
      // 更新命令也不该擅自指向某一个 profile
      const env = detectInstallEnv({});
      assert.equal(env.profile, null);
      assert.equal(env.profileSource, 'ambiguous');
      assert.deepEqual(env.candidates, ['desktop', 'web']);
      assert.match(String(env.blocker), /请选择/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('宿主给了 DSH_PROFILE：优先于扫描结论', () => {
  const { dir, home } = sandbox();
  try {
    installProfile(home, 'desktop');
    installProfile(home, 'web');
    withHome(home, () => {
      const id = resolveProfileIdentity();
      assert.equal(id.source, 'env');
      assert.equal(id.profile, 'web');
      assert.match(mrrpConfigPathFor(id), /profiles[\\/]web[\\/]config\.json$/);
    }, 'web');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('用户选择被记住：多命中时按记忆走 manual，并各自独立配置目录', () => {
  const { dir, home } = sandbox();
  try {
    installProfile(home, 'desktop');
    installProfile(home, 'web');
    withHome(home, () => {
      assert.equal(resolveProfileIdentity().source, 'ambiguous');
      rememberProfile('web');
      assert.equal(readRememberedProfile(), 'web');
      const id = resolveProfileIdentity();
      assert.equal(id.source, 'manual');
      assert.equal(id.profile, 'web');
      assert.match(mrrpConfigPathFor(id), /profiles[\\/]web[\\/]config\.json$/);
      // 指定 profile 时更新目标随之切换；该 sandbox 用 link 安装，命令会被拦下并说明原因
      const env = detectInstallEnv({ profile: 'desktop' });
      assert.equal(env.profile, 'desktop');
      assert.equal(env.profileSource, 'manual');
      assert.match(String(env.blocker), /链接（link）安装/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧共享配置只复制一次到各 profile 目录，不覆盖已有文件', () => {
  const { dir, home } = sandbox();
  try {
    installProfile(home, 'desktop');
    installProfile(home, 'web');
    const legacyDir = join(home, 'integrations', 'dsh-mrrp');
    mkdirSync(legacyDir, { recursive: true });
    const legacyFile = join(legacyDir, 'config.json');
    writeFileSync(legacyFile, JSON.stringify({ routeEnabled: true }), 'utf8');

    withHome(home, () => {
      const id = resolveProfileIdentity();
      assert.equal(id.source, 'ambiguous');
      const migrated = { ...id, profile: 'web', profileDir: join(home, 'profiles', 'web') };
      const target = mrrpConfigPathFor(migrated);
      assert.equal(ensureProfileConfig(migrated, target), true);
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { routeEnabled: true });
      // 第二次不覆盖，旧文件也保留（另一端的迁移源）
      assert.equal(ensureProfileConfig(migrated, target), false);
      assert.equal(readFileSync(legacyFile, 'utf8').includes('routeEnabled'), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listProfilesWithPackage 只列出真正装了包的环境', () => {
  const { dir, home } = sandbox();
  try {
    installProfile(home, 'desktop');
    // web 只有 profile 目录、没装本包
    mkdirSync(join(home, 'profiles', 'web', 'node_modules'), { recursive: true });
    withHome(home, () => {
      assert.deepEqual(listProfilesWithPackage(), ['desktop']);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
