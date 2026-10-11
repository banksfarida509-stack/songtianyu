// SQLite storage (node:sqlite, no external dependency) + schema + default settings.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowCN, s, j, randomToken } from './util.js';

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
    repeatLimit: 2,               // 同一问题问到第几遍转本人回复
    autoInvite: true,             // 约定时间后，全自动模式下自动点平台「约面试」发邀约
    policy: {
      '投递-符合': 'auto', '投递-不符合': 'auto', '投递-待确认': 'auto',
      提问: 'auto', 提供信息: 'auto', 约面时间: 'auto', 确认参加: 'auto', 改期: 'auto',
      拒绝: 'auto', 议价: 'human', 要求真人: 'human', 交换联系方式: 'semi', 其他: 'semi',
    },
    style: '像学校招聘老师在手机上回消息：口语、简短、自然，一次只问一个问题；先回答对方的问题，再顺带推进；不用“您好！感谢您的…”这类客服腔，不用表情符号，不说“亲”。',
  },
  // 知识库（整段粘贴，AI 回复只能用这里和下面问答里的事实）
  kbDoc: '',
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
