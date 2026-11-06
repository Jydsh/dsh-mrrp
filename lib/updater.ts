/**
 * dsh-mrrp 版本检查：从 GitHub Release 读取最新版本号。
 *
 * 版本号统一为 YYYY.MM.DD 年月日格式（与 package.json 的 version 字段一致），
 * 发布流程：改版本号 → push → gh release create vYYYY.MM.DD（自动打 tag）。
 *
 * 检查来源（按顺序尝试）：
 * 1. GitHub REST API：https://api.github.com/repos/{repo}/releases/latest
 * 2. 回退 releases.atom（github.com 域名，无需令牌、无速率限制）
 *
 * 仓库路径（owner/repo）默认取本插件自己的仓库；不同插件仓库不同，
 * 可通过 config.json 的 updateRepo 字段覆盖（例如 "Jydsh/dsh-mrrp"）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  packageRoot,
  profileDirOf,
  resolveProfileIdentity,
  type ProfileIdentity,
  type ProfileSource,
} from './profile.js';

/** 最新版本信息（GitHub Release 检查结果）。 */
export interface LatestVersionInfo {
  /** 最新版本号（YYYY.MM.DD） */
  version: string;
  /** 来源：api=GitHub REST API / atom=releases.atom 回退 */
  source: 'api' | 'atom';
}

/** 本插件默认仓库（与 package.json 发布仓库一致）。 */
export const DEFAULT_REPO = 'Jydsh/dsh-mrrp';

const REQUEST_TIMEOUT_MS = 8000;

/** 归一化为年月日版本号（去掉 v 前缀；支持 prerelease 后缀如 -beta1），不合法返回 null */
export function normalizeVersion(value: unknown): string | null {
  const v = String(value ?? '').trim().replace(/^v/i, '');
  return /^\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
}

/** 当前已安装版本（读 package.json），读取失败返回 null */
export function getCurrentVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot(), 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return normalizeVersion(pkg.version);
  } catch {
    return null;
  }
}

/**
 * 检查 GitHub 最新 Release 版本。
 * @param repo 仓库路径（owner/repo），默认 DEFAULT_REPO。
 * @returns 网络不可达或解析失败时返回 null
 */
export async function checkLatestVersion(repo?: string): Promise<LatestVersionInfo | null> {
  const target = (repo && repo.trim()) || DEFAULT_REPO;
  const apiLatest = `https://api.github.com/repos/${target}/releases/latest`;
  const atomUrl = `https://github.com/${target}/releases.atom`;

  // 1) GitHub REST API
  try {
    const res = await fetch(apiLatest, {
      headers: { 'User-Agent': 'dsh-mrrp', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: unknown };
      const tag = normalizeVersion(data?.tag_name);
      if (tag) return { version: tag, source: 'api' };
    }
  } catch {
    /* 回退 atom */
  }

  // 2) releases.atom（github.com 域名）
  try {
    const res = await fetch(atomUrl, {
      headers: { 'User-Agent': 'dsh-mrrp' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const text = await res.text();
      const match = text.match(/<entry>[\s\S]*?<title[^>]*>([^<]+)<\/title>/);
      const tag = normalizeVersion(match?.[1]);
      if (tag) return { version: tag, source: 'atom' };
    }
  } catch {
    /* 网络不可达 */
  }

  return null;
}

/** 年月日版本比较：current 是否不低于 latest（同格式，字符串按位补零后比较） */
export function isAtLeast(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const norm = (v: string) => v.split('.').map((n) => n.padStart(2, '0')).join('.');
  return norm(current) >= norm(latest);
}

/* ---------------------------------------------------------------------------
 * 一键更新：识别当前安装环境（profile / 安装来源 / 可用 CLI），据此拼出
 * 对应的安装命令并执行。设计目标是「插件自己知道该怎么更新自己」：
 *   - dsh CLI 可用时优先走 dsh plugin add（DSH 自己的插件安装入口）
 *   - 否则回退 pnpm、npm，cwd 固定到 profile 目录
 *   - 安装来源为 git 的仓库装法时用 github:<repo>#v<ver>，
 *     从 Release 安装包装的则用 tgz 下载地址
 * ------------------------------------------------------------------------- */

/** 在 PATH 中查找可执行文件（Windows 需兼顾 .cmd/.exe/.bat） */
function findOnPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['', '.sh'];
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try {
        if (existsSync(full)) return full;
      } catch {
        /* 忽略不可访问目录 */
      }
    }
  }
  return null;
}

/** 读本包 package.json 的 name / version */
function selfMeta(): { name: string; version: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    return { name: String(pkg.name ?? 'dsh-mrrp'), version: String(pkg.version ?? '') };
  } catch {
    return { name: 'dsh-mrrp', version: '' };
  }
}

/** 更新动作：update=按已装声明原地刷新（同版本换资产时唯一有效）/ add=装到新版本号 */
export type UpdateMode = 'update' | 'add';

/** 当前安装环境识别结果 */
export interface InstallEnv {
  platform: NodeJS.Platform;
  /** profile 名（web / desktop 等）；无法确定时为 null */
  profile: string | null;
  /** profile 目录（…/.dsh/profiles/<profile>） */
  profileDir: string | null;
  /** profile 结论的判定依据：path / env / manual / scan / ambiguous / unknown */
  profileSource: ProfileSource;
  /** 本机装了本包的 profile 列表（多命中时交给界面选择） */
  candidates: string[];
  /** 该用的更新动作：update=版本号未变，按已装声明原地刷新（add 此时会跳过）；add=装到新版本号 */
  mode: UpdateMode;
  /** 当前 profile 里已安装的版本号（读不到为 null） */
  installedVersion: string | null;
  /** 当前安装来源：git=从仓库源码装 / tgz=从 Release 安装包装 / link=链接到工程目录 / unknown */
  source: 'git' | 'tgz' | 'link' | 'unknown';
  /** 实际使用的安装 CLI */
  cli: 'dsh' | 'pnpm' | 'npm' | null;
  /** 安装规格（CLI 的 add 参数） */
  spec: string;
  /** 可直接复制执行的完整命令 */
  command: string;
  /** 无法自动执行时的原因说明 */
  blocker: string | null;
}

/** 识别 / 更新用的目标参数。 */
export interface UpdateTargetOptions {
  /** 仓库路径 owner/repo，缺省 DEFAULT_REPO */
  repo?: string;
  /** 目标版本，缺省本包 package.json 的 version */
  version?: string;
  /** 用户指定的 profile（界面选择后立即生效） */
  profile?: string;
  /** 生命周期内已解析好的身份（保证配置与更新得到同一结论） */
  identity?: ProfileIdentity;
  /** 执行超时（仅 runUpdate 使用） */
  timeoutMs?: number;
  /** 命令可用性探测（测试注入；缺省查 PATH），返回路径或布尔值 */
  hasCommand?: (name: string) => string | null | boolean;
}

/** 解析身份：显式指定的 profile 优先，否则按标准优先级判定。 */
function identityFor(options: UpdateTargetOptions, packageName: string): ProfileIdentity {
  const base = options.identity ?? resolveProfileIdentity(packageName);
  const forced = (options.profile ?? '').trim();
  if (!forced) return base;
  const dir = profileDirOf(forced);
  if (!dir) return base;
  return { ...base, profile: forced, profileDir: dir, source: 'manual' };
}

/**
 * 识别当前安装环境并生成对应安装命令。
 */
export function detectInstallEnv(options: UpdateTargetOptions = {}): InstallEnv {
  const meta = selfMeta();
  const rawRepo = (options.repo ?? '').trim() || DEFAULT_REPO;
  const safeRepo = /^[\w.-]+\/[\w.-]+$/.test(rawRepo) ? rawRepo : DEFAULT_REPO;
  const safeVersion = normalizeVersion(options.version) ?? normalizeVersion(meta.version) ?? meta.version;

  const identity = identityFor(options, meta.name);
  const profile = identity.profile;
  const profileDir = identity.profileDir;

  // 安装来源：看 profile 的 package.json 里本包是怎么声明的
  let declared: string | null = null;
  if (profileDir) {
    try {
      const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      declared = pkg.dependencies?.[meta.name] ?? pkg.devDependencies?.[meta.name] ?? null;
    } catch {
      /* profile 的 package.json 读不到，按 unknown 处理 */
    }
  }
  let source: InstallEnv['source'] = 'unknown';
  if (declared) {
    if (/^link:/i.test(declared)) source = 'link';
    else if (/github:|codeload\.github\.com|\.git(?:#|$)/i.test(declared)) source = 'git';
    else if (/\.tgz|\.tar\.gz|file:/i.test(declared)) source = 'tgz';
  }

  // 已装版本：读 profile 里真正装上的那份（junction / pnpm 虚拟目录都能读到）
  let installedVersion: string | null = null;
  if (profileDir) {
    try {
      const installed = JSON.parse(
        readFileSync(join(profileDir, 'node_modules', meta.name, 'package.json'), 'utf8'),
      ) as { version?: unknown };
      const value = String(installed.version ?? '').trim();
      installedVersion = normalizeVersion(value) ?? (value || null);
    } catch {
      /* 未安装或读不到 */
    }
  }

  const tgzSpec = `https://github.com/${safeRepo}/releases/download/v${safeVersion}/${meta.name}-${safeVersion}.tgz`;
  // 装法不明时默认走 Release 安装包：tgz 不受 pnpm 的 git 依赖脚本白名单限制
  const spec = source === 'git' ? `github:${safeRepo}#v${safeVersion}` : tgzSpec;

  // 版本号没变却要更新（例如同日替换 Release 资产）：只有 update 会重新解析 tarball，
  // 同一 spec 再 add 会被 pnpm 判成「Lockfile is up to date」直接跳过。
  const sameVersion = Boolean(installedVersion && installedVersion === safeVersion);
  const mode: UpdateMode = sameVersion ? 'update' : 'add';

  // link 安装（link:D:/path 或指向目录的 file:）：装的就是工程目录本身，
  // update / add 都刷不到东西，反而会把链接替换成实体包。
  const isLink = Boolean(
    declared
      && (/^link:/i.test(declared) || (/^file:/i.test(declared) && !/\.tgz|\.tar\.gz/i.test(declared))),
  );

  // 命令探测：优先用注入实现（测试可确定环境），否则查 PATH；
  // 不能把「本机是否装了 dsh」写死成断言前提，否则测试结果会随运行环境漂移。
  const has = (name: string): boolean => {
    const probe = options.hasCommand;
    return probe ? Boolean(probe(name)) : Boolean(findOnPath(name));
  };
  const cli: InstallEnv['cli'] = has('dsh')
    ? 'dsh'
    : has('pnpm')
      ? 'pnpm'
      : has('npm')
        ? 'npm'
        : null;

  let command = '';
  let blocker: string | null = null;
  if (cli === 'dsh') {
    // profile 认定不出时不强行指定，交给 dsh 的默认 profile
    const head = profile ? `dsh plugin --profile ${profile}` : 'dsh plugin';
    command = mode === 'update' ? `${head} update ${meta.name}` : `${head} add "${spec}"`;
  } else if (cli === 'pnpm') {
    command = mode === 'update' ? `pnpm update ${meta.name}` : `pnpm add "${spec}"`;
  } else if (cli === 'npm') {
    command = mode === 'update' ? `npm update ${meta.name}` : `npm add "${spec}"`;
  } else {
    blocker = '未找到 dsh / pnpm / npm 命令，无法自动执行安装，请按命令手工更新';
  }

  if (!blocker && isLink) {
    blocker = '当前是链接（link）安装，装的就是工程目录本身：更新请直接改工程，或先改成安装包方式装一次';
  }

  // 多个 profile 都装了本包又认不出自己：不猜，交给界面让用户选
  if (!blocker && identity.source === 'ambiguous') {
    blocker = `本机 ${identity.candidates.join(' / ')} 都装了本插件，无法确定当前是哪一个，请选择后再更新`;
  }

  return {
    platform: process.platform,
    profile,
    profileDir,
    profileSource: identity.source,
    candidates: identity.candidates,
    mode,
    installedVersion,
    source,
    cli,
    spec,
    command,
    blocker,
  };
}

/** 一键更新的执行结果 */
export interface UpdateResult {
  ok: boolean;
  exitCode: number | null;
  /** 实际执行的命令 */
  command: string;
  /** 命令输出末尾（最多 5000 字符） */
  output: string;
  env: InstallEnv;
  /** 安装成功后需要重启 DSH 才生效 */
  restartRequired: boolean;
}

/**
 * 执行一键更新：按识别出的环境跑安装命令。
 * 注意：安装会替换当前进程正在使用的插件文件，成功后仍需要重启 DSH 才加载新代码。
 */
export async function runUpdate(options: UpdateTargetOptions = {}): Promise<UpdateResult> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 180_000;
  const env = detectInstallEnv(options);
  if (env.blocker || !env.command) {
    return {
      ok: false,
      exitCode: null,
      command: env.command,
      output: env.blocker ?? '无法执行更新',
      env,
      restartRequired: false,
    };
  }

  const cwd = env.profileDir && existsSync(env.profileDir) ? env.profileDir : packageRoot();
  const outcome = await new Promise<{ code: number | null; output: string }>((done) => {
    let output = '';
    const push = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-5000);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(env.command, { cwd, shell: true, windowsHide: true, env: process.env });
    } catch (error) {
      done({ code: null, output: `启动失败：${(error as Error)?.message ?? String(error)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      push(`\n[超时] 安装进程超过 ${Math.round(timeoutMs / 1000)}s 被终止`);
    }, timeoutMs);
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: null, output: `启动失败：${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });

  return {
    ok: outcome.code === 0,
    exitCode: outcome.code,
    command: env.command,
    output: outcome.output,
    env,
    restartRequired: outcome.code === 0,
  };
}
