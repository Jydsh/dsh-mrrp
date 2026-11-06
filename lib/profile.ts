import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 当前插件「属于哪个 DSH 环境」的统一解析。
 *
 * 一台机器可以同时装 desktop 与 web 两个 profile，插件必须只认自己所在的那个，
 * 否则会出现两类错：版本号/更新命令算的是另一端，一键更新把另一端的包重装一遍。
 *
 * 判定优先级（越靠前越可信）：
 *   1. path     自身被真正加载的路径里带 .dsh/profiles/<profile>/（生产安装最准）；
 *   2. env      宿主给出的 DSH_PROFILE；
 *   3. manual   用户之前在界面上手动选过并记住的 profile；
 *   4. scan     扫描 ~/.dsh/profiles 里装了本包的 profile —— 只有唯一命中才采信；
 *   5. ambiguous / unknown  多命中或零命中：不猜，交给界面让用户选。
 *
 * 注意不能用「扫到的第一个」：目录按字母序遍历，desktop 永远排在 web 前面，
 * 两个都装时 web 进程会被误判成 desktop。
 */

/** profile 身份的来源。 */
export type ProfileSource = 'path' | 'env' | 'manual' | 'scan' | 'ambiguous' | 'unknown';

/** 当前插件所在环境的解析结果。 */
export interface ProfileIdentity {
  /** profile 名；无法确定时为 null */
  profile: string | null;
  /** profile 目录（…/.dsh/profiles/<profile>）；无法确定时为 null */
  profileDir: string | null;
  /** 判定依据 */
  source: ProfileSource;
  /** 本机装了本包的 profile 列表（字母序，供界面选择） */
  candidates: string[];
  /** DSH 主目录（DSH_HOME 或 ~/.dsh） */
  dshHome: string;
}

/** 本插件包名。 */
export const SELF_PACKAGE = 'dsh-mrrp';

/** DSH 主目录：DSH_HOME 优先，否则 ~/.dsh。 */
export function dshHomeDir(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}

/** profile 根目录（…/.dsh/profiles）。 */
export function profilesRoot(): string {
  return join(dshHomeDir(), 'profiles');
}

/** 本包根目录（…/node_modules/dsh-mrrp；dist/profile.js 往上两级）。 */
export function packageRoot(): string {
  return resolve(dirname(dirname(fileURLToPath(import.meta.url))));
}

/** 本机装了本包的 profile 列表（按字母序）。 */
export function listProfilesWithPackage(packageName: string = SELF_PACKAGE): string[] {
  const root = profilesRoot();
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .filter((name) => existsSync(join(root, name, 'node_modules', packageName, 'package.json')))
    .sort();
}

/** 从自身安装路径里取 profile：…/.dsh/profiles/<profile>/node_modules/dsh-mrrp。 */
function profileFromOwnPath(): string | null {
  const match = /[\\/]\.dsh[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/]/.exec(`${packageRoot()}/`);
  return match ? match[1] : null;
}

/** 手动选择记忆文件（放在插件自己的全局集成目录，profile 未定时也能读）。 */
function selectionFile(): string {
  return join(dshHomeDir(), 'integrations', SELF_PACKAGE, 'profile-selection.json');
}

/** 读取上次手动选择的 profile（没有则 null）。 */
export function readRememberedProfile(): string | null {
  try {
    const raw = JSON.parse(readFileSync(selectionFile(), 'utf8').replace(/^\uFEFF/, '')) as { profile?: unknown };
    const value = typeof raw?.profile === 'string' ? raw.profile.trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

/** 记住用户手动选择的 profile（下次启动直接采信，不再询问）。 */
export function rememberProfile(profile: string): void {
  const text = profile.trim();
  if (!text) return;
  try {
    mkdirSync(dirname(selectionFile()), { recursive: true, mode: 0o700 });
    const payload = `${JSON.stringify({ profile: text, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    writeFileSync(selectionFile(), payload, 'utf8');
  } catch {
    /* 记忆失败不影响主流程 */
  }
}

/** 指定 profile 的目录（不存在返回 null）。 */
export function profileDirOf(profile: string): string | null {
  const dir = join(profilesRoot(), profile);
  return existsSync(dir) ? dir : null;
}

/** 解析当前插件所属的 profile（结论见文件头的优先级说明）。 */
export function resolveProfileIdentity(packageName: string = SELF_PACKAGE): ProfileIdentity {
  const dshHome = dshHomeDir();
  const root = profilesRoot();
  const candidates = listProfilesWithPackage(packageName);
  const known = (name: string) => existsSync(join(root, name));

  const own = profileFromOwnPath();
  if (own && known(own)) {
    return { profile: own, profileDir: join(root, own), source: 'path', candidates, dshHome };
  }

  const fromEnv = (process.env.DSH_PROFILE ?? '').trim();
  if (fromEnv && known(fromEnv)) {
    return { profile: fromEnv, profileDir: join(root, fromEnv), source: 'env', candidates, dshHome };
  }

  const remembered = readRememberedProfile();
  if (remembered && (candidates.includes(remembered) || known(remembered))) {
    return { profile: remembered, profileDir: join(root, remembered), source: 'manual', candidates, dshHome };
  }

  if (candidates.length === 1) {
    return { profile: candidates[0], profileDir: join(root, candidates[0]), source: 'scan', candidates, dshHome };
  }

  return {
    profile: null,
    profileDir: null,
    source: candidates.length > 1 ? 'ambiguous' : 'unknown',
    candidates,
    dshHome,
  };
}

/**
 * 本插件在该 profile 下的数据目录。
 * 认定到 profile 时按 profile 分开（…/integrations/dsh-mrrp/profiles/<profile>），
 * 认定不出时退回原来的共享目录（宁可共用，也不要把配置写到看不见的地方）。
 */
export function mrrpDataDir(identity: ProfileIdentity = resolveProfileIdentity()): string {
  const base = join(identity.dshHome, 'integrations', SELF_PACKAGE);
  return identity.profile ? join(base, 'profiles', identity.profile) : base;
}

/** 本插件在该 profile 下的配置文件路径。 */
export function mrrpConfigPathFor(identity: ProfileIdentity = resolveProfileIdentity()): string {
  return join(mrrpDataDir(identity), 'config.json');
}

/**
 * 首次按 profile 存配置时，把旧的共享配置复制一份过来。
 * 只复制、不删旧文件：另一端首次启动时同样能从旧文件拿到初始配置，之后再各自独立演化。
 * @returns 是否真的复制了
 */
export function ensureProfileConfig(identity: ProfileIdentity, targetPath: string): boolean {
  if (!identity.profile) return false;
  try {
    if (existsSync(targetPath)) return false;
    const legacy = join(identity.dshHome, 'integrations', SELF_PACKAGE, 'config.json');
    if (!existsSync(legacy)) return false;
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    copyFileSync(legacy, targetPath);
    return true;
  } catch {
    return false;
  }
}
