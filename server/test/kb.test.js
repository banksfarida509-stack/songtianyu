import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { chunkText, retrieve, kbStats } from '../src/kb.js';
import { askCount, guessTopic, suggestReply } from '../src/ai.js';
import { getSetting } from '../src/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrkb-'));
const db = openDb(path.join(tmp, 't.db'));
const add = (title, content) => db.prepare("INSERT INTO kb_docs(title,source,content,created_at,updated_at) VALUES(?,?,?,'x','x')").run(title, 'test', content);
add('薪资福利说明', '【薪资】底薪加课时费加绩效，按经验定级。\n\n【福利】五险一金，提供午餐，寒暑假带薪。');
add('作息时间', '【作息】早上 7:30 到校，下午 5:00 下班，周末双休，不上晚自习。');
add('学校介绍', '学校是一所民办初中，在沈阳，共 36 个班。'.repeat(3));

test('长文档按段落切分，每段不超过上限', () => {
  const parts = chunkText('x', 'a'.repeat(1000) + '\n\n' + '短段落');
  assert.ok(parts.length >= 3);
  assert.ok(parts.every(p => p.text.length <= 420));
});

test('检索：几点下班 → 作息时间；有五险一金吗 → 薪资福利', () => {
  assert.equal(retrieve(db, '你们几点下班？', { topic: guessTopic('你们几点下班？') })[0].title, '作息时间');
  assert.equal(retrieve(db, '有五险一金吗', { topic: guessTopic('有五险一金吗') })[0].title, '薪资福利说明');
  assert.equal(kbStats(db).docs, 3);
});

test('同一问题第二次问 → 计为第 2 遍', () => {
  const earlier = [{ text: '工资大概多少？', topic: '薪资' }];
  assert.equal(askCount(['那工资到底多少钱'], '薪资', earlier, false), 2);
  assert.equal(askCount(['几点下班'], '作息时间', earlier, false), 1);
  assert.equal(askCount(['有没有绩效奖金'], '薪资', earlier, false), 1); // same topic, different question
  // booking an interview: different questions about the same interview are not repeats
  const booking = [{ text: '面试是几点？', topic: '面试安排' }, { text: '好的，明天上午可以', topic: '面试安排' }, { text: '面试在哪个校区？', topic: '面试安排' }];
  assert.equal(askCount(['面试需要带什么材料吗'], '面试安排', booking, false), 1);
  assert.equal(askCount(['面试到底是几点？'], '面试安排', booking, false), 2);
  assert.equal(askCount(['工资多少', '工资多少啊'], '薪资', [], false), 2);
  assert.equal(askCount(['那个事怎么说？'], '其他', [], true), 2);  // the AI says it was asked before
  assert.equal(askCount(['好的'], '其他', [], true), 1);           // …but only questions count
});

test('第二次问同一问题（无 AI 时）→ 转本人回复', async () => {
  const settings = { org: getSetting(db, 'org'), kb: getSetting(db, 'kb'), schedule: getSetting(db, 'schedule'), ai: { ...getSetting(db, 'ai'), enabled: false }, autoReply: getSetting(db, 'autoReply') };
  const history = [{ dir: 'in', text: '工资多少？' }, { dir: 'out', text: '底薪加课时费。' }, { dir: 'in', text: '工资到底多少钱？' }];
  const d = await suggestReply({ slots: {} }, history, { settings, db, earlierQuestions: [{ text: '工资多少？', topic: '薪资' }] });
  assert.equal(d.asked, 2);
  assert.equal(d.handoff, true);
  assert.match(d.handoffWhy, /第 2 遍/);
});
