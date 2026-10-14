// SQLite storage (node:sqlite, no external dependency) + schema + default settings.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowCN, s, j, randomToken } from './util.js';
import { DEFAULT_ROLES, ROLE_KB_TEMPLATES } from './roles.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  uid TEXT NOT NULL,
  name TEXT, gender TEXT, age INTEGER, edu TEXT, school TEXT, school_tag TEXT, major TEXT,
  years TEXT, career_status TEXT, expect TEXT, job TEXT,
  work_json TEXT, edu_json TEXT, skills_json TEXT, certs_json TEXT, self_eval TEXT,
  verdict TEXT, score INTEGER, reason TEXT, reason_by TEXT, rules_json TEXT,
  attend TEXT NOT NULL DEFAULT '未联系',
  pref_json TEXT, slots_json TEXT, last_note TEXT, handoff INTEGER NOT NULL DEFAULT 0,
  source TEXT, owner TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  UNIQUE(platform, uid)
);
CREATE TABLE IF NOT EXISTS interviewers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  date TEXT NOT NULL, slot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待确认',
  desk TEXT NOT NULL DEFAULT '未分配',
  interviewer_id INTEGER REFERENCES interviewers(id),
  assigned_at TEXT, finished_at TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date, slot);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  dir TEXT NOT NULL, by TEXT NOT NULL, text TEXT NOT NULL,
  platform_msg_id TEXT, at TEXT,
  UNIQUE(candidate_id, platform_msg_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  at TEXT NOT NULL, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kb_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, source TEXT, content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT, updated_at TEXT
);
`;

export const DEFAULT_SETTINGS = {
  // role: 对候选人说话时的身份（AI 以这个身份第一人称回复）；agentName: 可选的称呼，如“王老师”
  org: { name: 'XX 教育', place: '学校本部', persona: 'XX 教育的 AI 招聘助理', role: '招聘约访官，同时负责初试面试', agentName: '' },
  rules: {
    maxAge: 35,
    minEdu: '本科',
    subjectKeywords: ['数学', '物理', '化学', '生物', '科学', '理科', '语文', '英语'],
    schoolPattern: '中学|小学|学校|一中|二中|三中|实验|附中|教师|老师',
    trainingPattern: '培训|教育科技|辅导|托管|机构|网校',
    // 意向型：无教学经验但求职方向是教师类的年轻人，也推荐打招呼
    intentTrack: true,
    intentMaxAge: 30,
    intentMinEdu: '本科',
    intentKeywords: ['教师', '教学', '老师', '助教', '讲师', '教研', '班主任'],
    // 所有岗位：这一年之后毕业的（还在上学）一律不推荐；0 = 不限
    maxGradYear: 2026,
  },
  schedule: {
    am: ['09:00', '09:30', '10:00', '10:30', '11:00'],
    pm: ['13:00', '13:30', '14:00', '14:30', '15:00'],
    cap: 4,
    days: 5,
    weekdaysOnly: true,
  },
  ai: {
    enabled: true,
    provider: 'deepseek', model: 'deepseek-chat',
    fallbackProvider: 'bigmodel', fallbackModel: 'glm-4-flash',
  },
  // 约聊回复方式：候选人每条消息先被 AI 分类，再按分类决定 全自动 / 半自动 / 转人工
  autoReply: {
    enabled: false,               // 全自动总开关（关 = 所有分类都只给建议）
    hours: ['08:30', '21:00'],    // 只在这个时间段内自动发送
    delayMin: 25, delayMax: 90,   // 收到消息后等待多少秒再回（像真人）
    maxPerHour: 40,               // 每小时最多自动发送条数
    scanUnread: true,             // 自动打开有未读消息的会话
    keepImTab: true,              // 插件自动打开并保持招聘平台的「消息」页（自动回复只在消息页运行）
    repeatLimit: 2,               // 同一问题问到第几遍转本人回复
    autoInvite: true,             // 约定时间后，全自动模式下自动点平台「约面试」发邀约
    // 主动跟进：打招呼后久未回复 / 对方已读不回时，发一次跟进消息（全自动开启时才发）
    followup: { enabled: true, greetHours: 3, readHours: 1, onlyIfRead: true, maxTotal: 3 },
    policy: {
      '跟进': 'auto',
      '投递-符合': 'auto', '投递-不符合': 'auto', '投递-待确认': 'auto',
      提问: 'auto', 提供信息: 'auto', 约面时间: 'auto', 确认参加: 'auto', 改期: 'auto',
      拒绝: 'auto', 议价: 'human', 要求真人: 'human', 交换联系方式: 'semi', 其他: 'semi',
    },
    style: '像学校招聘老师在手机上回消息：口语、简短、自然，一次只问一个问题；先回答对方的问题，再顺带推进；不用“您好！感谢您的…”这类客服腔，不用表情符号，不说“亲”。',
  },
  // 推荐页打招呼：持续模式打完一批自动接着打，直到当天该岗位的上限（每个平台分别计数）
  greet: { continuous: true, daily: { teacher: 100, xueguan: 50, zixun: 50, other: 30 } },
  // 知识库（整段粘贴，AI 回复只能用这里和下面问答里的事实）
  kbDoc: '',
  // 岗位：教师 / 学管师 / 咨询师 — 初筛规则、约聊要了解的问题、沟通要点（教师的初筛仍用上面的 rules）
  roles: DEFAULT_ROLES,
  // 我的沟通话术：从历史约聊中学到的沟通逻辑和说法，AI 回复时模仿（可在后台修改）
  playbook: { enabled: true, text: '', at: '' },
  kb: [
    { id: 'KB-01', q: '面试流程', a: '初试是试讲 15 分钟加面谈 20 分钟，请带身份证和教师资格证原件。' },
    { id: 'KB-02', q: '面试地点', a: '面试统一在学校本部，到了跟前台报名字即可。' },
    { id: 'KB-03', q: '面试时间', a: '上午 9:00–11:00、下午 13:00–15:00 都可以安排。' },
    { id: 'KB-04', q: '薪资', a: '薪资由基本工资、课时费和绩效构成，按经验定级，面试时详细沟通。' },
    { id: 'KB-05', q: '岗位性质', a: '全职岗位，工作地点在沈阳。' },
  ],
};

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
  db.exec(SCHEMA);
  // migrations: per-conversation reply mode override (null = 按分类)
  const cols = db.prepare('PRAGMA table_info(candidates)').all().map(c => c.name);
  if (!cols.includes('chat_mode')) db.exec('ALTER TABLE candidates ADD COLUMN chat_mode TEXT');
  // topic of each candidate question (薪资 / 作息时间 …) — used to spot a question asked twice
  const mcols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  if (!mcols.includes('topic')) db.exec('ALTER TABLE messages ADD COLUMN topic TEXT');
  // follow-ups: when we greeted (epoch ms) and what follow-ups were sent
  const ccols = db.prepare('PRAGMA table_info(candidates)').all().map(c => c.name);
  if (!ccols.includes('greeted_ms')) db.exec('ALTER TABLE candidates ADD COLUMN greeted_ms INTEGER');
  if (!ccols.includes('followup_json')) db.exec('ALTER TABLE candidates ADD COLUMN followup_json TEXT');
  // the recruiter's own note on a candidate (人才池“备注”列), and a role set by hand (not overwritten by job-title matching)
  if (!ccols.includes('staff_note')) db.exec('ALTER TABLE candidates ADD COLUMN staff_note TEXT');
  if (!ccols.includes('role_manual')) db.exec('ALTER TABLE candidates ADD COLUMN role_manual INTEGER NOT NULL DEFAULT 0');
  // the candidate's mobile number once the platform shows it to the recruiter (exchange / message / unlocked resume)
  if (!ccols.includes('phone')) db.exec('ALTER TABLE candidates ADD COLUMN phone TEXT');
  // attachment resume: 未索要 / 已索要 / 已收到, and the talent reserve (人才库) flag
  if (!ccols.includes('resume_status')) db.exec("ALTER TABLE candidates ADD COLUMN resume_status TEXT NOT NULL DEFAULT '未索要'");
  if (!ccols.includes('resume_at')) db.exec('ALTER TABLE candidates ADD COLUMN resume_at TEXT');
  if (!ccols.includes('reserve')) {
    db.exec('ALTER TABLE candidates ADD COLUMN reserve INTEGER NOT NULL DEFAULT 0');
    // resumes already received in past chats go straight into the reserve
    db.exec(`UPDATE candidates SET resume_status='已收到', reserve=1, resume_at=(SELECT MIN(at) FROM messages m WHERE m.candidate_id=candidates.id AND m.dir='in' AND m.text LIKE '[卡片·附件简历]%')
      WHERE id IN (SELECT candidate_id FROM messages WHERE dir='in' AND text LIKE '[卡片·附件简历]%')`);
  }
  // one row per greeting sent from a recommend page, for the per-platform, per-role daily cap
  db.exec('CREATE TABLE IF NOT EXISTS greet_log (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, platform TEXT NOT NULL, role TEXT NOT NULL, uid TEXT, at TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS greet_log_day ON greet_log(day, platform, role)');
  dedupeBossIds(db);
  // job roles: each candidate and each knowledge-base document belongs to a role (通用 = all)
  if (!db.prepare('PRAGMA table_info(candidates)').all().some(c => c.name === 'role')) db.exec("ALTER TABLE candidates ADD COLUMN role TEXT NOT NULL DEFAULT 'teacher'");
  if (!db.prepare('PRAGMA table_info(kb_docs)').all().some(c => c.name === 'role')) db.exec("ALTER TABLE kb_docs ADD COLUMN role TEXT NOT NULL DEFAULT 'all'");
  for (const [role, title, content] of ROLE_KB_TEMPLATES) {
    if (!db.prepare('SELECT 1 FROM kb_docs WHERE title=?').get(title)) {
      db.prepare('INSERT INTO kb_docs(title,source,content,enabled,role,created_at,updated_at) VALUES(?,?,?,0,?,?,?)').run(title, '模板', content, role, nowCN(), nowCN());
    }
  }
  // the single pasted knowledge-base text becomes the first document
  const pasted = db.prepare("SELECT value FROM settings WHERE key='kbDoc'").get();
  const pastedText = pasted ? j(pasted.value, '') : '';
  if (pastedText && !db.prepare('SELECT COUNT(*) n FROM kb_docs').get().n) {
    db.prepare('INSERT INTO kb_docs(title,source,content,created_at,updated_at) VALUES(?,?,?,?,?)').run('知识库（粘贴）', '粘贴', pastedText, nowCN(), nowCN());
    db.prepare("UPDATE settings SET value=? WHERE key='kbDoc'").run(s(''));
  }
  // defaults
  const get = db.prepare('SELECT value FROM settings WHERE key=?');
  const put = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) put.run(k, s(v));
  if (!get.get('ext_token')) put.run('ext_token', s(randomToken(18)));
  if (!get.get('session_secret')) put.run('session_secret', s(randomToken(32)));
  const n = db.prepare('SELECT COUNT(*) n FROM interviewers').get().n;
  if (!n) {
    const ins = db.prepare('INSERT INTO interviewers(name,sort) VALUES(?,?)');
    ['何静', '李卓', '王磊', '赵宁', '刘芳', '陈曦', '孙悦', '周航'].forEach((nm, i) => ins.run(nm, i));
  }
  return db;
}

/**
 * One-off repair: an extension bug stored the same BOSS candidate under ids like
 * “boss-boss-…-<geekId>”. Group by the real id, keep one row per person (the one with
 * chat messages / appointments / staff changes, else the newest), point its uid at
 * “boss-<geekId>”, and delete the other copies.
 */
function dedupeBossIds(db) {
  const rows = db.prepare("SELECT id, uid, updated_at FROM candidates WHERE platform='boss' AND uid LIKE 'boss-boss-%'").all();
  if (!rows.length) return;
  const real = uid => 'boss-' + uid.replace(/^(boss-)+/, '');
  const groups = new Map();
  for (const r of rows) { const k = real(r.uid); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const weight = id => db.prepare('SELECT COUNT(*) n FROM messages WHERE candidate_id=?').get(id).n * 100
    + db.prepare('SELECT COUNT(*) n FROM appointments WHERE candidate_id=?').get(id).n * 100
    + (db.prepare("SELECT reason_by, attend FROM candidates WHERE id=?").get(id).attend !== '未联系' ? 10 : 0);
  const tx = db.prepare('BEGIN'); tx.run();
  try {
    for (const [k, list] of groups) {
      const existing = db.prepare("SELECT id FROM candidates WHERE platform='boss' AND uid=?").get(k);
      const all = existing ? [existing, ...list] : list;
      const keep = all.map(r => ({ id: r.id, w: weight(r.id), t: r.updated_at || '' })).sort((a, b) => b.w - a.w || (b.t > a.t ? 1 : -1))[0].id;
      for (const r of all) {
        if (r.id === keep) continue;
        // move anything attached to the copy onto the kept row, then drop the copy
        db.prepare('UPDATE OR IGNORE messages SET candidate_id=? WHERE candidate_id=?').run(keep, r.id);
        db.prepare('UPDATE events SET candidate_id=? WHERE candidate_id=?').run(keep, r.id);
        db.prepare('UPDATE appointments SET candidate_id=? WHERE candidate_id=?').run(keep, r.id);
        db.prepare('DELETE FROM candidates WHERE id=?').run(r.id);
      }
      db.prepare('UPDATE candidates SET uid=? WHERE id=?').run(k, keep);
    }
    db.prepare('COMMIT').run();
  } catch (e) { db.prepare('ROLLBACK').run(); console.error('[db] dedupe boss ids failed:', e.message); }
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  const v = row ? j(row.value) : null;
  const d = DEFAULT_SETTINGS[key];
  if (d && v && typeof d === 'object' && !Array.isArray(d)) {
    const out = { ...d, ...v };
    // one level deeper for nested maps (e.g. autoReply.policy) so new defaults show up
    for (const [k, dv] of Object.entries(d)) if (dv && typeof dv === 'object' && !Array.isArray(dv) && v[k] && typeof v[k] === 'object') out[k] = { ...dv, ...v[k] };
    return out;
  }
  return v ?? d ?? null;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, s(value));
}

export function addEvent(db, candidateId, text) {
  db.prepare('INSERT INTO events(candidate_id,at,text) VALUES(?,?,?)').run(candidateId, nowCN(), text);
}
