import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getSetting } from '../src/db.js';
import { suggestReply } from '../src/ai.js';
import { addDays, todayCN } from '../src/util.js';

const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hrrs-')), 't.db'));
const settings = { org: getSetting(db, 'org'), kb: getSetting(db, 'kb'), schedule: getSetting(db, 'schedule'), ai: { ...getSetting(db, 'ai'), enabled: false }, autoReply: getSetting(db, 'autoReply') };
const offer = [{ date: addDays(todayCN(), 1), slot: '09:30' }];
const talk = [{ dir: 'out', text: '你好，看到你在找老师工作' }, { dir: 'in', text: '你好' }, { dir: 'out', text: '你现在在职吗？' }, { dir: 'in', text: '已经离职了，住在铁西' }];

test('对方回复过之后，回复里顺带索要附件简历（每人一次）', async () => {
  const d = await suggestReply({ verdict: '推荐', slots: {}, resume_status: '未索要' }, talk, { settings, db, origin: 'greeted', offer });
  assert.equal(d.resumeAsk, true);
  assert.match(d.reply, /附件简历/);
});

test('已索要 / 已收到 / 对方已发简历卡片 → 不再索要', async () => {
  for (const status of ['已索要', '已收到']) {
    const d = await suggestReply({ verdict: '推荐', slots: {}, resume_status: status }, talk, { settings, db, origin: 'greeted', offer });
    assert.equal(d.resumeAsk, false, status);
  }
  const withCard = [...talk.slice(0, 3), { dir: 'in', text: '[卡片·附件简历] 这是我的附件简历' }];
  assert.equal((await suggestReply({ verdict: '推荐', slots: {}, resume_status: '未索要' }, withCard, { settings, db, origin: 'greeted', offer })).resumeAsk, false);
});

test('第一句不索要；拒绝 / 不合适的不索要', async () => {
  assert.equal((await suggestReply({ verdict: '推荐', slots: {}, resume_status: '未索要' }, [{ dir: 'in', text: '你好' }], { settings, db, origin: 'applied', offer })).resumeAsk, false);
  const no = [...talk.slice(0, 3), { dir: 'in', text: '不考虑了，已经找到工作了' }];
  assert.equal((await suggestReply({ verdict: '推荐', slots: {}, resume_status: '未索要' }, no, { settings, db, origin: 'greeted', offer })).resumeAsk, false);
  assert.equal((await suggestReply({ verdict: '不推荐', slots: {}, resume_status: '未索要' }, talk, { settings, db, origin: 'greeted', offer })).resumeAsk, false);
});
