import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * dsh-im / IM 集成：只读读取「谁在用这个机器人」（senderId -> 姓名）。
 *
 * 数据源（全部按「发送者身份」累积，姓名互相补足）：
 *   1. dsh-im 群历史库 `dsh-im/group-history.sqlite`（也扫 `dsh-im/profiles/<p>/`）的 messages 表：
 *      sender_id + sender_name。注意：只有群消息才落这张表，纯 p2p 单聊时它可能是空的。
 *   2. dsh-dingtalk 桥 `dsh-dingtalk/bots/<bot>/state.json` 的 `sessions` 与
 *      `recentOutboundMessages`：`p2p:<staffId>` 这一列是**当前真实活跃的发送者**，
 *      即使群历史库为空也能拿到人（姓名需要下面的姓名源补足）。
 *   3. dsh-ding-card `user_names.json`（`dsh-ding-card/profiles/<p>/` 优先，
 *      也兼容根级旧布局）：`{ senderId: 姓名 }`。
 *   4. dsh-dingtalk `config.json` 的 `bots[].approvedSenders`（staffId -> displayName）。
 *
 * 原则：只读、绝不写其它集成的数据；sqlite / JSON 打开失败一律静默降级，不影响 MRRP 主功能。
 * 不注册任何 hook / 中间件拦截 DSH 主链路。
 */

/** 一个发送者（去重后的唯一标识 + 姓名 + 最近活跃时间 + 消息数）。 */
export interface ImSender {
  senderId: string;
  senderName: string;
  /** 最近一条消息的毫秒时间戳；不可得时为 0 */
  lastAt: number;
  /** 消息条数（或观测到的会话/出站条数） */
  count: number;
  /** 来源：im-sqlite / dingtalk-bridge / ding-card / dingtalk */
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

function integrationsDir(): string {
  return join(dshHome(), 'integrations');
}

async function readJson(path: string): Promise<Record<string, any> | null> {
 for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await readFile(path, 'utf8');
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      // 可能正被别的集成写入：稍等重试一次
      if (attempt === 0) await new Promise((r) => setTimeout(r, 120));
    }
  }
  return null;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * 同一份文件可能有两代布局：
 *   - 根级：`integrations/<集成>/<文件>`（旧）
 *   - profile 级：`integrations/<集成>/profiles/<profile>/<文件>`（新）
 * 两种都返回（profile 级优先），让单机多 profile 时也能把所有人读全。
 */
async function candidateFiles(integration: string, fileName: string): Promise<string[]> {
  const base = join(integrationsDir(), integration);
  const out: string[] = [];
  for (const profileDir of await listDirs(join(base, 'profiles'))) {
    out.push(join(profileDir, fileName));
  }
  out.push(join(base, fileName));
  return out;
}

/** 从 dsh-dingtalk 的 approvedSenders 读取 staffId -> displayName。 */
async function readDingtalkNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const path of await candidateFiles('dsh-dingtalk', 'config.json')) {
    const config = await readJson(path);
    const bots = Array.isArray(config?.bots) ? config.bots : [];
    for (const bot of bots) {
      if (!bot || typeof bot !== 'object') continue;
      const list = Array.isArray((bot as Record<string, any>).approvedSenders)
        ? (bot as Record<string, any>).approvedSenders
        : [];
      for (const sender of list) {
        if (!sender || typeof sender !== 'object') continue;
        const rec = sender as Record<string, any>;
        const staffId = typeof rec.staffId === 'string' ? rec.staffId.trim() : '';
        const displayName = typeof rec.displayName === 'string' ? rec.displayName.trim() : '';
        if (staffId && displayName && !names.has(staffId)) names.set(staffId, displayName);
      }
    }
  }
  return names;
}

/** 从 dsh-ding-card 的 user_names.json 读取 { senderId: 姓名 }（profile 级 + 根级）。 */
async function readDingCardNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const path of await candidateFiles('dsh-ding-card', 'user_names.json')) {
    const map = await readJson(path);
    if (!map) continue;
    for (const [userId, name] of Object.entries(map)) {
      const id = typeof userId === 'string' ? userId.trim() : '';
      if (id && typeof name === 'string' && name.trim() && !names.has(id)) names.set(id, name.trim());
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

/**
 * 从 dsh-dingtalk 桥的 state.json 读取活跃发送者。
 *
 * 这是「群历史库为空但机器人确实在被使用」时的主来源：
 *   - `sessions`：`p2p:<staffId>` -> DSH sessionId（单聊会话键里就是 staffId）
 *   - `recentOutboundMessages`：每条带 `conversationKey`（`p2p:<staffId>`）与 `sentAt`
 * 群聊键 `group:<chatId>` 拿不到唯一发送者，跳过。
 */
async function readDingtalkBridgeSenders(): Promise<ImSender[]> {
  const botsDir = join(integrationsDir(), 'dsh-dingtalk', 'bots');
  const byId = new Map<string, ImSender>();
  const touch = (staffId: string, at: number, addCount: number) => {
    const prev = byId.get(staffId);
    if (!prev) {
      byId.set(staffId, { senderId: staffId, senderName: '', lastAt: at, count: Math.max(1, addCount), source: 'dingtalk-bridge' });
      return;
    }
    prev.count += addCount;
    if (at > prev.lastAt) prev.lastAt = at;
  };
  for (const botDir of await listDirs(botsDir)) {
    const state = await readJson(join(botDir, 'state.json'));
    if (!state) continue;
    const sessions = state.sessions;
    if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
      for (const conversationKey of Object.keys(sessions)) {
        const m = /^p2p:(.+)$/.exec(conversationKey);
        const staffId = m?.[1]?.trim();
        // 会话键只说明「有过单聊」，不重复计数
        if (staffId) touch(staffId, 0, 0);
      }
    }
    const outbounds = Array.isArray(state.recentOutboundMessages) ? state.recentOutboundMessages : [];
    for (const rec of outbounds) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, any>;
      const key = typeof r.conversationKey === 'string' ? r.conversationKey : '';
      const m = /^p2p:(.+)$/.exec(key);
      const staffId = m?.[1]?.trim();
      if (!staffId) continue;
      const at = Number.isFinite(r.sentAt) ? Number(r.sentAt) : 0;
      touch(staffId, at, 1);
    }
  }
  return [...byId.values()];
}

/** 构造真实 dsh-im 读取器（只读 sqlite + 钉钉桥 + ding-card / approvedSenders 补姓名）。 */
export function makeImReader(dbPath?: string): ImReader {
  async function sqlitePaths(): Promise<string[]> {
    if (dbPath) return [dbPath];
    return candidateFiles('dsh-im', 'group-history.sqlite');
  }

  async function collectNames(): Promise<{ names: Map<string, string>; extras: ImSender[] }> {
    const names = new Map<string, string>();
    const extras: ImSender[] = [];
    try {
      for (const [id, name] of await readDingCardNames()) {
        if (!names.has(id)) names.set(id, name);
        extras.push({ senderId: id, senderName: name, lastAt: 0, count: 1, source: 'ding-card' });
      }
    } catch { /* ignore */ }
    try {
      for (const [id, name] of await readDingtalkNames()) {
        if (!names.has(id)) names.set(id, name);
        extras.push({ senderId: id, senderName: name, lastAt: 0, count: 1, source: 'dingtalk' });
      }
    } catch { /* ignore */ }
    return { names, extras };
  }

  function mergeAndSort(list: ImSender[], names: Map<string, string>): ImSender[] {
    const byId = new Map<string, ImSender>();
    for (const sender of list) {
      if (!sender.senderId) continue;
      const prev = byId.get(sender.senderId);
      if (!prev) {
        byId.set(sender.senderId, { ...sender });
      } else {
        prev.count += sender.count;
        if (sender.lastAt > prev.lastAt) prev.lastAt = sender.lastAt;
        if (!prev.senderName && sender.senderName) prev.senderName = sender.senderName;
      }
    }
    for (const sender of byId.values()) {
      if (!sender.senderName) sender.senderName = names.get(sender.senderId) ?? '';
    }
    return [...byId.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 200);
  }

  return {
    async readSenders(): Promise<ImSender[]> {
      const all: ImSender[] = [];
      for (const path of await sqlitePaths()) {
        try {
          all.push(...readImSqliteSenders(path));
        } catch { /* ignore */ }
      }
      try {
        all.push(...(await readDingtalkBridgeSenders()));
      } catch { /* ignore */ }
      const { names, extras } = await collectNames();
      all.push(...extras);
      return mergeAndSort(all, names);
    },

    async resolveName(senderId: string): Promise<string | null> {
      const id = (senderId || '').trim();
      if (!id) return null;
      for (const path of await sqlitePaths()) {
        const fromSqlite = resolveNameFromSqlite(path, id);
        if (fromSqlite) return fromSqlite;
      }
      const { names } = await collectNames();
      return names.get(id) ?? null;
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
