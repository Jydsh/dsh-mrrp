import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
function dshHome() {
    return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}
function integrationsDir() {
    return join(dshHome(), 'integrations');
}
async function readJson(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const text = await readFile(path, 'utf8');
            const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        }
        catch {
            // 可能正被别的集成写入：稍等重试一次
            if (attempt === 0)
                await new Promise((r) => setTimeout(r, 120));
        }
    }
    return null;
}
async function listDirs(dir) {
    try {
        const ents = await readdir(dir, { withFileTypes: true });
        return ents.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
    }
    catch {
        return [];
    }
}
/**
 * 同一份文件可能有两代布局：
 *   - 根级：`integrations/<集成>/<文件>`（旧）
 *   - profile 级：`integrations/<集成>/profiles/<profile>/<文件>`（新）
 * 两种都返回（profile 级优先），让单机多 profile 时也能把所有人读全。
 */
async function candidateFiles(integration, fileName) {
    const base = join(integrationsDir(), integration);
    const out = [];
    for (const profileDir of await listDirs(join(base, 'profiles'))) {
        out.push(join(profileDir, fileName));
    }
    out.push(join(base, fileName));
    return out;
}
/** 从 dsh-dingtalk 的 approvedSenders 读取 staffId -> displayName。 */
async function readDingtalkNames() {
    const names = new Map();
    for (const path of await candidateFiles('dsh-dingtalk', 'config.json')) {
        const config = await readJson(path);
        const bots = Array.isArray(config?.bots) ? config.bots : [];
        for (const bot of bots) {
            if (!bot || typeof bot !== 'object')
                continue;
            const list = Array.isArray(bot.approvedSenders)
                ? bot.approvedSenders
                : [];
            for (const sender of list) {
                if (!sender || typeof sender !== 'object')
                    continue;
                const rec = sender;
                const staffId = typeof rec.staffId === 'string' ? rec.staffId.trim() : '';
                const displayName = typeof rec.displayName === 'string' ? rec.displayName.trim() : '';
                if (staffId && displayName && !names.has(staffId))
                    names.set(staffId, displayName);
            }
        }
    }
    return names;
}
/** 从 dsh-ding-card 的 user_names.json 读取 { senderId: 姓名 }（profile 级 + 根级）。 */
async function readDingCardNames() {
    const names = new Map();
    for (const path of await candidateFiles('dsh-ding-card', 'user_names.json')) {
        const map = await readJson(path);
        if (!map)
            continue;
        for (const [userId, name] of Object.entries(map)) {
            const id = typeof userId === 'string' ? userId.trim() : '';
            if (id && typeof name === 'string' && name.trim() && !names.has(id))
                names.set(id, name.trim());
        }
    }
    return names;
}
/** 只读打开 dsh-im 群历史库，返回发送者去重列表。 */
function readImSqliteSenders(dbPath) {
    let db = null;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db
            .prepare(`SELECT sender_id, sender_name, MAX(sent_at) AS last_at, COUNT(*) AS n
         FROM messages
         WHERE sender_id <> ''
         GROUP BY sender_id, sender_name
         ORDER BY last_at DESC
         LIMIT 200`)
            .all();
        const byId = new Map();
        for (const row of rows) {
            const id = (row.sender_id || '').trim();
            if (!id)
                continue;
            const name = (row.sender_name || '').trim();
            const lastAt = Number.isFinite(row.last_at) ? Number(row.last_at) : 0;
            const count = Number.isSafeInteger(row.n) ? row.n : 1;
            const prev = byId.get(id);
            if (!prev) {
                byId.set(id, { senderId: id, senderName: name, lastAt, count, source: 'im-sqlite' });
            }
            else {
                // 同名多行聚合：取最近一次活跃时间、累加条数、优先保留最近非空姓名。
                prev.count += count;
                if (lastAt > prev.lastAt) {
                    prev.lastAt = lastAt;
                    if (name)
                        prev.senderName = name;
                }
            }
        }
        return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt);
    }
    catch {
        return [];
    }
    finally {
        try {
            db?.close();
        }
        catch { /* ignore */ }
    }
}
/** 从 sqlite 查某 senderId 的最近非空姓名。 */
function resolveNameFromSqlite(dbPath, senderId) {
    let db = null;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db
            .prepare('SELECT sender_name FROM messages WHERE sender_id = ? AND sender_name <> \'\' ORDER BY sent_at DESC LIMIT 1')
            .get(senderId);
        const name = row?.sender_name?.trim();
        return name || null;
    }
    catch {
        return null;
    }
    finally {
        try {
            db?.close();
        }
        catch { /* ignore */ }
    }
}
/**
 * 从 dsh-dingtalk 桥的 state.json 读取活跃发送者。
 *
 * 这是「群历史库为空但机器人确实在被使用」时的主来源：
 *   - `sessions`：`p2p:<staffId>` -> DSH sessionId（单聊会话键里就是 staffId）
 *   - `recentOutboundMessages`：每条带 `conversationKey`（`p2p:<staffId>`）与 `sentAt`
 * 群聊键 `group:<chatId>` 拿不到唯一发送者，跳过。
 */
async function readDingtalkBridgeSenders() {
    const botsDir = join(integrationsDir(), 'dsh-dingtalk', 'bots');
    const byId = new Map();
    const touch = (staffId, at, addCount) => {
        const prev = byId.get(staffId);
        if (!prev) {
            byId.set(staffId, { senderId: staffId, senderName: '', lastAt: at, count: Math.max(1, addCount), source: 'dingtalk-bridge' });
            return;
        }
        prev.count += addCount;
        if (at > prev.lastAt)
            prev.lastAt = at;
    };
    for (const botDir of await listDirs(botsDir)) {
        const state = await readJson(join(botDir, 'state.json'));
        if (!state)
            continue;
        const sessions = state.sessions;
        if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
            for (const conversationKey of Object.keys(sessions)) {
                const m = /^p2p:(.+)$/.exec(conversationKey);
                const staffId = m?.[1]?.trim();
                // 会话键只说明「有过单聊」，不重复计数
                if (staffId)
                    touch(staffId, 0, 0);
            }
        }
        const outbounds = Array.isArray(state.recentOutboundMessages) ? state.recentOutboundMessages : [];
        for (const rec of outbounds) {
            if (!rec || typeof rec !== 'object')
                continue;
            const r = rec;
            const key = typeof r.conversationKey === 'string' ? r.conversationKey : '';
            const m = /^p2p:(.+)$/.exec(key);
            const staffId = m?.[1]?.trim();
            if (!staffId)
                continue;
            const at = Number.isFinite(r.sentAt) ? Number(r.sentAt) : 0;
            touch(staffId, at, 1);
        }
    }
    return [...byId.values()];
}
/** 构造真实 dsh-im 读取器（只读 sqlite + 钉钉桥 + ding-card / approvedSenders 补姓名）。 */
export function makeImReader(dbPath) {
    async function sqlitePaths() {
        if (dbPath)
            return [dbPath];
        return candidateFiles('dsh-im', 'group-history.sqlite');
    }
    async function collectNames() {
        const names = new Map();
        const extras = [];
        try {
            for (const [id, name] of await readDingCardNames()) {
                if (!names.has(id))
                    names.set(id, name);
                extras.push({ senderId: id, senderName: name, lastAt: 0, count: 1, source: 'ding-card' });
            }
        }
        catch { /* ignore */ }
        try {
            for (const [id, name] of await readDingtalkNames()) {
                if (!names.has(id))
                    names.set(id, name);
                extras.push({ senderId: id, senderName: name, lastAt: 0, count: 1, source: 'dingtalk' });
            }
        }
        catch { /* ignore */ }
        return { names, extras };
    }
    function mergeAndSort(list, names) {
        const byId = new Map();
        for (const sender of list) {
            if (!sender.senderId)
                continue;
            const prev = byId.get(sender.senderId);
            if (!prev) {
                byId.set(sender.senderId, { ...sender });
            }
            else {
                prev.count += sender.count;
                if (sender.lastAt > prev.lastAt)
                    prev.lastAt = sender.lastAt;
                if (!prev.senderName && sender.senderName)
                    prev.senderName = sender.senderName;
            }
        }
        for (const sender of byId.values()) {
            if (!sender.senderName)
                sender.senderName = names.get(sender.senderId) ?? '';
        }
        return [...byId.values()]
            .sort((a, b) => b.lastAt - a.lastAt)
            .slice(0, 200);
    }
    return {
        async readSenders() {
            const all = [];
            for (const path of await sqlitePaths()) {
                try {
                    all.push(...readImSqliteSenders(path));
                }
                catch { /* ignore */ }
            }
            try {
                all.push(...(await readDingtalkBridgeSenders()));
            }
            catch { /* ignore */ }
            const { names, extras } = await collectNames();
            all.push(...extras);
            return mergeAndSort(all, names);
        },
        async resolveName(senderId) {
            const id = (senderId || '').trim();
            if (!id)
                return null;
            for (const path of await sqlitePaths()) {
                const fromSqlite = resolveNameFromSqlite(path, id);
                if (fromSqlite)
                    return fromSqlite;
            }
            const { names } = await collectNames();
            return names.get(id) ?? null;
        },
    };
}
/** 空实现（测试 / sqlite 不可用时的降级）。 */
export function noopImReader() {
    return {
        async readSenders() { return []; },
        async resolveName() { return null; },
    };
}
