import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getSetting } from '../src/db.js';
import { dueKind, convState, dueList, markFollowup, followupText, toMs } from '../src/followup.js';

const H = 3600e3;
const cfg = { enabled: true, greetHours: 3, readHours: 1, onlyIfRead: true, maxTotal: 3 };
const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hrfu-')), 't.db'));
let n = 0;
function cand(over = {}) {
  const r = db.prepare("INSERT INTO candidates(platform,uid,name,attend,is_demo,handoff,created_at,updated_at) VALUES('zhaopin',?,?,?,0,0,'x','x')").run(`u${++n}`, `人${n}`, over.attend || '沟通中');
  const id = Number(r.lastInsertRowid);
  if (over.greeted) db.prepare('UPDATE candidates SET greeted_ms=? WHERE id=?').run(over.greeted, id);
  for (const [dir, ms] of over.msgs || []) db.prepare('INSERT INTO messages(candidate_id,dir,by,text,at,platform_msg_id) VALUES(?,?,?,?,?,?)').run(id, dir, dir === 'in' ? 'candidate' : 'ai', 'x', new Date(ms).toISOString(), `${id}-${ms}-${dir}`);
  return db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
}
const now = Date.now();
const kindOf = c => dueKind(c, convState(db, c), cfg, now);

test('时间格式：平台 ISO 和我方北京时间都能换算', () => {
  assert.equal(toMs('2026-10-11T07:00:00.000Z'), Date.parse('2026-10-11T07:00:00Z'));
  assert.equal(toMs('2026-10-11 15:00:00'), Date.parse('2026-10-11T07:00:00Z'));
});

test('打招呼：满 3 小时未回复 → 跟进；不到 3 小时 → 不跟进；跟进过一次就不再跟进', () => {
  const a = cand({ greeted: now - 3.2 * H });
  assert.equal(kindOf(a), 'greet');
  assert.equal(kindOf(cand({ greeted: now - 2 * H })), null);
  markFollowup(db, a, 'greet');
  assert.equal(kindOf(db.prepare('SELECT * FROM candidates WHERE id=?').get(a.id)), null);
});

test('已读不回：我们最后一条满 1 小时 → 跟进；对方回复后再次冷场可以再跟进一次', () => {
  const c = cand({ msgs: [['out', now - 5 * H], ['in', now - 4 * H], ['out', now - 1.5 * H]] });
  assert.equal(kindOf(c), 'read');
  markFollowup(db, c, 'read');
  let c2 = db.prepare('SELECT * FROM candidates WHERE id=?').get(c.id);
  assert.equal(kindOf(c2), null);                       // same silence: only once
  db.prepare("INSERT INTO messages(candidate_id,dir,by,text,at,platform_msg_id) VALUES(?,?,?,?,?,?)").run(c.id, 'in', 'candidate', '在的', new Date(now - 1.3 * H).toISOString(), 'r1');
  db.prepare("INSERT INTO messages(candidate_id,dir,by,text,at,platform_msg_id) VALUES(?,?,?,?,?,?)").run(c.id, 'out', 'ai', '好的', new Date(now - 1.2 * H).toISOString(), 'r2');
  c2 = db.prepare('SELECT * FROM candidates WHERE id=?').get(c.id);
  assert.equal(kindOf(c2), 'read');                     // they replied, then went quiet again
});

test('对方最后发言、不到 1 小时、已确认参加 / 不合适 / 转人工 → 不跟进', () => {
  assert.equal(kindOf(cand({ msgs: [['out', now - 3 * H], ['in', now - 2 * H]] })), null);
  assert.equal(kindOf(cand({ msgs: [['in', now - 3 * H], ['out', now - 0.5 * H]] })), null);
  assert.equal(kindOf(cand({ attend: '确认参加', msgs: [['in', now - 3 * H], ['out', now - 2 * H]] })), null);
  assert.equal(kindOf(cand({ attend: '不合适', greeted: now - 5 * H })), null);
});

test('到期名单按等待时间排序', () => {
  cand({ greeted: now - 6 * H });
  cand({ msgs: [['in', now - 9 * H], ['out', now - 8 * H]] });
  const list = dueList(db, cfg, 50);
  assert.ok(list.length >= 2);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].since <= list[i].since);
});

test('跟进话术（无 AI 时用模板）：打招呼跟进问是否还在看机会；已读跟进问顾虑并给面试时间', async () => {
  const settings = { org: getSetting(db, 'org'), ai: { enabled: false }, autoReply: getSetting(db, 'autoReply') };
  const g = await followupText('greet', {}, [], { settings, db, role: { key: 'xueguan', name: '学管师' }, offer: [] });
  assert.match(g.reply, /学管师/);
  const r = await followupText('read', {}, [], { settings, db, role: { key: 'teacher', name: '教师' }, offer: [{ date: '2026-10-13', slot: '09:30' }] });
  assert.match(r.reply, /顾虑|想了解/);
  assert.match(r.reply, /09:30/);
});
