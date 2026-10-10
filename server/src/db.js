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
`;

export const DEFAULT_SETTINGS = {
  org: { name: 'XX 教育', place: '学校本部', persona: 'XX 教育的 AI 招聘助理' },
  rules: {
    maxAge: 35,
    minEdu: '本科',
    subjectKeywords: ['数学', '物理', '化学', '生物', '科学', '理科', '语文', '英语'],
    schoolPattern: '中学|小学|学校|一中|二中|三中|实验|附中|教师|老师',
    trainingPattern: '培训|教育科技|辅导|托管|机构|网校',
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
  if (d && v && typeof d === 'object' && !Array.isArray(d)) return { ...d, ...v };
  return v ?? d ?? null;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, s(value));
}

export function addEvent(db, candidateId, text) {
  db.prepare('INSERT INTO events(candidate_id,at,text) VALUES(?,?,?)').run(candidateId, nowCN(), text);
}
