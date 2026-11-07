import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { makeImReader } from '../dist/dshim.js';

/** 造一个临时 DSH_HOME，返回 { home, cleanup, path } */
function mkHome() {
  const home = mkdtempSync(join(tmpdir(), 'mrrp-dshim-'));
  return {
    home,
    path: (...parts) => join(home, ...parts),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeBridge(h, bot, sessions, outbounds = []) {
  writeJson(h.path('integrations', 'dsh-dingtalk', 'bots', bot, 'state.json'), {
    version: 1,
    sessions,
    seenMessageIds: [],
    recentOutboundMessages: outbounds,
  });
}

/** 造一个 sqlite 群历史库（只是结构 + 若干消息） */
function writeSqlite(path, rows) {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE messages (
    id TEXT, group_id TEXT, platform_message_id TEXT, sender_id TEXT, sender_name TEXT,
    sent_at INTEGER, received_at INTEGER, type TEXT, text TEXT, thread_id TEXT, reply_to_message_id TEXT
  )`);
  const ins = db.prepare(
    'INSERT INTO messages (id, group_id, platform_message_id, sender_id, sender_name, sent_at, received_at, type, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  rows.forEach((r, i) => ins.run(`m${i}`, 'g1', `p${i}`, r.senderId, r.senderName ?? '', r.sentAt, r.sentAt, 'text', 'hi'));
  db.close();
}

test('readSenders：钉钉桥 p2p 会话是主来源，姓名由 ding-card（profile 级路径）补足', async () => {
  const h = mkHome();
  const oldHome = process.env.DSH_HOME;
  try {
    writeBridge(h, 'bot_a', {
      'p2p:021724185801860353': 'session-a',
      'p2p:0348440911491637184439': 'session-b',
      'group:chat_001': 'session-c',
    }, [
      { conversationKey: 'p2p:021724185801860353', text: 'x', sentAt: 1794059292251 },
      { conversationKey: 'p2p:0348440911491637184439', text: 'y', sentAt: 1793714331215 },
    ]);
    // 关键：ding-card 现在是 profile 级布局
    writeJson(h.path('integrations', 'dsh-ding-card', 'profiles', 'desktop', 'user_names.json'), {
      '021724185801860353': '李鹏',
    });
    process.env.DSH_HOME = h.home;

    const im = makeImReader();
    const senders = await im.readSenders();
    assert.equal(senders.length, 2, '群聊键不应被当成发送者');
    assert.equal(senders[0].senderId, '021724185801860353');
    assert.equal(senders[0].senderName, '李鹏');
    assert.equal(senders[0].lastAt, 1794059292251);
    assert.equal(senders[0].source, 'dingtalk-bridge');
    assert.equal(senders[1].senderId, '0348440911491637184439');
    assert.equal(senders[1].senderName, '', '无姓名源时留空，由上层用 id 兜底');
    assert.equal(await im.resolveName('021724185801860353'), '李鹏');
    assert.equal(await im.resolveName('0348440911491637184439'), null);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    h.cleanup();
  }
});

test('readSenders：群历史库有消息时以 sqlite 姓名优先，并与桥发送者合并去重', async () => {
  const h = mkHome();
  const oldHome = process.env.DSH_HOME;
  try {
    writeSqlite(h.path('integrations', 'dsh-im', 'group-history.sqlite'), [
      { senderId: 'staff_001', senderName: '张三', sentAt: 1000 },
      { senderId: 'staff_001', senderName: '张三', sentAt: 2000 },
      { senderId: 'staff_002', senderName: '李四', sentAt: 3000 },
    ]);
    writeBridge(h, 'bot_a', { 'p2p:staff_002': 'session-x' }, []);
    process.env.DSH_HOME = h.home;

    const im = makeImReader();
    const senders = await im.readSenders();
    const byId = new Map(senders.map((s) => [s.senderId, s]));
    assert.equal(byId.size, 2);
    assert.equal(byId.get('staff_001').senderName, '张三');
    assert.equal(byId.get('staff_001').source, 'im-sqlite');
    assert.equal(byId.get('staff_002').senderName, '李四', '同一 id 的 sqlite 姓名不应丢失');
    assert.equal(await im.resolveName('staff_001'), '张三');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    h.cleanup();
  }
});

test('readSenders：兼容根级 user_names.json 旧布局，并支持 approvedSenders 补姓名', async () => {
  const h = mkHome();
  const oldHome = process.env.DSH_HOME;
  try {
    writeJson(h.path('integrations', 'dsh-ding-card', 'user_names.json'), { 'staff_legacy': '老王' });
    writeJson(h.path('integrations', 'dsh-dingtalk', 'config.json'), {
      version: 1,
      bots: [{ clientId: 'c', approvedSenders: [{ staffId: 'staff_appr', displayName: '审批过的人' }] }],
    });
    process.env.DSH_HOME = h.home;

    const im = makeImReader();
    const senders = await im.readSenders();
    const ids = senders.map((s) => s.senderId).sort();
    assert.deepEqual(ids, ['staff_appr', 'staff_legacy']);
    assert.equal(senders.find((s) => s.senderId === 'staff_legacy').senderName, '老王');
    assert.equal(senders.find((s) => s.senderId === 'staff_appr').senderName, '审批过的人');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    h.cleanup();
  }
});

test('readSenders：数据源全空 / 目录不存在时返回空数组且不抛错', async () => {
  const h = mkHome();
  const oldHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = h.home;
    const im = makeImReader();
    assert.deepEqual(await im.readSenders(), []);
    assert.equal(await im.resolveName('staff_none'), null);
    assert.equal(await im.resolveName(''), null);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    h.cleanup();
  }
});

test('readSenders：坏 JSON 的 state.json 静默跳过，不影响其它 bot', async () => {
  const h = mkHome();
  const oldHome = process.env.DSH_HOME;
  try {
    mkdirSync(h.path('integrations', 'dsh-dingtalk', 'bots', 'bot_bad'), { recursive: true });
    writeFileSync(h.path('integrations', 'dsh-dingtalk', 'bots', 'bot_bad', 'state.json'), '{oops');
    writeBridge(h, 'bot_ok', { 'p2p:staff_ok': 'session-ok' }, []);
    process.env.DSH_HOME = h.home;

    const im = makeImReader();
    const senders = await im.readSenders();
    assert.equal(senders.length, 1);
    assert.equal(senders[0].senderId, 'staff_ok');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    h.cleanup();
  }
});

