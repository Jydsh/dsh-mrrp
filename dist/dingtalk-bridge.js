import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/**
 * dsh-dingtalk 桥会话映射：只读读取 dsh-dingtalk 集成的 state.json，
 * 建立「DSH 会话 id -> 钉钉发送者 id」映射。
 *
 * 背景：DSH agent inbox 的 user 消息（agent/inbox/spliced）不携带发送者身份
 * （source 只有 kind:"user" + rpcId）。而 dsh-dingtalk 桥在
 * `~/.dsh/integrations/dsh-dingtalk/bots/<botId>/state.json` 持久化了
 * sessions：`p2p:<staffId>` -> `<DSH session id>`，可直接反查发送者。
 *
 * 只读：绝不写 dsh-dingtalk 数据；文件不存在 / JSON 损坏 / 写入中途 时静默降级
 * （重试一次），不影响 MRRP 主功能。
 */
function dshHome() {
    return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}
/** 尝试解析一份 JSON；坏数据返回 null。 */
async function tryReadJson(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const text = await readFile(path, 'utf8');
            const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        }
        catch {
            // 可能正被 dsh-dingtalk 写入：稍等重试一次
            if (attempt === 0)
                await new Promise((r) => setTimeout(r, 120));
        }
    }
    return null;
}
/**
 * 读取 dsh-dingtalk 桥的会话映射。
 * @param botsDir 覆盖 bots 目录（测试用）；缺省 ~/.dsh/integrations/dsh-dingtalk/bots
 * @returns Map<DSH sessionId, senderId>（多 bot 合并；空对象表示不可用）
 */
export async function readDingtalkBridgeSessions(botsDir) {
    const dir = botsDir ?? join(dshHome(), 'integrations', 'dsh-dingtalk', 'bots');
    const out = new Map();
    let botDirs = [];
    try {
        botDirs = await readdir(dir, { withFileTypes: true }).then((ents) => ents.filter((e) => e.isDirectory()).map((e) => join(dir, e.name)));
    }
    catch {
        return out; // bots 目录不存在 -> 桥未启用，空映射
    }
    for (const botDir of botDirs) {
        const state = await tryReadJson(join(botDir, 'state.json'));
        const sessions = state?.sessions;
        if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions))
            continue;
        for (const [conversationKey, sessionId] of Object.entries(sessions)) {
            if (typeof sessionId !== 'string' || !sessionId)
                continue;
            // 会话键形如 p2p:<staffId>（钉钉单聊）或 group:<chatId>（群聊）
            const m = /^p2p:([^:]+)$/.exec(conversationKey);
            if (!m)
                continue;
            const senderId = m[1].trim();
            if (!senderId)
                continue;
            out.set(sessionId, senderId);
        }
    }
    return out;
}
