import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { normalizeZhaopin } from '../src/rules.js';

test('重复的 boss-boss-… 编号在启动时合并为一人，聊天记录保留', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hrdd-')), 't.db');
  let db = openDb(file);
  const ins = (uid, name) => Number(db.prepare("INSERT INTO candidates(platform,uid,name,attend,created_at,updated_at) VALUES('boss',?,?,'未联系','x','x')").run(uid, name).lastInsertRowid);
  const a1 = ins('boss-boss-abc', '李梦雨'), a2 = ins('boss-boss-boss-abc', '李梦雨'), a3 = ins('boss-boss-boss-boss-abc', '李梦雨');
  ins('boss-boss-xyz', '崔女士'); ins('boss-boss-boss-xyz', '崔女士');
  db.prepare("INSERT INTO messages(candidate_id,dir,by,text,at,platform_msg_id) VALUES(?,?,?,?,?,?)").run(a2, 'in', 'candidate', '你好', 'x', 'm1');
  db.close();
  db = openDb(file); // migration runs on open
  const rows = db.prepare("SELECT id, uid, name FROM candidates WHERE platform='boss' ORDER BY uid").all();
  assert.deepEqual(rows.map(r => r.uid), ['boss-abc', 'boss-xyz']);
  const keep = rows.find(r => r.uid === 'boss-abc').id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE candidate_id=?').get(keep).n, 1);
  assert.ok([a1, a2, a3].includes(keep));
});

test('读取时也会把 boss-boss- 前缀合并', () => {
  assert.equal(normalizeZhaopin({ resumeNumber: 'boss-boss-boss-abc' }).uid, 'boss-abc');
  assert.equal(normalizeZhaopin({ resumeNumber: 'R123' }).uid, 'R123');
});
