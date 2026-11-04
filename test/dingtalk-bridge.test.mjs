import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDingtalkBridgeSessions } from '../dist/dingtalk-bridge.js';

function makeBotsDir(states) {
  const dir = mkdtempSync(join(tmpdir(), 'mrrp-bridge-'));
  for (const [bot, sessions] of Object.entries(states)) {
    const botDir = join(dir, bot);
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, 'state.json'), JSON.stringify({ version: 1, sessions, seenMessageIds: {} }));
  }
  return dir;
}

test('readDingtalkBridgeSessions：p2p 会话反转为 sessionId -> senderId', async () => {
  const dir = makeBotsDir({
    bot_a: { 'p2p:021724185801860353': 'session-06256e1d-2d71-4976-9370-e885927dffca' },
    bot_b: { 'p2p:0348440911491637184439': 'session-50b980c3-237e-4c53-a857-571f5421cd84' },
  });
  try {
    const m = await readDingtalkBridgeSessions(dir);
    assert.equal(m.size, 2);
    assert.equal(m.get('session-06256e1d-2d71-4976-9370-e885927dffca'), '021724185801860353');
    assert.equal(m.get('session-50b980c3-237e-4c53-a857-571f5421cd84'), '0348440911491637184439');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDingtalkBridgeSessions：非 p2p 会话（群聊）、空会话、坏 JSON 静默跳过', async () => {
  const dir = makeBotsDir({
    bot_a: {
      'p2p:staff_001': 'sess_1',
      'group:chat_001': 'sess_2', // 群聊不解析（无唯一发送者）
      'p2p:': 'sess_3',           // 空 staffId 跳过
    },
  });
  mkdirSync(join(dir, 'bot_b'), { recursive: true });
  writeFileSync(join(dir, 'bot_b', 'state.json'), '{broken json'); // 坏 JSON
  mkdirSync(join(dir, 'bot_c'), { recursive: true }); // 无 state.json
  try {
    const m = await readDingtalkBridgeSessions(dir);
    assert.equal(m.size, 1);
    assert.equal(m.get('sess_1'), 'staff_001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDingtalkBridgeSessions：目录不存在返回空映射（不抛错）', async () => {
  const m = await readDingtalkBridgeSessions(join(tmpdir(), 'mrrp-no-such-bots-dir'));
  assert.equal(m.size, 0);
});
