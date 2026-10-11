// Proactive follow-ups (主动跟进). Two cases, one message per silence:
//   greet — we greeted and the candidate has not replied for `greetHours` (once per candidate)
//   read  — we sent the last message in a conversation, the candidate read it and has
//           been silent for `readHours` (once per silence; a reply resets it)
// The extension asks for the due list, opens each conversation, confirms nothing new
// arrived (and that our message was read), then asks for the text and sends it.
import { chat, parseJson, llmConfigured } from './llm.js';
import { retrieve } from './kb.js';
import { riskCheck } from './ai.js';
import { clip, j, todayCN, addDays } from './util.js';

const EXCLUDE_ATTEND = new Set(['确认参加', '不来', '不合适']);

/** message time → epoch ms. Platform times are ISO; ours are China local "YYYY-MM-DD HH:MM:SS". */
export function toMs(at) {
  if (!at) return 0;
  const s = String(at);
  if (/T.*(Z|[+-]\d\d:?\d\d)$/.test(s)) return Date.parse(s) || 0;
  return Date.parse(s.replace(' ', 'T') + '+08:00') || 0;
}

/** state of one conversation for follow-up purposes */
export function convState(db, c) {
  const msgs = db.prepare('SELECT dir, by, at FROM messages WHERE candidate_id=?').all(c.id).map(m => ({ ...m, ms: toMs(m.at) })).sort((a, b) => a.ms - b.ms);
  const lastIn = Math.max(0, ...msgs.filter(m => m.dir === 'in').map(m => m.ms));
  const lastOut = Math.max(c.greeted_ms || 0, ...msgs.filter(m => m.dir === 'out').map(m => m.ms));
  return { lastIn, lastOut, hasIn: lastIn > 0, fu: j(c.followup_json, {}) };
}

/** which follow-up (if any) is due for a candidate right now */
export function dueKind(c, st, cfg, now = Date.now()) {
  if (c.is_demo || c.handoff || EXCLUDE_ATTEND.has(c.attend)) return null;
  const fu = st.fu;
  if ((fu.count || 0) >= (cfg.maxTotal ?? 3)) return null;
  if (!st.hasIn) {
    // greeted, never answered
    if (c.greeted_ms && !fu.greet && now - c.greeted_ms >= (cfg.greetHours ?? 3) * 3600e3) return 'greet';
    return null;
  }
  // in conversation: our message is the last one, silence long enough, not yet followed up in this silence
  if (st.lastOut > st.lastIn && now - st.lastOut >= (cfg.readHours ?? 1) * 3600e3 && fu.silenceOf !== st.lastIn) return 'read';
  return null;
}

export function dueList(db, cfg, limit = 5) {
  const rows = db.prepare("SELECT * FROM candidates WHERE is_demo=0 AND handoff=0 AND attend NOT IN ('确认参加','不来','不合适') AND (greeted_ms IS NOT NULL OR id IN (SELECT candidate_id FROM messages WHERE dir='out')) ORDER BY updated_at DESC LIMIT 400").all();
  const out = [];
  for (const c of rows) {
    const st = convState(db, c);
    const kind = dueKind(c, st, cfg);
    if (kind) out.push({ candidateId: c.id, uid: c.uid, name: c.name, job: c.job, platform: c.platform, kind, since: kind === 'greet' ? c.greeted_ms : st.lastOut });
  }
  return out.sort((a, b) => a.since - b.since).slice(0, limit);
}

/** record a sent follow-up */
export function markFollowup(db, c, kind) {
  const st = convState(db, c);
  const fu = { ...st.fu, count: (st.fu.count || 0) + 1, lastAt: Date.now() };
  if (kind === 'greet') fu.greet = Date.now();
  else fu.silenceOf = st.lastIn;
  db.prepare('UPDATE candidates SET followup_json=? WHERE id=?').run(JSON.stringify(fu), c.id);
}

/** the follow-up message: short, natural, one easy question; facts only from the knowledge base */
export async function followupText(kind, c, history, { settings, db, role, offer }) {
  const tomorrow = addDays(todayCN(), 1);
  const offerTxt = (offer || []).map(o => `${o.date === tomorrow ? '明天' : o.date.slice(5)}${o.slot < '12:00' ? '上午' : '下午'} ${o.slot}`).join(' 或 ');
  const passages = db ? retrieve(db, `${role?.name || ''} 岗位 亮点 福利 发展 工作内容`, { role: role?.key }) : [];
  const docText = passages.map(p => `[${p.title}] ${p.text}`).join('\n').slice(0, 2000);
  const org = settings.org || {};
  const fallback = kind === 'greet'
    ? `你好，不知道你还在看${role?.name || '老师'}的机会吗？方便的话回我一下，我跟你简单介绍下岗位情况。`
    : `看你还没回复，是不是对岗位还有什么顾虑，或者还有想了解的地方？有问题随时问我${offerTxt ? `，方便的话也可以约个时间来面试聊聊，${offerTxt}都可以` : ''}。`;
  let reply = fallback, model = null;
  if (llmConfigured() && settings.ai?.enabled) {
    const task = kind === 'greet'
      ? `我们 ${settings.autoReply?.followup?.greetHours ?? 3} 小时前给这位候选人打了招呼，对方还没回复。写一条跟进消息，提高对方回复的意愿：可以点出一个岗位亮点（只能用下面资料里的事实），再加一个很容易回答的问题（例如还在看机会吗、现在是在职还是离职）。不要催促，不要重复招呼语原文，不要说“打扰了”。`
      : `我们最后一条消息对方已读，但约 ${settings.autoReply?.followup?.readHours ?? 1} 小时没有回复。写一条关心式的跟进：问问对方是不是有什么顾虑、或者还有什么想了解的，表示可以随时问；${offerTxt ? `顺带再给一次面试时间选项（${offerTxt}），` : ''}语气轻松，不施压，不要指责对方不回复。`;
    const sys = `你是${org.name || '学校'}的${org.role || '招聘约访官，同时负责初试面试'}，正在招聘「${role?.name || '教师'}」岗位，用第一人称和候选人聊天。${settings.autoReply?.style || ''}
${task}
要求：1–2 句，不超过 60 字；只能使用下面资料里的事实，不得编造数字、薪资、承诺；不写电话、微信号、链接、6 位以上数字；不提年龄、性别、婚育、户籍。
资料：${docText || '（无）'}
只输出 JSON：{"reply":"跟进消息"}`;
    const msgs = [{ role: 'system', content: sys }];
    for (const m of history.slice(-10)) msgs.push({ role: m.dir === 'in' ? 'user' : 'assistant', content: clip(m.text, 300) });
    msgs.push({ role: 'system', content: '只输出 JSON 对象。' });
    try {
      const r = await chat(settings.ai, msgs, { maxTokens: 400, temperature: 0.7 });
      const o = parseJson(r.content);
      if (o && typeof o.reply === 'string' && o.reply.trim()) { reply = clip(o.reply.trim(), 120); model = r.model; }
    } catch (e) { console.error('[followup] ai failed:', clip(e.message, 200)); }
  }
  const risk = riskCheck(reply);
  // numbers must come from the documents or the offered interview times
  const allowed = `${docText} ${(offer || []).map(o => `${o.date.slice(5)} ${o.slot}`).join(' ')}`;
  const badNum = (reply.match(/\d+(?:[.:：]\d+)?/g) || []).some(n => !allowed.includes(n.replace('：', ':')));
  const blocked = risk.platform.length > 0 || risk.guard.length > 0 || badNum;
  if (blocked) reply = fallback;
  return { reply, model: model || '模板', byAi: !!model };
}
