import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeVersion,
  getCurrentVersion,
  isAtLeast,
  DEFAULT_REPO,
  detectInstallEnv,
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

/**
 * 更新动作必须按「版本号是否变化」分开：
 *   - 版本号没变（同日替换 Release 资产）→ update，否则 add 会被 pnpm 判「Lockfile up to date」跳过；
 *   - 装了旧版本 → add 新 spec，把声明指到新版本；
 *   - link 安装 → 不生成命令，直接给出原因（避免把链接替换成实体包）。
 */

/** 目标版本取自本包 package.json（插件升级判定的是「装到当前这一版」），
 *  测试跟随它，避免每次发版都要回来改测试。 */
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const OLDER = VERSION === '2026.11.04' ? '2026.11.03' : '2026.11.04';
const TGZ = `https://github.com/Jydsh/dsh-mrrp/releases/download/v${VERSION}/dsh-mrrp-${VERSION}.tgz`;

function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  const prevProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  delete process.env.DSH_PROFILE;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    if (prevProfile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = prevProfile;
  }
}

/** 造一个装了本包的 profile：declared 决定安装方式，installedVersion 决定已装版本 */
function makeProfile(home, name, declared, installedVersion) {
  const root = join(home, 'profiles', name);
  mkdirSync(join(root, 'node_modules', 'dsh-mrrp'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name, dependencies: { 'dsh-mrrp': declared } }),
    'utf8',
  );
  writeFileSync(
    join(root, 'node_modules', 'dsh-mrrp', 'package.json'),
    JSON.stringify({ name: 'dsh-mrrp', version: installedVersion }),
    'utf8',
  );
}

function freshSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-updater-'));
  const home = join(dir, '.dsh');
  mkdirSync(home, { recursive: true });
  return { dir, home };
}

test('已装版本与目标版本相同：走 update 原地刷新，而不是 add', () => {
  const { dir, home } = freshSandbox();
  try {
    makeProfile(home, 'web', TGZ, VERSION);
    withHome(home, () => {
      // 注入命令探测：断言「dsh 存在时命令必须带 profile」这一拼法本身，
      // 不依赖运行机器 PATH 里是否真的装了 dsh。
      const env = detectInstallEnv({ hasCommand: (name) => name === 'dsh' });
      assert.equal(env.profile, 'web');
      assert.equal(env.installedVersion, VERSION);
      assert.equal(env.mode, 'update');
      assert.equal(env.source, 'tgz');
      assert.equal(env.blocker, null);
      assert.equal(env.cli, 'dsh');
      assert.match(env.command, /update dsh-mrrp/);
      assert.match(env.command, /dsh plugin --profile web/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('装了旧版本：走 add 并把声明指到目标版本的 tgz', () => {
  const { dir, home } = freshSandbox();
  try {
    makeProfile(home, 'web', `https://github.com/Jydsh/dsh-mrrp/releases/download/v${OLDER}/dsh-mrrp-${OLDER}.tgz`, OLDER);
    withHome(home, () => {
      const env = detectInstallEnv({ hasCommand: (name) => name === 'dsh' });
      assert.equal(env.installedVersion, OLDER);
      assert.equal(env.mode, 'add');
      assert.ok(env.spec.includes(`dsh-mrrp-${VERSION}.tgz`), '声明指向目标版本');
      assert.match(env.command, /add "https:/);
      assert.ok(env.command.includes(`v${VERSION}`), '命令里用的是目标版本');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('link 安装：不生成会破坏链接的命令，直接给出原因', () => {
  const { dir, home } = freshSandbox();
  try {
    makeProfile(home, 'desktop', 'link:D:/dsh/dsh-mrrp', VERSION);
    withHome(home, () => {
      const env = detectInstallEnv({});
      assert.equal(env.profile, 'desktop');
      assert.equal(env.source, 'link');
      assert.match(String(env.blocker), /链接（link）安装/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git 安装且版本号变化：spec 用 github: 形式', () => {
  const { dir, home } = freshSandbox();
  try {
    makeProfile(home, 'web', `github:Jydsh/dsh-mrrp#v${OLDER}`, OLDER);
    withHome(home, () => {
      const env = detectInstallEnv({});
      assert.equal(env.source, 'git');
      assert.equal(env.mode, 'add');
      assert.equal(env.spec, `github:Jydsh/dsh-mrrp#v${VERSION}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('指定 profile 时按该 profile 的已装版本判定动作', () => {
  const { dir, home } = freshSandbox();
  try {
    makeProfile(home, 'desktop', TGZ, OLDER);
    makeProfile(home, 'web', TGZ, VERSION);
    withHome(home, () => {
      // 两个都装了，多命中 → 未指定时给 blocker，不让猜
      const ambiguous = detectInstallEnv({});
      assert.equal(ambiguous.profileSource, 'ambiguous');
      assert.match(String(ambiguous.blocker), /请选择/);

      const picked = detectInstallEnv({ profile: 'desktop' });
      assert.equal(picked.profile, 'desktop');
      assert.equal(picked.profileSource, 'manual');
      assert.equal(picked.mode, 'add');

      const other = detectInstallEnv({ profile: 'web' });
      assert.equal(other.profile, 'web');
      assert.equal(other.mode, 'update');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
