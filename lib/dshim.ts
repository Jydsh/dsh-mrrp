import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * dsh-im 集成：只读读取 dsh-im / dsh-dingtalk 记录的发送者信息（senderId -> 姓名）。
 *
 * 数据源（按优先级）：
 *   1. dsh-im 群历史库 `~/.dsh/integrations/dsh-im/group-history.sqlite` 的 messages 表：
 *      sender_id（唯一标识）+ sender_name（最近非空姓名）。
 *   2. dsh-dingtalk 集成 `~/.dsh/integrations/dsh-dingtalk/config.json` 里 bot.approvedSenders
 *      （staffId -> displayName，dsh-im 批准发送者时持久化）。
 *   3. dsh-ding-card 集成的 `~/.dsh/integrations/dsh-ding-card/user_names.json`（{ senderId: 姓名 }）。
 *
 * 原则：只读、绝不写 dsh-im / dsh-dingtalk 的数据；sqlite 打开失败或正在被写入时静默降级，
 * 不影响 MRRP 主功能。不注册任何 hook / 中间件拦截 DSH 主链路。
 */

/** 一个发送者（去重后的唯一标识 + 姓名 + 最近活跃时间 + 消息数）。 */
export interface ImSender {
  senderId: string;
  senderName: string;
  /** 最近一条消息的毫秒时间戳；不可得时为 0 */
  lastAt: number;
  /** 消息条数 */
  count: number;
  /** 来源：im-sqlite / dingtalk / ding-card */
  source: string;
}

/** dsh-im 只读读取器（测试可注入假实现）。 */
export interface ImReader {
  /** 全部发送者去重列表（按最近活跃倒序，最多 200 个）。 */
  readSenders(): Promise<ImSender[]>;
  /** 查某 senderId 的姓名；查不到返回 null。 */
  resolveName(senderId: string): Promise<string | null>;
}

function dshHome(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}

async function readJson(path: string): Promise<Record<string, any> | null> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从 dsh-dingtalk 的 approvedSenders 读取 staffId -> displayName。 */
async function readDingtalkNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const config = await readJson(join(dshHome(), 'integrations', 'dsh-dingtalk', 'config.json'));
  const bots = Array.isArray(config?.bots) ? config.bots : [];
  for (const bot of bots) {
    if (!bot || typeof bot !== 'object') continue;
    for (const sender of Array.isArray((bot as Record<string, any>).approvedSenders) ? (bot as Record<string, any>).approvedSenders : []) {
      if (!sender || typeof sender !== 'object') continue;
      const rec = sender as Record<string, any>;
      const staffId = typeof rec.staffId === 'string' ? rec.staffId.trim() : '';
      const displayName = typeof rec.displayName === 'string' ? rec.displayName.trim() : '';
      if (staffId && displayName) names.set(staffId, displayName);
    }
  }
  return names;
}

/** 从 dsh-ding-card 的 user_names.json 读取 { senderId: 姓名 }。 */
async function readDingCardNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const map = await readJson(join(dshHome(), 'integrations', 'dsh-ding-card', 'user_names.json'));
  if (map && typeof map === 'object') {
    for (const [userId, name] of Object.entries(map)) {
      if (userId && typeof name === 'string' && name.trim()) names.set(userId, name.trim());
    }
  }
  return names;
}

/** 只读打开 dsh-im 群历史库，返回发送者去重列表。 */
function readImSqliteSenders(dbPath: string): ImSender[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT sender_id, sender_name, MAX(sent_at) AS last_at, COUNT(*) AS n
         FROM messages
         WHERE sender_id <> ''
         GROUP BY sender_id, sender_name
         ORDER BY last_at DESC
         LIMIT 200`,
      )
      .all() as Array<{ sender_id: string; sender_name: string; last_at: number | null; n: number }>;
    const byId = new Map<string, ImSender>();
    for (const row of rows) {
      const id = (row.sender_id || '').trim();
      if (!id) continue;
      const name = (row.sender_name || '').trim();
      const lastAt = Number.isFinite(row.last_at) ? Number(row.last_at) : 0;
      const count = Number.isSafeInteger(row.n) ? row.n : 1;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, { senderId: id, senderName: name, lastAt, count, source: 'im-sqlite' });
      } else {
        // 同名多行聚合：取最近一次活跃时间、累加条数、优先保留最近非空姓名。
        prev.count += count;
        if (lastAt > prev.lastAt) {
          prev.lastAt = lastAt;
          if (name) prev.senderName = name;
        }
      }
    }
    return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 从 sqlite 查某 senderId 的最近非空姓名。 */
function resolveNameFromSqlite(dbPath: string, senderId: string): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare('SELECT sender_name FROM messages WHERE sender_id = ? AND sender_name <> \'\' ORDER BY sent_at DESC LIMIT 1')
      .get(senderId) as { sender_name: string } | undefined;
    const name = row?.sender_name?.trim();
    return name || null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 构造真实 dsh-im 读取器（只读 sqlite + dingtalk/ding-card 兜底）。 */
export function makeImReader(dbPath?: string): ImReader {
  const path = dbPath ?? join(dshHome(), 'integrations', 'dsh-im', 'group-history.sqlite');
  let dingtalkCache: Map<string, string> | null = null;
  let dingCardCache: Map<string, string> | null = null;

  async function ensureFallbacks(): Promise<void> {
    try {
      if (!dingtalkCache) dingtalkCache = await readDingtalkNames();
      if (!dingCardCache) dingCardCache = await readDingCardNames();
    } catch { /* ignore */ }
  }

  return {
    async readSenders(): Promise<ImSender[]> {
      const senders = readImSqliteSenders(path);
      try {
        await ensureFallbacks();
      } catch { /* ignore */ }
      if (dingtalkCache || dingCardCache) {
        const seen = new Set(senders.map((s) => s.senderId));
        const extra: ImSender[] = [];
        const push = (map: Map<string, string> | null, source: string) => {
          if (!map) return;
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

    async resolveName(senderId: string): Promise<string | null> {
      const id = (senderId || '').trim();
      if (!id) return null;
      const fromSqlite = resolveNameFromSqlite(path, id);
      if (fromSqlite) return fromSqlite;
      try {
        await ensureFallbacks();
      } catch { /* ignore */ }
      if (dingtalkCache?.has(id)) return dingtalkCache.get(id) ?? null;
      if (dingCardCache?.has(id)) return dingCardCache.get(id) ?? null;
      return null;
    },
  };
}

/** 空实现（测试 / sqlite 不可用时的降级）。 */
export function noopImReader(): ImReader {
  return {
    async readSenders() { return []; },
    async resolveName() { return null; },
  };
}
