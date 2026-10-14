// HTTP server (node:http, no framework). All routes live under BASE (default /hr).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting, addEvent } from './db.js';
import { normalizeZhaopin, screen, mobileIn } from './rules.js';
import { polishReasons, suggestReply, riskCheck, decideMode, guessTopic, reviewScreen, applyReview } from './ai.js';
import { retrieve, kbStats, learnFromChats } from './kb.js';
import { roleFor, screenRole, ROLE_KEYS, tongzhaoOf, eduSalesOf } from './roles.js';
import { dueList, dueKind, convState, markFollowup, followupText } from './followup.js';
import { llmConfigured, chat } from './llm.js';
import { findSlot, book, autoSchedule, interviewerStatus, workDays, activeAppt, halfOf } from './schedule.js';
import { todayCN, nowCN, j, s, clip, weekday, WEEK, randomToken } from './util.js';
import { seedDemo, clearDemo } from './demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = (process.env.HR_BASE || '/hr').replace(/\/+$/, '');
const PORT = Number(process.env.HR_PORT || 3100);
const DB_FILE = process.env.HR_DB || path.join(ROOT, 'data', 'hr.db');
const PUBLIC = path.join(ROOT, 'web');
const EXT_DIR = path.join(ROOT, 'extension');
const ADMIN_USER = process.env.HR_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.HR_ADMIN_PASS || '';

const db = openDb(DB_FILE);
// sort existing candidates into roles by job title (adds 其他; hand-set roles are kept)
{
  const roles = getSetting(db, 'roles');
  const up = db.prepare('UPDATE candidates SET role=? WHERE id=?');
  for (const c of db.prepare('SELECT id, job, role FROM candidates WHERE role_manual=0').all()) {
    const k = roleFor(c.job, roles);
    if (k !== c.role) up.run(k, c.id);
  }
}
// the extension version shipped with this server; the extension compares itself against it
const EXT_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')).version; } catch { return ''; } })();
const secret = getSetting(db, 'session_secret');

// ---------- helpers ----------
const send = (res, code, body, headers = {}) => {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
};
const fail = (res, code, msg) => send(res, code, { error: msg });
const sign = v => crypto.createHmac('sha256', secret).update(v).digest('base64url');
const makeSession = user => { const v = `${user}|${Date.now() + 7 * 86400000}`; return `${Buffer.from(v).toString('base64url')}.${sign(v)}`; };
const readSession = req => {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)hr_sid=([^;]+)/);
  if (!m) return null;
  const [b, sig] = m[1].split('.');
  try {
    const v = Buffer.from(b, 'base64url').toString();
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sign(v)), Buffer.from(sig))) return null;
    const [user, exp] = v.split('|');
    return Number(exp) > Date.now() ? user : null;
  } catch { return null; }
};
const extOk = req => {
  const t = req.headers['x-hr-token'] || '';
  const real = getSetting(db, 'ext_token');
  return t && real && t.length === real.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(real));
};
async function body(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 3e6) throw new Error('body too large'); chunks.push(c); }
  if (!n) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const routes = [];
const route = (method, pattern, auth, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, auth, fn });
};

// ---------- candidate shaping ----------
function candOut(c, full = false) {
  if (!c) return null;
  const appt = db.prepare(`SELECT a.*, i.name interviewer FROM appointments a LEFT JOIN interviewers i ON i.id=a.interviewer_id
    WHERE a.candidate_id=? AND a.status!='已取消' ORDER BY a.id DESC LIMIT 1`).get(c.id);
  const o = {
    id: c.id, platform: c.platform, uid: c.uid, name: c.name, age: c.age, edu: c.edu, school: c.school, schoolTag: c.school_tag,
    major: c.major, years: c.years, careerStatus: c.career_status, expect: c.expect, job: c.job,
    verdict: c.verdict, score: c.score, reason: c.reason, reasonBy: c.reason_by, attend: c.attend, handoff: !!c.handoff,
    role: c.role || 'teacher', roleName: (getSetting(db, 'roles')[c.role || 'teacher'] || {}).name || '教师', roleManual: !!c.role_manual, staffNote: c.staff_note || '', phone: c.phone || '',
    resumeStatus: c.resume_status || '未索要', resumeAt: c.resume_at || null, reserve: !!c.reserve,
    pref: j(c.pref_json, {}), slots: j(c.slots_json, {}), lastNote: c.last_note, source: c.source, owner: c.owner,
    isDemo: !!c.is_demo, createdAt: c.created_at, updatedAt: c.updated_at, appt: appt || null,
  };
  if (full) {
    Object.assign(o, {
      work: j(c.work_json, []), edus: j(c.edu_json, []), skills: j(c.skills_json, []), certs: j(c.certs_json, []), selfEval: c.self_eval,
      rules: j(c.rules_json, []),
      messages: db.prepare('SELECT dir,by,text,at FROM messages WHERE candidate_id=? ORDER BY id DESC LIMIT 60').all(c.id).reverse(),
      events: db.prepare('SELECT at,text FROM events WHERE candidate_id=? ORDER BY id DESC LIMIT 50').all(c.id),
    });
  }
  return o;
}
const getCand = id => db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
const settingsAll = () => ({ org: getSetting(db, 'org'), rules: getSetting(db, 'rules'), schedule: getSetting(db, 'schedule'), ai: getSetting(db, 'ai'), kb: getSetting(db, 'kb'),
  autoReply: getSetting(db, 'autoReply'), kbDoc: getSetting(db, 'kbDoc') || '', playbook: getSetting(db, 'playbook'), roles: getSetting(db, 'roles'), greet: getSetting(db, 'greet') });
const hourAgoCN = () => new Date(Date.now() - 3600e3).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
const autoSentLastHour = () => db.prepare("SELECT COUNT(*) n FROM messages WHERE by='ai-auto' AND at>=?").get(hourAgoCN()).n;

// job role from the job title (教师 / 学管师 / 咨询师); screening uses that role's rules
function roleOf(job) {
  const roles = getSetting(db, 'roles');
  const key = roleFor(job, roles);
  return { key, ...roles[key] };
}
// a short fingerprint of a role's notes: an AI review stays valid while the notes are unchanged
const notesHash = notes => [...String(notes || '')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
const roleByKey = key => { const roles = getSetting(db, 'roles'); const k = roles[key] ? key : 'teacher'; return { key: k, ...roles[k] }; };
// a role set by hand on the candidate wins over the job title
const roleForCand = (c, job) => (c && c.role_manual ? roleByKey(c.role) : roleOf(job || (c && c.job)));
function screenFor(n, job, ex) {
  const role = roleForCand(ex, job);
  const sc = { ...(role.key === 'teacher' ? screen(n, getSetting(db, 'rules')) : screenRole(n, role)), roleKey: role.key };
  // keep an earlier AI review against the notes if the rule verdict and the notes are the same as then
  const prev = ex && j(ex.rules_json, []).find(r => r.id === 'AI');
  if (prev && prev.ruleVerdict === sc.verdict && prev.notesHash === notesHash(role.notes)) {
    return { ...sc, verdict: ex.verdict, score: ex.score, reason: ex.reason, rules: [...sc.rules, prev], keepAi: true };
  }
  return sc;
}
const summaryOf = c => `${c.age ?? '?'}岁 ${c.edu || ''} ${c.school || ''}${c.school_tag ? '(' + c.school_tag + ')' : ''} ${c.major || ''}；经历：${j(c.work_json, []).map(w => `${w.org} ${w.role}`).join('；') || '无'}；学历性质：${j(c.edu_json, []).map(e => e.mode).filter(Boolean).join('、') || '未注明'}；证书：${j(c.certs_json, []).join('、') || '无'}；求职方向：${c.expect || ''}`;
/**
 * AI review of rule verdicts against each role's notes (岗位要求与特殊情况备注). Only for
 * candidates whose role has notes and whose verdict is not 推荐 (plus 推荐 ones on request).
 * Returns {uid: {verdict, score, reason}} for what changed or was explained.
 */
async function reviewCandidates(rows, { includeRecommended = false } = {}) {
  const st = settingsAll(), roles = st.roles || {};
  const items = rows.map(c => { const key = c.role || roleFor(c.job, roles); return { c, key, role: roles[key] || {} }; })
    .filter(x => (x.role.notes || '').trim() && (includeRecommended || x.c.verdict !== '推荐'));
  if (!items.length) return {};
  const out = {};
  for (let i = 0; i < items.length; i += 20) {
    const batch = items.slice(i, i + 20);
    let res = null;
    try { res = await reviewScreen(st, batch.map(x => ({ key: x.c.uid, role: x.role.name, notes: x.role.notes, verdict: x.c.verdict, score: x.c.score, rules: j(x.c.rules_json, []).filter(r => r.id !== 'AI'), summary: summaryOf(x.c) }))); }
    catch (e) { console.error('[review] failed:', clip(e.message, 200)); }
    if (!res) continue;
    for (const x of batch) {
      const p = res.map[x.c.uid];
      if (!p) continue;
      const v = applyReview(x.c.verdict, p.verdict);
      const usedNote = !!p.basis && !/^规则/.test(p.basis);
      const score = v === x.c.verdict ? x.c.score : v === '推荐' ? Math.max(x.c.score || 0, 70) : Math.max(Math.min(x.c.score || 50, 69), 50);
      const reason = p.reason ? `${p.reason}${v !== x.c.verdict && usedNote ? '（按岗位备注）' : ''}` : x.c.reason;
      const rules = j(x.c.rules_json, []).filter(r => r.id !== 'AI');
      rules.push({ id: 'AI', name: '按岗位备注复核', ok: v === '推荐' ? true : v === '不推荐' ? false : null, ev: usedNote ? p.basis : '备注不适用，维持规则结论', ruleVerdict: x.c.verdict, notesHash: notesHash(x.role.notes) });
      db.prepare("UPDATE candidates SET verdict=?, score=?, reason=?, reason_by='ai', rules_json=? WHERE id=?").run(v, score, reason, s(rules), x.c.id);
      if (v !== x.c.verdict) addEvent(db, x.c.id, `AI 按岗位备注复核：${x.c.verdict} → ${v}（${clip(p.basis, 60)}）`);
      out[x.c.uid] = { verdict: v, score, reason, from: x.c.verdict };
    }
  }
  return out;
}
function upsertScreened(platform, job, n, sc, source) {
  const r = upsertScreenedRow(platform, job, n, sc, source);
  if (sc.roleKey) db.prepare('UPDATE candidates SET role=? WHERE id=?').run(sc.roleKey, r.id);
  return getCand(r.id);
}
function upsertScreenedRow(platform, job, n, sc, source) {
  const now = nowCN();
  const ex = db.prepare('SELECT * FROM candidates WHERE platform=? AND uid=?').get(platform, n.uid);
  const vals = [n.name, n.gender, n.age, n.edu, n.school, n.school_tag, n.major, n.years, n.career_status, n.expect, job,
    s(n.work), s(n.edus), s(n.skills), s(n.certs), n.self_eval, sc.verdict, sc.score, s(sc.rules)];
  if (ex) {
    db.prepare(`UPDATE candidates SET name=?,gender=?,age=?,edu=?,school=?,school_tag=?,major=?,years=?,career_status=?,expect=?,job=COALESCE(?,job),
      work_json=?,edu_json=?,skills_json=?,certs_json=?,self_eval=?,verdict=?,score=?,rules_json=?,
      reason=CASE WHEN reason_by='ai' AND verdict=? THEN reason ELSE ? END, reason_by=CASE WHEN reason_by='ai' AND verdict=? THEN reason_by ELSE 'rule' END,
      updated_at=? WHERE id=?`).run(...vals, sc.verdict, sc.reason, sc.verdict, now, ex.id);
    if (sc.keepAi) db.prepare("UPDATE candidates SET reason=?, reason_by='ai' WHERE id=?").run(sc.reason, ex.id);
    return getCand(ex.id);
  }
  const r = db.prepare(`INSERT INTO candidates(platform,uid,name,gender,age,edu,school,school_tag,major,years,career_status,expect,job,
    work_json,edu_json,skills_json,certs_json,self_eval,verdict,score,rules_json,reason,reason_by,source,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'rule',?,?,?)`).run(platform, n.uid, ...vals, sc.reason, source, now, now);
  addEvent(db, Number(r.lastInsertRowid), `${source} 读取，规则初筛：${sc.verdict} ${sc.score} 分`);
  return getCand(Number(r.lastInsertRowid));
}

// ---------- auth ----------
route('POST', '/api/login', 'public', async (req, res) => {
  const b = await body(req);
  if (!ADMIN_PASS) return fail(res, 500, '服务器未设置 HR_ADMIN_PASS');
  const ok = b.username === ADMIN_USER && typeof b.password === 'string' && b.password.length === ADMIN_PASS.length
    && crypto.timingSafeEqual(Buffer.from(b.password), Buffer.from(ADMIN_PASS));
  if (!ok) return fail(res, 401, '用户名或密码错误');
  send(res, 200, { ok: true, user: ADMIN_USER }, { 'Set-Cookie': `hr_sid=${makeSession(ADMIN_USER)}; Path=${BASE}; HttpOnly; SameSite=Lax; Max-Age=604800` });
});
route('POST', '/api/logout', 'public', (req, res) => send(res, 200, { ok: true }, { 'Set-Cookie': `hr_sid=; Path=${BASE}; Max-Age=0` }));
route('GET', '/api/me', 'admin', (req, res, p, user) => send(res, 200, { user, today: todayCN(), llm: llmConfigured() }));
route('GET', '/api/health', 'public', (req, res) => send(res, 200, { ok: true, time: nowCN(), llm: llmConfigured() }));

// ---------- extension endpoints ----------
// last heartbeat per platform and page kind ("zhaopin:im", "boss:rec" …): auto replies only run
// on a 消息 page, so the recommend page and the dashboard warn when none is open
const PAGE_ALIVE_MS = 3 * 60000;
const extPages = () => getSetting(db, 'ext_pages') || {};
const imAlive = () => {
  const pg = extPages(), now = Date.now();
  return Object.fromEntries(['zhaopin', 'boss'].map(p => [p, !!pg[`${p}:im`] && now - pg[`${p}:im`].ms < PAGE_ALIVE_MS]));
};
route('POST', '/api/ext/ping', 'ext', async (req, res) => {
  const b = await body(req);
  setSetting(db, 'ext_last', { at: nowCN(), page: clip(b.page, 60), version: clip(b.version, 20) });
  const platform = b.platform === 'boss' ? 'boss' : b.platform === 'zhaopin' ? 'zhaopin' : '';
  if (platform && ['im', 'rec'].includes(b.kind)) setSetting(db, 'ext_pages', { ...extPages(), [`${platform}:${b.kind}`]: { at: nowCN(), ms: Date.now(), version: clip(b.version, 20) } });
  const ar = getSetting(db, 'autoReply');
  send(res, 200, { ok: true, today: todayCN(), extVersion: EXT_VERSION, imAlive: imAlive(), auto: { enabled: !!ar.enabled, hours: ar.hours, scanUnread: ar.scanUnread !== false, sentLastHour: autoSentLastHour(), maxPerHour: ar.maxPerHour,
    autoInvite: ar.autoInvite !== false, keepImTab: ar.keepImTab !== false, place: getSetting(db, 'org').place } });
});

// page-structure reports from the extension (no message content), kept for tuning
route('POST', '/api/ext/diag', 'ext', async (req, res) => {
  const b = await body(req);
  // chat / invite: 智联; boss / bossRec: BOSS直聘 chat / recommend; stall: self-check report when replies stop
  const kind = ['chat', 'invite', 'boss', 'bossRec', 'rec', 'stall', 'greet'].includes(b.kind) ? b.kind : 'chat';
  const str = JSON.stringify(b.data ?? null);
  const entry = { at: nowCN(), data: str.length > 20000 ? { truncated: true, head: str.slice(0, 20000) } : b.data };
  if (kind === 'stall' || kind === 'greet') { const prev = getSetting(db, `diag_${kind}`); setSetting(db, `diag_${kind}`, { ...entry, list: [entry, ...((prev && prev.list) || [])].slice(0, 10) }); }
  else setSetting(db, `diag_${kind}`, entry);
  send(res, 200, { ok: true });
});
// ---------- proactive follow-ups ----------
// daily greeting cap per platform and role (role from the recommend page's job title)
function greetQuota(platform, job) {
  const roles = getSetting(db, 'roles');
  const role = roleFor(job, roles);
  const cap = Math.max(0, Number((getSetting(db, 'greet').daily || {})[role] ?? 0));
  const used = db.prepare('SELECT COUNT(*) n FROM greet_log WHERE day=? AND platform=? AND role=?').get(todayCN(), platform, role).n;
  return { role, roleName: (roles[role] || {}).name || role, cap, used, left: Math.max(0, cap - used), continuous: getSetting(db, 'greet').continuous !== false };
}
// today's greetings, e.g. { zhaopin: { teacher: 12 }, boss: {} }, shown with the caps on the dashboard
function greetToday() {
  const out = { zhaopin: {}, boss: {} };
  for (const r of db.prepare('SELECT platform, role, COUNT(*) n FROM greet_log WHERE day=? GROUP BY platform, role').all(todayCN())) (out[r.platform] ||= {})[r.role] = r.n;
  return out;
}
route('POST', '/api/ext/greet/quota', 'ext', async (req, res) => {
  const b = await body(req);
  send(res, 200, greetQuota(b.platform === 'boss' ? 'boss' : 'zhaopin', clip(b.job, 40)));
});
// a greeting was sent from the recommend page (counts toward the daily cap; starts the “no reply in N hours” clock)
route('POST', '/api/ext/greeted', 'ext', async (req, res) => {
  const b = await body(req);
  const platform = b.platform === 'boss' ? 'boss' : 'zhaopin';
  const job = clip(b.job, 40);
  db.prepare('INSERT INTO greet_log(day,platform,role,uid,at) VALUES(?,?,?,?,?)').run(todayCN(), platform, roleFor(job, getSetting(db, 'roles')), b.uid ? String(b.uid) : null, nowCN());
  const quota = greetQuota(platform, job);
  const c = b.uid ? db.prepare('SELECT * FROM candidates WHERE platform=? AND uid=?').get(platform, String(b.uid)) : null;
  if (!c) return send(res, 200, { ok: false, quota });
  db.prepare('UPDATE candidates SET greeted_ms=COALESCE(greeted_ms, ?), job=COALESCE(job, ?), attend=CASE WHEN attend=\'未联系\' THEN \'沟通中\' ELSE attend END WHERE id=?').run(Date.now(), job || null, c.id);
  addEvent(db, c.id, '已打招呼');
  send(res, 200, { ok: true, quota });
});
const followCfg = () => (getSetting(db, 'autoReply').followup || {});
route('POST', '/api/ext/followups', 'ext', async (req, res) => {
  const b = await body(req);
  const ar = getSetting(db, 'autoReply'), cfg = followCfg();
  const hm = nowCN().slice(11, 16), [h0, h1] = ar.hours || ['08:30', '21:00'];
  if (!ar.enabled || cfg.enabled === false) return send(res, 200, { due: [], why: '全自动或主动跟进未开启' });
  if (hm < h0 || hm > h1) return send(res, 200, { due: [], why: `不在自动回复时段（${h0}–${h1}）` });
  const platform = b.platform === 'boss' ? 'boss' : 'zhaopin';
  send(res, 200, { due: dueList(db, cfg).filter(x => x.platform === platform) });
});
// the conversation is open on the page: re-check, then write the follow-up
route('POST', '/api/ext/followup/draft', 'ext', async (req, res) => {
  const b = await body(req);
  let c = getCand(Number(b.candidateId));
  if (!c) return fail(res, 404, '候选人不存在');
  storeMessages(c, (b.messages || []).slice(-40));
  c = getCand(c.id);
  const cfg = followCfg();
  const kind = dueKind(c, convState(db, c), cfg);
  if (!kind) return send(res, 200, { skip: true, why: '对方已经回复，或这次冷场已经跟进过' });
  if (kind === 'read' && cfg.onlyIfRead !== false && b.lastOutRead === false) return send(res, 200, { skip: true, why: '对方还没读我们的消息，先不跟进' });
  const st = settingsAll();
  const role = roleForCand(c);
  const offer = ['am', 'pm'].map(half => findSlot(db, { half })).filter(Boolean);
  const history = db.prepare('SELECT dir,text FROM messages WHERE candidate_id=? ORDER BY id').all(c.id);
  const t = await followupText(kind, c, history, { settings: st, db, role, offer });
  const draft = { intent: '跟进', reply: t.reply, parts: [t.reply], followup: kind, checks: { guard: [], platform: [] }, blocked: false, handoff: false,
    byAi: t.byAi, model: t.model, slots: {}, topic: '其他', asked: 1 };
  const decision = decideMode(draft, { autoReply: st.autoReply, override: c.chat_mode || null, nowHM: nowCN().slice(11, 16), sentLastHour: autoSentLastHour() });
  send(res, 200, { candidateId: c.id, draft, decision, kind });
});

// result of clicking the platform's “要附件简历 / 求简历” button
route('POST', '/api/ext/chat/resume', 'ext', async (req, res) => {
  const b = await body(req);
  const c = getCand(Number(b.candidateId));
  if (!c) return fail(res, 404, '候选人不存在');
  if (b.ok && c.resume_status === '未索要') db.prepare("UPDATE candidates SET resume_status='已索要' WHERE id=?").run(c.id);
  addEvent(db, c.id, b.ok ? '已通过平台按钮索要附件简历' : `平台“要附件简历”按钮未成功：${clip(b.msg, 60)}`);
  send(res, 200, { ok: true });
});

// result of an automatic interview invitation
route('POST', '/api/ext/chat/invited', 'ext', async (req, res) => {
  const b = await body(req);
  const c = getCand(Number(b.candidateId));
  if (!c) return fail(res, 404, '候选人不存在');
  addEvent(db, c.id, b.ok ? `已自动发送平台面试邀约：${clip(b.msg, 60)}` : `自动发面试邀约未成功：${clip(b.msg, 80)}`);
  if (b.shape) setSetting(db, 'diag_invite', { at: nowCN(), data: b.shape });
  send(res, 200, { ok: true });
});

// knowledge-base documents: the extension options page can list them and add text documents
const KB_MAX = 500000;
const docList = () => db.prepare('SELECT id,title,source,enabled,role,length(content) chars,updated_at FROM kb_docs ORDER BY id DESC').all();
function addDoc(b, source) {
  const title = clip(String(b.title || '').trim(), 80) || '未命名文档';
  const content = clip(String(b.content || ''), KB_MAX);
  if (!content.trim()) throw new Error('文档内容为空');
  const now = nowCN();
  const role = ['all', ...ROLE_KEYS].includes(b.role) ? b.role : 'all';
  return Number(db.prepare('INSERT INTO kb_docs(title,source,content,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(title, clip(b.source || source, 40), content, role, now, now).lastInsertRowid);
}
route('GET', '/api/ext/kb', 'ext', (req, res) => send(res, 200, { docs: docList(), stats: kbStats(db) }));
route('POST', '/api/ext/kb/docs', 'ext', async (req, res) => {
  const b = await body(req);
  try { send(res, 200, { ok: true, id: addDoc(b, '插件'), stats: kbStats(db) }); } catch (e) { fail(res, 400, e.message); }
});

// a mobile number shown on the open conversation (sent even when no reply is needed)
route('POST', '/api/ext/chat/phones', 'ext', async (req, res) => {
  const b = await body(req);
  const phones = (b.phones || []).map(mobileIn).filter(Boolean).slice(0, 3);
  if (!phones.length) return send(res, 200, { ok: false });
  const c = chatCandidate(b.platform === 'boss' ? 'boss' : 'zhaopin', b);
  for (const p of phones) savePhone(c, p, '平台已显示');
  send(res, 200, { ok: true });
});

// past conversations collected by the extension (stored only; no replies generated)
route('POST', '/api/ext/chat/history', 'ext', async (req, res) => {
  const b = await body(req);
  const platform = b.platform === 'boss' ? 'boss' : 'zhaopin';
  let conv = 0, msgs = 0;
  for (const sess of (b.sessions || []).slice(0, 50)) {
    if (!sess || !(sess.messages || []).length) continue;
    const c = chatCandidate(platform, sess);
    msgs += storeMessages(c, sess.messages.slice(-200)); conv++;
    for (const p of (sess.phones || []).slice(0, 3)) savePhone(c, p, '平台已显示');
    if (c.attend === '未联系') db.prepare("UPDATE candidates SET attend='沟通中' WHERE id=?").run(c.id);
  }
  send(res, 200, { ok: true, conversations: conv, newMessages: msgs });
});

// per-conversation reply mode: 'auto' | 'semi' | 'human' | null (按分类)
route('POST', '/api/ext/chat/mode', 'ext', async (req, res) => {
  const b = await body(req);
  const c = getCand(Number(b.candidateId));
  if (!c) return fail(res, 404, '候选人不存在');
  const m = ['auto', 'semi', 'human'].includes(b.mode) ? b.mode : null;
  db.prepare('UPDATE candidates SET chat_mode=? WHERE id=?').run(m, c.id);
  addEvent(db, c.id, `回复方式改为：${m ? { auto: '全自动', semi: '半自动', human: '转人工' }[m] : '按分类'}`);
  send(res, 200, { ok: true, mode: m });
});

route('POST', '/api/ext/screen', 'ext', async (req, res) => {
  const b = await body(req);
  const platform = b.platform === 'boss' ? 'boss' : 'zhaopin';
  const role = roleOf(b.job);
  const out = [];
  for (const raw of (b.cards || []).slice(0, 60)) {
    const n = normalizeZhaopin(raw);
    if (!n.uid) continue;
    const ex = db.prepare('SELECT * FROM candidates WHERE platform=? AND uid=?').get(platform, n.uid);
    const sc = screenFor(n, b.job, ex);
    const c = upsertScreened(platform, clip(b.job, 40) || null, n, sc, platform === 'zhaopin' ? '智联 推荐列表' : 'BOSS');
    if (n.phone) savePhone(c, n.phone, '简历');
    out.push({ uid: n.uid, id: c.id, verdict: c.verdict, score: c.score, reason: c.reason, reasonBy: c.reason_by, attend: c.attend });
  }
  send(res, 200, { results: out, role: { key: role.key, name: role.name } });
});

// AI reasons for already-screened candidates (slower, called after /screen)
route('POST', '/api/ext/reasons', 'ext', async (req, res) => {
  const b = await body(req);
  const ids = (b.uids || []).slice(0, 30);
  const platform = b.platform === 'boss' ? 'boss' : 'zhaopin';
  const load = () => ids.map(u => db.prepare('SELECT * FROM candidates WHERE platform=? AND uid=?').get(platform, String(u))).filter(Boolean).filter(c => c.reason_by !== 'ai');
  // 1) rule verdicts that are not 推荐 are reviewed against the role's notes (may be widened)
  let verdicts = {};
  try { verdicts = await reviewCandidates(load()); } catch (e) { console.error('[reasons] review failed:', clip(e.message, 200)); }
  // 2) everything not yet explained by the AI gets a one-line reason
  const rows = load();
  let map = Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.reason]));
  try {
    const st = settingsAll();
    const r = await polishReasons(st, rows.map(c => ({
      key: c.uid, verdict: c.verdict, score: c.score, ruleReason: c.reason,
      summary: `${c.age}岁 ${c.edu} ${c.school || ''}${c.school_tag ? '(' + c.school_tag + ')' : ''} ${c.major || ''}；经历：${j(c.work_json, []).map(w => `${w.org} ${w.role}`).join('；')}；证书：${j(c.certs_json, []).join('、') || '无'}`,
    })));
    if (r) {
      const up = db.prepare("UPDATE candidates SET reason=?, reason_by='ai' WHERE platform=? AND uid=?");
      for (const [k, v] of Object.entries(r.map)) { up.run(v, platform, k); map[k] = v; }
    }
  } catch (e) { return send(res, 200, { reasons: map, verdicts, error: clip(e.message, 200) }); }
  send(res, 200, { reasons: map, verdicts });
});

// a chat thread snapshot from the platform page; returns an AI draft
const inflight = new Map();
function chatCandidate(platform, b) {
  let c = b.uid ? db.prepare('SELECT * FROM candidates WHERE platform=? AND uid=?').get(platform, String(b.uid)) : null;
  if (!c) {
    const uid = String(b.uid || 'sess-' + clip(b.sessionId, 40));
    c = db.prepare('SELECT * FROM candidates WHERE platform=? AND uid=?').get(platform, uid);
    if (c) return c;
    const now = nowCN();
    const r = db.prepare(`INSERT INTO candidates(platform,uid,name,job,role,attend,source,created_at,updated_at,verdict,score,reason,reason_by)
      VALUES(?,?,?,?,?,'沟通中',?,?,?,'待确认',50,'仅有聊天记录，未读取简历','rule')`).run(platform, uid, clip(b.name, 20), clip(b.job, 40), roleOf(b.job).key, platform === 'zhaopin' ? '智联 聊天' : 'BOSS 聊天', now, now);
    c = getCand(Number(r.lastInsertRowid));
  }
  return c;
}
// record a mobile number for the candidate (first one wins unless replaced by hand)
function savePhone(c, phone, how) {
  const p = mobileIn(phone);
  if (!p || !c || c.phone === p) return;
  if (c.phone && how !== 'staff') return;
  db.prepare('UPDATE candidates SET phone=? WHERE id=?').run(p, c.id);
  c.phone = p;
  addEvent(db, c.id, `登记手机号（${how}）：${p.slice(0, 3)}****${p.slice(-4)}`);
}
function storeMessages(c, list) {
  const ins = db.prepare('INSERT OR IGNORE INTO messages(candidate_id,dir,by,text,platform_msg_id,at) VALUES(?,?,?,?,?,?)');
  let n = 0;
  for (const m of list) {
    if (!m || !m.text) continue;
    // a number the candidate sent us (typed or in an exchange card)
    if (m.dir === 'in') savePhone(c, m.text, '聊天中对方发来');
    // an attachment resume arrived → mark it and put the candidate into the talent reserve
    if (m.dir === 'in' && /^\[卡片·附件简历\]/.test(m.text) && c.resume_status !== '已收到') {
      db.prepare("UPDATE candidates SET resume_status='已收到', resume_at=?, reserve=1 WHERE id=?").run(nowCN(), c.id);
      c.resume_status = '已收到';
      addEvent(db, c.id, '收到附件简历，已加入人才库');
    }
    n += ins.run(c.id, m.dir === 'in' ? 'in' : 'out', m.dir === 'in' ? 'candidate' : 'staff', clip(m.text, 1000), String(m.id || crypto.createHash('md5').update(m.dir + m.text + (m.at || '')).digest('hex')), clip(m.at, 30) || nowCN()).changes;
  }
  return n;
}
// history for the AI: messages + candidate questions asked before the current unanswered ones
function chatContext(cid) {
  const rows = db.prepare('SELECT id,dir,text,topic FROM messages WHERE candidate_id=? ORDER BY id').all(cid);
  const lastOut = rows.map(r => r.dir).lastIndexOf('out');
  // an outgoing message sent word for word to 2+ candidates is a template greeting, not a reply
  const tpl = db.prepare("SELECT COUNT(DISTINCT candidate_id) n FROM messages WHERE dir='out' AND text=?");
  const isTpl = r => r.dir === 'out' && (/^\[?(再次)?招呼语/.test(r.text) || tpl.get(r.text).n >= 2);
  return {
    history: rows.map(r => ({ dir: r.dir, text: r.text, tpl: isTpl(r) })),
    earlierQuestions: rows.slice(0, Math.max(0, lastOut)).filter(r => r.dir === 'in').map(r => ({ text: r.text, topic: r.topic })),
    unansweredIds: rows.slice(lastOut + 1).filter(r => r.dir === 'in').map(r => r.id),
  };
}
const tagTopic = (ids, topic) => { const up = db.prepare('UPDATE messages SET topic=? WHERE id=?'); for (const id of ids) up.run(topic, id); };

route('POST', '/api/ext/chat/suggest', 'ext', async (req, res) => {
  const b = await body(req);
  const platform = b.platform === 'boss' ? 'boss' : 'zhaopin';
  let c = chatCandidate(platform, b);
  // resume shown in the chat (candidate applied): screen it with the same rules as the recommend page
  if (b.profile && typeof b.profile === 'object') {
    const n = normalizeZhaopin({ ...b.profile, resumeNumber: c.uid, userName: b.profile.userName || b.name });
    if (n.edu || n.age != null || n.work.length) {
      c = upsertScreened(platform, clip(b.job, 40) || null, n, screenFor(n, b.job || c.job, c), platform === 'zhaopin' ? '智联 聊天（投递）' : 'BOSS 聊天');
      // an applicant the rules reject gets the notes review before the first reply (so nobody suitable is declined)
      if (c.verdict !== '推荐' && !j(c.rules_json, []).some(r => r.id === 'AI')) { await reviewCandidates([c]); c = getCand(c.id); }
    }
  }
  const role = roleForCand(c, b.job || c.job);
  if (c.role !== role.key) db.prepare('UPDATE candidates SET role=? WHERE id=?').run(role.key, c.id);
  // 统招 already known from the resume (or not required thanks to education-sales experience): don't ask in chat
  if (role.rules?.requireTongzhao) {
    const sl = j(c.slots_json, {});
    if (!sl.tongzhao) {
      const tz = tongzhaoOf(j(c.edu_json, []), role.rules.minEdu);
      const v = role.rules.eduSalesException && eduSalesOf(j(c.work_json, [])) ? '不要求（有教育行业销售经验）' : tz === true ? '统招' : tz === false ? '非统招' : null;
      if (v) { sl.tongzhao = v; db.prepare('UPDATE candidates SET slots_json=? WHERE id=?').run(s(sl), c.id); c = getCand(c.id); }
    }
  }
  storeMessages(c, (b.messages || []).slice(-40));
  // numbers the page shows for this conversation (exchange card / unlocked resume)
  for (const p of (b.phones || []).slice(0, 3)) savePhone(c, p, '平台已显示');
  if (b.profile && b.profile.phone) savePhone(c, b.profile.phone, '简历');
  if (c.attend === '未联系') db.prepare("UPDATE candidates SET attend='沟通中' WHERE id=?").run(c.id);
  const cx = chatContext(c.id);
  const st = settingsAll();
  const appt = activeAppt(db, c.id);
  const origin = ['applied', 'greeted'].includes(b.origin) ? b.origin : 'unknown';
  const offer = ['am', 'pm'].map(half => findSlot(db, { half })).filter(Boolean);
  // the same conversation asked twice at once (double click, two tabs): share one AI call
  const key = `${c.id}:${cx.history.length}:${cx.history.at(-1)?.text || ''}`;
  if (!inflight.has(key)) {
    inflight.set(key, suggestReply({ ...c, slots: j(c.slots_json, {}) }, cx.history, { settings: st, appt, db, earlierQuestions: cx.earlierQuestions, origin, offer, role })
      .finally(() => setTimeout(() => inflight.delete(key), 3000)));
  }
  const d = await inflight.get(key);
  if (d.topic) tagTopic(cx.unansweredIds, d.topic);
  if (d.declineTz) {
    db.prepare("UPDATE candidates SET verdict='不推荐', score=MIN(COALESCE(score,40),40), reason=?, reason_by='rule' WHERE id=?").run(`聊天中确认为非统招学历，${role.name}要求统招大专及以上`, c.id);
    addEvent(db, c.id, '聊天中确认非统招学历 → 不推荐，礼貌婉拒');
  }
  // persist extracted slots (no state change until the staff sends)
  const slots = { ...j(c.slots_json, {}), ...d.slots };
  db.prepare('UPDATE candidates SET slots_json=?, updated_at=? WHERE id=?').run(s(slots), nowCN(), c.id);
  const decision = decideMode(d, { autoReply: st.autoReply, override: c.chat_mode || null, nowHM: nowCN().slice(11, 16), sentLastHour: autoSentLastHour() });
  const now = getCand(c.id);
  send(res, 200, { candidateId: c.id, draft: d, decision, chatMode: c.chat_mode || null, attend: now.attend,
    screen: { verdict: now.verdict, score: now.score, reason: now.reason, origin, hasResume: !!b.profile, role: role.name } });
});

// staff confirmed (sent) a draft in the platform → apply its state change
route('POST', '/api/ext/chat/applied', 'ext', async (req, res) => {
  const b = await body(req);
  const c = getCand(Number(b.candidateId));
  if (!c) return fail(res, 404, '候选人不存在');
  const d = b.draft || {};
  if (d.reply) db.prepare('INSERT INTO messages(candidate_id,dir,by,text,at) VALUES(?,?,?,?,?)').run(c.id, 'out', b.auto ? 'ai-auto' : 'ai', clip(d.reply, 1000), nowCN());
  if (b.auto) addEvent(db, c.id, `AI 全自动回复（${d.intent || ''}）`);
  if (d.followup && d.reply) { markFollowup(db, getCand(c.id), d.followup); addEvent(db, c.id, d.followup === 'greet' ? '打招呼未回复，已发跟进' : '已读未回复，已发跟进'); }
  if (d.resumeAsk && d.reply && getCand(c.id).resume_status === '未索要') {
    db.prepare("UPDATE candidates SET resume_status='已索要' WHERE id=?").run(c.id);
    addEvent(db, c.id, '约聊中已索要附件简历');
  }
  applyDraft(c, d);
  send(res, 200, { ok: true, candidate: candOut(getCand(c.id)) });
});

function applyDraft(c, d) {
  const now = nowCN();
  if (d.action === '约面试' && d.slot && d.slot.date && d.slot.slot) {
    book(db, c.id, d.slot.date, d.slot.slot, '待确认');
    db.prepare('UPDATE candidates SET pref_json=?, last_note=? WHERE id=?').run(s({ half: halfOf(d.slot.slot) }), `已约 ${d.slot.date} ${d.slot.slot} 到场，等候选人确认。`, c.id);
  }
  const sc = d.stateChange || {};
  if (sc.attend && !(d.action === '约面试')) {
    db.prepare('UPDATE candidates SET attend=?, updated_at=? WHERE id=?').run(sc.attend, now, c.id);
    addEvent(db, c.id, `约聊结果：${sc.attend}`);
  }
  if (sc.apptStatus) db.prepare("UPDATE appointments SET status=? WHERE candidate_id=? AND status IN ('待确认','确认参加','改期中')").run(sc.apptStatus, c.id);
  if (d.intent === '约面时间' && !d.slot && d.slots?.half) {
    db.prepare("UPDATE candidates SET attend='待排程', pref_json=? WHERE id=?").run(s({ half: d.slots.half, date: d.slots.day || null }), c.id);
  }
  if (d.handoff) {
    db.prepare('UPDATE candidates SET handoff=1, last_note=? WHERE id=?').run(`转人工：${d.handoffWhy || ''}`, c.id);
    addEvent(db, c.id, `转人工：${d.handoffWhy || ''}`);
  } else if (d.reply) {
    db.prepare('UPDATE candidates SET last_note=? WHERE id=?').run(clip(`AI：${d.reply}`, 120), c.id);
  }
}

// ---------- admin API ----------
route('GET', '/api/stats', 'admin', (req, res) => {
  const today = todayCN();
  const byAttend = Object.fromEntries(db.prepare('SELECT attend, COUNT(*) n FROM candidates GROUP BY attend').all().map(r => [r.attend, r.n]));
  const screenedToday = db.prepare("SELECT COUNT(*) n, SUM(verdict='推荐') ok FROM candidates WHERE substr(created_at,1,10)=?").get(today);
  const todayAppts = db.prepare("SELECT COUNT(*) n, SUM(desk IN ('已分配','已结束')) asg FROM appointments WHERE date=? AND status IN ('待确认','确认参加')").get(today);
  const sched = getSetting(db, 'schedule');
  const days = workDays(sched, today, sched.days).map(d => ({
    date: d, week: WEEK[weekday(d)],
    n: db.prepare("SELECT COUNT(*) n FROM appointments WHERE date=? AND status IN ('待确认','确认参加')").get(d).n,
  }));
  const todo = [
    ...db.prepare("SELECT id,name,'待你确认' k, reason d FROM candidates WHERE verdict='待确认' AND attend IN ('未联系','沟通中') ORDER BY updated_at DESC LIMIT 6").all(),
    ...db.prepare("SELECT id,name,'转人工' k, last_note d FROM candidates WHERE handoff=1 ORDER BY updated_at DESC LIMIT 6").all(),
    ...db.prepare("SELECT id,name,'改期中' k, last_note d FROM candidates WHERE attend='改期中' LIMIT 6").all(),
  ];
  send(res, 200, {
    today, total: db.prepare('SELECT COUNT(*) n FROM candidates').get().n, byAttend,
    screenedToday: screenedToday.n || 0, recommendedToday: screenedToday.ok || 0,
    todayInterviews: todayAppts.n || 0, todayAssigned: todayAppts.asg || 0,
    pending: byAttend['待排程'] || 0, days, todo, interviewers: interviewerStatus(db, today),
    ext: getSetting(db, 'ext_last'), extPages: extPages(), imAlive: imAlive(), greetToday: greetToday(), greet: getSetting(db, 'greet'), llm: llmConfigured(),
  });
});

route('GET', '/api/candidates', 'admin', (req, res, p, u, q) => {
  const where = [], args = [];
  if (q.get('attend')) { where.push('attend=?'); args.push(q.get('attend')); }
  if (q.get('verdict')) { where.push('verdict=?'); args.push(q.get('verdict')); }
  if (q.get('q')) { where.push("(name LIKE ? OR school LIKE ? OR major LIKE ? OR job LIKE ? OR staff_note LIKE ? OR phone LIKE ?)"); const v = `%${q.get('q')}%`; args.push(v, v, v, v, v, v); }
  // 岗位 filter (教师 / 学管师 / 课程顾问 / 其他) and 备注 filter (有备注 / 无备注 / a word in the note)
  if (q.get('role') && ROLE_KEYS.includes(q.get('role'))) { where.push("COALESCE(role,'teacher')=?"); args.push(q.get('role')); }
  // 人才库（储备）and attachment-resume status
  if (q.get('reserve') === '1') where.push('reserve=1');
  if (['未索要', '已索要', '已收到'].includes(q.get('resume'))) { where.push('resume_status=?'); args.push(q.get('resume')); }
  const note = q.get('note') || '';
  if (note === 'has') where.push("TRIM(COALESCE(staff_note,''))!=''");
  else if (note === 'none') where.push("TRIM(COALESCE(staff_note,''))=''");
  else if (note) { where.push('staff_note LIKE ?'); args.push(`%${note}%`); }
  const order = q.get('order') === 'score' ? 'score DESC, updated_at DESC' : 'updated_at DESC';
  const rows = db.prepare(`SELECT * FROM candidates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 500`).all(...args);
  // counts for the tabs follow the role filter, so 来不来 numbers match the chosen 岗位
  const roleWhere = q.get('role') && ROLE_KEYS.includes(q.get('role')) ? ["COALESCE(role,'teacher')=?", [q.get('role')]] : ['1=1', []];
  const counts = Object.fromEntries(db.prepare(`SELECT attend, COUNT(*) n FROM candidates WHERE ${roleWhere[0]} GROUP BY attend`).all(...roleWhere[1]).map(r => [r.attend, r.n]));
  const vcounts = Object.fromEntries(db.prepare('SELECT verdict, COUNT(*) n FROM candidates GROUP BY verdict').all().map(r => [r.verdict, r.n]));
  const rcounts = Object.fromEntries(db.prepare("SELECT COALESCE(role,'teacher') r, COUNT(*) n FROM candidates GROUP BY r").all().map(r => [r.r, r.n]));
  const ncount = db.prepare("SELECT COUNT(*) n FROM candidates WHERE TRIM(COALESCE(staff_note,''))!=''").get().n;
  const reserveCount = db.prepare('SELECT COUNT(*) n FROM candidates WHERE reserve=1').get().n;
  const resumeCounts = Object.fromEntries(db.prepare('SELECT resume_status s, COUNT(*) n FROM candidates GROUP BY s').all().map(r => [r.s, r.n]));
  send(res, 200, { rows: rows.map(c => candOut(c)), counts, vcounts, rcounts, ncount, reserveCount, resumeCounts });
});
route('GET', '/api/candidates/:id', 'admin', (req, res, p) => {
  const c = getCand(Number(p.id));
  c ? send(res, 200, candOut(c, true)) : fail(res, 404, '候选人不存在');
});
route('PATCH', '/api/candidates/:id', 'admin', async (req, res, p) => {
  const b = await body(req), c = getCand(Number(p.id));
  if (!c) return fail(res, 404, '候选人不存在');
  const ATT = ['未联系', '沟通中', '待排程', '待确认', '确认参加', '改期中', '不来', '未回复'];
  if (b.attend && ATT.includes(b.attend)) {
    db.prepare('UPDATE candidates SET attend=?, updated_at=? WHERE id=?').run(b.attend, nowCN(), c.id);
    if (['不来', '未回复'].includes(b.attend)) db.prepare("UPDATE appointments SET status='已取消' WHERE candidate_id=? AND status IN ('待确认','确认参加','改期中')").run(c.id);
    if (['确认参加', '改期中'].includes(b.attend)) db.prepare("UPDATE appointments SET status=? WHERE candidate_id=? AND status IN ('待确认','确认参加','改期中')").run(b.attend, c.id);
    addEvent(db, c.id, `专员修改状态：${b.attend}`);
  }
  if (b.pref) db.prepare('UPDATE candidates SET pref_json=? WHERE id=?').run(s({ half: ['am', 'pm', 'any', 'none'].includes(b.pref.half) ? b.pref.half : 'any', date: b.pref.date || null, note: clip(b.pref.note, 60) }), c.id);
  if (b.handoff === false) db.prepare('UPDATE candidates SET handoff=0 WHERE id=?').run(c.id);
  if (typeof b.verdict === 'string' && ['推荐', '待确认', '不推荐'].includes(b.verdict)) {
    db.prepare("UPDATE candidates SET verdict=?, reason=?, reason_by='staff' WHERE id=?").run(b.verdict, clip(b.reason || `专员改判：${b.verdict}`, 80), c.id);
    addEvent(db, c.id, `专员改判：${b.verdict}${b.reason ? '（' + clip(b.reason, 40) + '）' : ''}`);
  }
  if (typeof b.note === 'string') db.prepare('UPDATE candidates SET last_note=? WHERE id=?').run(clip(b.note, 120), c.id);
  if (typeof b.reserve === 'boolean') {
    db.prepare('UPDATE candidates SET reserve=? WHERE id=?').run(b.reserve ? 1 : 0, c.id);
    addEvent(db, c.id, b.reserve ? '加入人才库' : '移出人才库');
  }
  if (['未索要', '已索要', '已收到'].includes(b.resumeStatus)) {
    db.prepare('UPDATE candidates SET resume_status=?, resume_at=CASE WHEN ?=\'已收到\' THEN COALESCE(resume_at, ?) ELSE resume_at END WHERE id=?').run(b.resumeStatus, b.resumeStatus, nowCN(), c.id);
    addEvent(db, c.id, `附件简历状态改为：${b.resumeStatus}`);
  }
  if (typeof b.phone === 'string') {
    const p = b.phone.trim();
    if (p && !mobileIn(p)) return fail(res, 400, '请输入 11 位手机号');
    if (p) savePhone(c, p, 'staff');
    else { db.prepare('UPDATE candidates SET phone=NULL WHERE id=?').run(c.id); addEvent(db, c.id, '清空手机号'); }
  }
  if (typeof b.staffNote === 'string') {
    db.prepare('UPDATE candidates SET staff_note=? WHERE id=?').run(clip(b.staffNote.trim(), 300), c.id);
    addEvent(db, c.id, b.staffNote.trim() ? `备注：${clip(b.staffNote.trim(), 60)}` : '清空备注');
  }
  // change the role by hand (kept from then on); 'auto' goes back to recognising it from the job title
  if (typeof b.role === 'string' && (ROLE_KEYS.includes(b.role) || b.role === 'auto')) {
    const manual = b.role !== 'auto';
    const key = manual ? b.role : roleOf(c.job).key;
    db.prepare('UPDATE candidates SET role=?, role_manual=? WHERE id=?').run(key, manual ? 1 : 0, c.id);
    addEvent(db, c.id, manual ? `专员改岗位：${roleByKey(key).name}` : `岗位改回按职位名自动识别：${roleByKey(key).name}`);
  }
  send(res, 200, candOut(getCand(c.id), true));
});

// manual chat test from admin (no platform involved)
route('POST', '/api/candidates/:id/chat-test', 'admin', async (req, res, p) => {
  const b = await body(req), c = getCand(Number(p.id));
  if (!c) return fail(res, 404, '候选人不存在');
  if (b.text) db.prepare('INSERT INTO messages(candidate_id,dir,by,text,at) VALUES(?,?,?,?,?)').run(c.id, 'in', 'candidate', clip(b.text, 500), nowCN());
  if (c.attend === '未联系') db.prepare("UPDATE candidates SET attend='沟通中' WHERE id=?").run(c.id);
  const cx = chatContext(c.id);
  const d = await suggestReply({ ...c, slots: j(c.slots_json, {}) }, cx.history, { settings: settingsAll(), appt: activeAppt(db, c.id), db, earlierQuestions: cx.earlierQuestions,
    role: roleForCand(c), offer: ['am', 'pm'].map(half => findSlot(db, { half })).filter(Boolean) });
  if (d.topic) tagTopic(cx.unansweredIds, d.topic);
  db.prepare('UPDATE candidates SET slots_json=? WHERE id=?').run(s({ ...j(c.slots_json, {}), ...d.slots }), c.id);
  if (b.apply && !d.blocked) {
    db.prepare('INSERT INTO messages(candidate_id,dir,by,text,at) VALUES(?,?,?,?,?)').run(c.id, 'out', 'ai', d.reply, nowCN());
    applyDraft(getCand(c.id), d);
  } else if (b.apply && d.blocked) applyDraft(getCand(c.id), { handoff: true, handoffWhy: d.handoffWhy });
  const st = settingsAll();
  const decision = decideMode(d, { autoReply: st.autoReply, override: c.chat_mode || null, nowHM: nowCN().slice(11, 16), sentLastHour: autoSentLastHour() });
  send(res, 200, { draft: d, decision, candidate: candOut(getCand(c.id), true) });
});

// schedule
route('GET', '/api/schedule', 'admin', (req, res, p, u, q) => {
  const today = todayCN(), sched = getSetting(db, 'schedule');
  const days = workDays(sched, today, sched.days);
  const date = q.get('date') || days[0];
  const appts = db.prepare(`SELECT a.*, c.name, c.job, c.edu, c.school, c.major, c.score, c.attend, i.name interviewer
    FROM appointments a JOIN candidates c ON c.id=a.candidate_id LEFT JOIN interviewers i ON i.id=a.interviewer_id
    WHERE a.date=? AND a.status IN ('待确认','确认参加') ORDER BY a.slot, a.id`).all(date);
  const dayInfo = days.map(d => {
    const r = db.prepare(`SELECT COUNT(*) n, SUM(slot<'12:00') am, SUM(desk IN ('已分配','已结束')) asg FROM appointments WHERE date=? AND status IN ('待确认','确认参加')`).get(d);
    return { date: d, week: WEEK[weekday(d)], n: r.n || 0, am: r.am || 0, pm: (r.n || 0) - (r.am || 0), assigned: r.asg || 0 };
  });
  const pending = db.prepare("SELECT id,name,job,score,pref_json FROM candidates WHERE attend='待排程' ORDER BY score DESC").all().map(c => ({ ...c, pref: j(c.pref_json, {}) }));
  send(res, 200, { today, date, isToday: date === today, days: dayInfo, sched, appts, pending, interviewers: interviewerStatus(db, today), place: getSetting(db, 'org').place });
});
route('POST', '/api/schedule/auto', 'admin', (req, res) => send(res, 200, autoSchedule(db)));
route('POST', '/api/appointments', 'admin', async (req, res) => {
  const b = await body(req), c = getCand(Number(b.candidateId));
  if (!c) return fail(res, 404, '候选人不存在');
  const sched = getSetting(db, 'schedule');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || ![...sched.am, ...sched.pm].includes(b.slot)) return fail(res, 400, '日期或时段不合法');
  book(db, c.id, b.date, b.slot, b.status === '确认参加' ? '确认参加' : '待确认');
  send(res, 200, { ok: true });
});
route('POST', '/api/appointments/:id/assign', 'admin', async (req, res, p) => {
  const b = await body(req);
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(Number(p.id));
  if (!a) return fail(res, 404, '预约不存在');
  if (a.date !== todayCN()) return fail(res, 400, '只能在面试当天分配面试官');
  const iv = db.prepare('SELECT * FROM interviewers WHERE id=? AND active=1').get(Number(b.interviewerId));
  if (!iv) return fail(res, 400, '面试官不存在');
  const busy = db.prepare("SELECT 1 FROM appointments WHERE interviewer_id=? AND desk='已分配' AND date=?").get(iv.id, a.date);
  if (busy && !b.force) return fail(res, 409, `${iv.name} 正在面试，确认要分配请再点一次`);
  db.prepare("UPDATE appointments SET interviewer_id=?, desk='已分配', assigned_at=?, status='确认参加' WHERE id=?").run(iv.id, nowCN(), a.id);
  db.prepare("UPDATE candidates SET attend='确认参加', last_note=? WHERE id=?").run(`已到场，前台分配给 ${iv.name} 面试。`, a.candidate_id);
  addEvent(db, a.candidate_id, `到场，前台分配面试官 ${iv.name}`);
  send(res, 200, { ok: true });
});
route('POST', '/api/appointments/:id/finish', 'admin', async (req, res, p) => {
  const a = db.prepare('SELECT a.*, i.name iv FROM appointments a LEFT JOIN interviewers i ON i.id=a.interviewer_id WHERE a.id=?').get(Number(p.id));
  if (!a) return fail(res, 404, '预约不存在');
  db.prepare("UPDATE appointments SET desk='已结束', finished_at=? WHERE id=?").run(nowCN(), a.id);
  db.prepare('UPDATE candidates SET last_note=? WHERE id=?').run(`初试已结束（面试官 ${a.iv || ''}）。`, a.candidate_id);
  addEvent(db, a.candidate_id, `初试结束（面试官 ${a.iv || ''}）`);
  send(res, 200, { ok: true });
});
route('POST', '/api/appointments/:id/noshow', 'admin', async (req, res, p) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(Number(p.id));
  if (!a) return fail(res, 404, '预约不存在');
  db.prepare("UPDATE appointments SET desk='未到' WHERE id=?").run(a.id);
  db.prepare("UPDATE candidates SET last_note='约定时间未到场。' WHERE id=?").run(a.candidate_id);
  addEvent(db, a.candidate_id, '约定时间未到场');
  send(res, 200, { ok: true });
});
route('POST', '/api/appointments/:id/unassign', 'admin', async (req, res, p) => {
  db.prepare("UPDATE appointments SET desk='未分配', interviewer_id=NULL, assigned_at=NULL WHERE id=?").run(Number(p.id));
  send(res, 200, { ok: true });
});

// interviewers
route('GET', '/api/interviewers', 'admin', (req, res) => send(res, 200, db.prepare('SELECT * FROM interviewers ORDER BY active DESC, sort, id').all()));
route('POST', '/api/interviewers', 'admin', async (req, res) => {
  const b = await body(req);
  if (!b.name || !String(b.name).trim()) return fail(res, 400, '请填写姓名');
  db.prepare('INSERT INTO interviewers(name,sort) VALUES(?,?)').run(clip(b.name.trim(), 20), 99);
  send(res, 200, { ok: true });
});
route('PATCH', '/api/interviewers/:id', 'admin', async (req, res, p) => {
  const b = await body(req);
  if (typeof b.name === 'string' && b.name.trim()) db.prepare('UPDATE interviewers SET name=? WHERE id=?').run(clip(b.name.trim(), 20), Number(p.id));
  if (typeof b.active === 'boolean') db.prepare('UPDATE interviewers SET active=? WHERE id=?').run(b.active ? 1 : 0, Number(p.id));
  send(res, 200, { ok: true });
});

// settings
route('GET', '/api/settings', 'admin', (req, res) => send(res, 200, { ...settingsAll(), extToken: getSetting(db, 'ext_token'), ext: getSetting(db, 'ext_last'), extPages: extPages(), imAlive: imAlive(), greetToday: greetToday(), llm: llmConfigured() }));
route('PUT', '/api/settings', 'admin', async (req, res) => {
  const b = await body(req);
  for (const k of ['org', 'rules', 'schedule', 'ai', 'kb', 'autoReply', 'playbook', 'roles', 'greet']) if (b[k] !== undefined) setSetting(db, k, b[k]);
  if (typeof b.kbDoc === 'string') setSetting(db, 'kbDoc', clip(b.kbDoc, 20000));
  send(res, 200, settingsAll());
});
// knowledge base (documents)
route('GET', '/api/kb/docs', 'admin', (req, res) => send(res, 200, { docs: docList(), stats: kbStats(db), learned: getSetting(db, 'learned'), playbook: getSetting(db, 'playbook') }));
route('GET', '/api/kb/docs/:id', 'admin', (req, res, p) => {
  const d = db.prepare('SELECT * FROM kb_docs WHERE id=?').get(Number(p.id));
  d ? send(res, 200, d) : fail(res, 404, '文档不存在');
});
route('POST', '/api/kb/docs', 'admin', async (req, res) => {
  const b = await body(req);
  try { send(res, 200, { ok: true, id: addDoc(b, '后台'), stats: kbStats(db) }); } catch (e) { fail(res, 400, e.message); }
});
route('PATCH', '/api/kb/docs/:id', 'admin', async (req, res, p) => {
  const b = await body(req), id = Number(p.id);
  if (!db.prepare('SELECT 1 FROM kb_docs WHERE id=?').get(id)) return fail(res, 404, '文档不存在');
  if (typeof b.title === 'string' && b.title.trim()) db.prepare('UPDATE kb_docs SET title=? WHERE id=?').run(clip(b.title.trim(), 80), id);
  if (typeof b.content === 'string' && b.content.trim()) db.prepare('UPDATE kb_docs SET content=? WHERE id=?').run(clip(b.content, KB_MAX), id);
  if (typeof b.enabled === 'boolean') db.prepare('UPDATE kb_docs SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, id);
  if (['all', ...ROLE_KEYS].includes(b.role)) db.prepare('UPDATE kb_docs SET role=? WHERE id=?').run(b.role, id);
  db.prepare('UPDATE kb_docs SET updated_at=? WHERE id=?').run(nowCN(), id);
  send(res, 200, { ok: true, stats: kbStats(db) });
});
route('DELETE', '/api/kb/docs/:id', 'admin', (req, res, p) => {
  db.prepare('DELETE FROM kb_docs WHERE id=?').run(Number(p.id));
  send(res, 200, { ok: true, stats: kbStats(db) });
});
route('POST', '/api/kb/search', 'admin', async (req, res) => {
  const b = await body(req);
  const q = clip(String(b.q || ''), 300);
  send(res, 200, { topic: guessTopic(q), passages: retrieve(db, q, { topic: guessTopic(q) }) });
});
route('POST', '/api/kb/learn', 'admin', async (req, res) => {
  const r = await learnFromChats(db, getSetting(db, 'ai'));
  if (r.ok) {
    setSetting(db, 'learned', r);
    // the recruiter's own way of talking → playbook the AI imitates (kept editable)
    if (r.playbook) setSetting(db, 'playbook', { ...getSetting(db, 'playbook'), text: r.playbook, at: r.at });
  }
  send(res, 200, r);
});
route('GET', '/api/diag', 'admin', (req, res) => send(res, 200, Object.fromEntries(['chat', 'invite', 'boss', 'bossRec', 'rec', 'stall', 'greet'].map(k => [k, getSetting(db, `diag_${k}`)]))));

route('POST', '/api/settings/rotate-token', 'admin', (req, res) => { const t = randomToken(18); setSetting(db, 'ext_token', t); send(res, 200, { extToken: t }); });
route('POST', '/api/settings/rescreen', 'admin', async (req, res) => {
  let n = 0;
  for (const c of db.prepare("SELECT * FROM candidates WHERE work_json IS NOT NULL").all()) {
    const norm = { uid: c.uid, name: c.name, age: c.age, edu: c.edu, school: c.school, school_tag: c.school_tag, major: c.major, years: c.years, expect: c.expect,
      work: j(c.work_json, []), edus: j(c.edu_json, []), skills: j(c.skills_json, []), certs: j(c.certs_json, []) };
    const sc = screenFor(norm, c.job, c);
    db.prepare('UPDATE candidates SET role=? WHERE id=?').run(sc.roleKey, c.id);
    db.prepare("UPDATE candidates SET verdict=?, score=?, rules_json=?, reason=CASE WHEN reason_by='staff' THEN reason ELSE ? END, reason_by=CASE WHEN reason_by='staff' THEN 'staff' WHEN ? THEN 'ai' ELSE 'rule' END WHERE id=?")
      .run(sc.verdict, sc.score, s(sc.rules), sc.reason, sc.keepAi ? 1 : 0, c.id); n++;
  }
  // then the notes review for the ones the rules did not recommend (newest first, up to 200)
  const need = db.prepare("SELECT * FROM candidates WHERE work_json IS NOT NULL AND is_demo=0 AND verdict!='推荐' ORDER BY updated_at DESC LIMIT 400").all()
    .filter(c => !j(c.rules_json, []).some(r => r.id === 'AI')).slice(0, 200);
  const changed = await reviewCandidates(need);
  const widened = Object.values(changed).filter(v => v.from !== v.verdict && v.verdict !== '不推荐').length;
  send(res, 200, { rescreened: n, reviewed: need.length, widened });
});
route('POST', '/api/tools/riskcheck', 'admin', async (req, res) => { const b = await body(req); send(res, 200, riskCheck(String(b.text || ''))); });
route('POST', '/api/tools/llm-test', 'admin', async (req, res) => {
  const t0 = Date.now();
  try { const r = await chat(getSetting(db, 'ai'), [{ role: 'user', content: '用一句话介绍你自己，不超过 20 字。' }], { maxTokens: 60 }); send(res, 200, { ok: true, model: r.model, provider: r.provider, reply: r.content, ms: Date.now() - t0 }); }
  catch (e) { send(res, 200, { ok: false, error: clip(e.message, 300) }); }
});
route('POST', '/api/demo/seed', 'admin', (req, res) => send(res, 200, seedDemo(db)));
route('POST', '/api/demo/clear', 'admin', (req, res) => send(res, 200, clearDemo(db)));

// extension download with server URL + token baked into config.js
route('GET', '/api/extension.zip', 'admin', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'hrext-'));
  try {
    fs.cpSync(EXT_DIR, path.join(tmp, 'hr-agent-extension'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'hr-agent-extension', 'config.js'),
      `// generated by server\nself.HR_CONFIG = ${JSON.stringify({ server: `${proto}://${host}${BASE}`, token: getSetting(db, 'ext_token') })};\n`);
    const zip = path.join(tmp, 'ext.zip');
    execFileSync('python3', ['-c', `import shutil,sys; shutil.make_archive(sys.argv[1][:-4], 'zip', sys.argv[2], 'hr-agent-extension')`, zip, tmp]);
    send(res, 200, fs.readFileSync(zip), { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="hr-agent-extension.zip"' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- static web ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(res, rel) {
  let f = path.normalize(path.join(PUBLIC, rel));
  if (!f.startsWith(PUBLIC)) return fail(res, 403, 'forbidden');
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.html') ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(f).pipe(res);
}

// ---------- dispatcher ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  if (p === BASE) { res.writeHead(302, { Location: BASE + '/' }); return res.end(); }
  if (!p.startsWith(BASE + '/')) return fail(res, 404, 'not found');
  p = p.slice(BASE.length);
  // CORS for the extension (token auth, no cookies)
  if (p.startsWith('/api/ext/')) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HR-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  if (!p.startsWith('/api/')) return serveStatic(res, p === '/' ? 'index.html' : p.slice(1));
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = p.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let user = null;
    if (r.auth === 'admin') { user = readSession(req); if (!user) return fail(res, 401, '请先登录'); }
    if (r.auth === 'ext' && !extOk(req)) return fail(res, 401, '插件令牌无效，请在后台“设置”页重新下载插件');
    try { return await r.fn(req, res, params, user, u.searchParams); }
    catch (e) { console.error(new Date().toISOString(), req.method, p, e); return fail(res, 500, clip(e.message, 200)); }
  }
  fail(res, 404, 'not found');
});

server.listen(PORT, '127.0.0.1', () => console.log(`[hr-agent] listening on 127.0.0.1:${PORT}${BASE}  db=${DB_FILE}  llm=${llmConfigured()}`));
