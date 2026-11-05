import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
function dshHome() {
    return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}
async function readJson(path) {
    try {
        const text = await readFile(path, 'utf8');
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
/** 从 dsh-dingtalk 的 approvedSenders 读取 staffId -> displayName。 */
async function readDingtalkNames() {
    const names = new Map();
    const config = await readJson(join(dshHome(), 'integrations', 'dsh-dingtalk', 'config.json'));
    const bots = Array.isArray(config?.bots) ? config.bots : [];
    for (const bot of bots) {
        if (!bot || typeof bot !== 'object')
            continue;
        for (const sender of Array.isArray(bot.approvedSenders) ? bot.approvedSenders : []) {
            if (!sender || typeof sender !== 'object')
                continue;
            const rec = sender;
            const staffId = typeof rec.staffId === 'string' ? rec.staffId.trim() : '';
            const displayName = typeof rec.displayName === 'string' ? rec.displayName.trim() : '';
            if (staffId && displayName)
                names.set(staffId, displayName);
        }
    }
    return names;
}
/** 从 dsh-ding-card 的 user_names.json 读取 { senderId: 姓名 }。 */
async function readDingCardNames() {
    const names = new Map();
    const map = await readJson(join(dshHome(), 'integrations', 'dsh-ding-card', 'user_names.json'));
    if (map && typeof map === 'object') {
        for (const [userId, name] of Object.entries(map)) {
            if (userId && typeof name === 'string' && name.trim())
                names.set(userId, name.trim());
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
/** 构造真实 dsh-im 读取器（只读 sqlite + dingtalk/ding-card 兜底）。 */
export function makeImReader(dbPath) {
    const path = dbPath ?? join(dshHome(), 'integrations', 'dsh-im', 'group-history.sqlite');
    let dingtalkCache = null;
    let dingCardCache = null;
    async function ensureFallbacks() {
        try {
            if (!dingtalkCache)
                dingtalkCache = await readDingtalkNames();
            if (!dingCardCache)
                dingCardCache = await readDingCardNames();
        }
        catch { /* ignore */ }
    }
    return {
        async readSenders() {
            const senders = readImSqliteSenders(path);
            try {
                await ensureFallbacks();
            }
            catch { /* ignore */ }
            if (dingtalkCache || dingCardCache) {
                const seen = new Set(senders.map((s) => s.senderId));
                const extra = [];
                const push = (map, source) => {
                    if (!map)
                        return;
                    for (const [id, name] of map) {
                        if (!seen.has(id)) {
                            seen.add(id);
                            extra.push({ senderId: id, senderName: name, lastAt: 0, count: 1, source });
                        }
                    }
                };
                push(dingtalkCache, 'dingtalk');
                push(dingCardCache, 'ding-card');
                return [...senders, ...extra];
            }
            return senders;
        },
        async resolveName(senderId) {
            const id = (senderId || '').trim();
            if (!id)
                return null;
            const fromSqlite = resolveNameFromSqlite(path, id);
            if (fromSqlite)
                return fromSqlite;
            try {
                await ensureFallbacks();
            }
            catch { /* ignore */ }
            if (dingtalkCache?.has(id))
                return dingtalkCache.get(id) ?? null;
            if (dingCardCache?.has(id))
                return dingCardCache.get(id) ?? null;
            return null;
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
