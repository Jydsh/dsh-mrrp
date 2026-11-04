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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
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
