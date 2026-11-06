import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** 本插件包名。 */
export const SELF_PACKAGE = 'dsh-mrrp';
/** DSH 主目录：DSH_HOME 优先，否则 ~/.dsh。 */
export function dshHomeDir() {
    return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}
/** profile 根目录（…/.dsh/profiles）。 */
export function profilesRoot() {
    return join(dshHomeDir(), 'profiles');
}
/** 本包根目录（…/node_modules/dsh-mrrp；dist/profile.js 往上两级）。 */
export function packageRoot() {
    return resolve(dirname(dirname(fileURLToPath(import.meta.url))));
}
/** 本机装了本包的 profile 列表（按字母序）。 */
export function listProfilesWithPackage(packageName = SELF_PACKAGE) {
    const root = profilesRoot();
    let names = [];
    try {
        names = readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => entry.name);
    }
    catch {
        return [];
    }
    return names
        .filter((name) => existsSync(join(root, name, 'node_modules', packageName, 'package.json')))
        .sort();
}
/** 从自身安装路径里取 profile：…/.dsh/profiles/<profile>/node_modules/dsh-mrrp。 */
function profileFromOwnPath() {
    const match = /[\\/]\.dsh[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/]/.exec(`${packageRoot()}/`);
    return match ? match[1] : null;
}
/** 手动选择记忆文件（放在插件自己的全局集成目录，profile 未定时也能读）。 */
function selectionFile() {
    return join(dshHomeDir(), 'integrations', SELF_PACKAGE, 'profile-selection.json');
}
/** 读取上次手动选择的 profile（没有则 null）。 */
export function readRememberedProfile() {
    try {
        const raw = JSON.parse(readFileSync(selectionFile(), 'utf8').replace(/^\uFEFF/, ''));
        const value = typeof raw?.profile === 'string' ? raw.profile.trim() : '';
        return value || null;
    }
    catch {
        return null;
    }
}
/** 记住用户手动选择的 profile（下次启动直接采信，不再询问）。 */
export function rememberProfile(profile) {
    const text = profile.trim();
    if (!text)
        return;
    try {
        mkdirSync(dirname(selectionFile()), { recursive: true, mode: 0o700 });
        const payload = `${JSON.stringify({ profile: text, updatedAt: new Date().toISOString() }, null, 2)}\n`;
        writeFileSync(selectionFile(), payload, 'utf8');
    }
    catch {
        /* 记忆失败不影响主流程 */
    }
}
/** 指定 profile 的目录（不存在返回 null）。 */
export function profileDirOf(profile) {
    const dir = join(profilesRoot(), profile);
    return existsSync(dir) ? dir : null;
}
/** 解析当前插件所属的 profile（结论见文件头的优先级说明）。 */
export function resolveProfileIdentity(packageName = SELF_PACKAGE) {
    const dshHome = dshHomeDir();
    const root = profilesRoot();
    const candidates = listProfilesWithPackage(packageName);
    const known = (name) => existsSync(join(root, name));
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
export function mrrpDataDir(identity = resolveProfileIdentity()) {
    const base = join(identity.dshHome, 'integrations', SELF_PACKAGE);
    return identity.profile ? join(base, 'profiles', identity.profile) : base;
}
/** 本插件在该 profile 下的配置文件路径。 */
export function mrrpConfigPathFor(identity = resolveProfileIdentity()) {
    return join(mrrpDataDir(identity), 'config.json');
}
/**
 * 首次按 profile 存配置时，把旧的共享配置复制一份过来。
 * 只复制、不删旧文件：另一端首次启动时同样能从旧文件拿到初始配置，之后再各自独立演化。
 * @returns 是否真的复制了
 */
export function ensureProfileConfig(identity, targetPath) {
    if (!identity.profile)
        return false;
    try {
        if (existsSync(targetPath))
            return false;
        const legacy = join(identity.dshHome, 'integrations', SELF_PACKAGE, 'config.json');
        if (!existsSync(legacy))
            return false;
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        copyFileSync(legacy, targetPath);
        return true;
    }
    catch {
        return false;
    }
}
