import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeZhaopin, screen } from '../src/rules.js';
import { openDb, getSetting, setSetting } from '../src/db.js';
import { findSlot, book, autoSchedule, workDays } from '../src/schedule.js';
import { riskCheck, suggestReply } from '../src/ai.js';
import { todayCN, addDays } from '../src/util.js';

const RULES = {
  maxAge: 35, minEdu: '本科', subjectKeywords: ['数学', '物理', '化学', '生物'],
  schoolPattern: '中学|小学|学校|一中|教师|老师', trainingPattern: '培训|教育科技|辅导|托管|机构',
};
// shape copied from the real 智联 recommend card props (values invented)
const card = (o = {}) => ({
  resumeNumber: 'R1', userName: '刘先生', age: '27', educationLevel: '本科', workYears: '3年',
  workExperiences: [{ beginDate: '2023.07', endDate: '至今', companyName: '某县第一中学', jobTitle: '高一物理教师' }],
  educationExperiences: [{ schoolName: '东北师范大学', majorName: '物理学', educationLevel: '本科', schoolTag: '211' }],
  skillTags: [], certificateNames: [], selfEvaluation: 'x', ...o,
});

test('normalize keeps only whitelisted fields', () => {
  const n = normalizeZhaopin(card({ phone: '13800000000', avatar: 'http://x' }));
  assert.equal(n.uid, 'R1');
  assert.equal(n.age, 27);
  assert.equal(n.school, '东北师范大学');
  assert.ok(!('avatar' in n));
  assert.equal(n.phone, '13800000000');                                         // shown in full → kept
  assert.equal(normalizeZhaopin(card({ phone: '138****0000' })).phone, '');     // masked → not kept
});

test('screen: good candidate is 推荐 with reason', () => {
  const r = screen(normalizeZhaopin(card()), RULES);
  assert.equal(r.verdict, '推荐');
  assert.ok(r.score >= 70, String(r.score));
  assert.match(r.reason, /东北师范大学/);
});

test('screen: age / edu / subject failures', () => {
  assert.equal(screen(normalizeZhaopin(card({ age: '38' })), RULES).verdict, '不推荐');
  assert.equal(screen(normalizeZhaopin(card({ educationLevel: '大专', educationExperiences: [{ schoolName: 'X', majorName: '物理', educationLevel: '大专' }] })), RULES).verdict, '不推荐');
  const r = screen(normalizeZhaopin(card({ workExperiences: [{ companyName: '某房产公司', jobTitle: '销售' }], educationExperiences: [{ schoolName: '某大学', majorName: '市场营销', educationLevel: '本科' }] })), RULES);
  assert.equal(r.verdict, '不推荐');
});

test('screen: training-institution only → 待确认', () => {
  const r = screen(normalizeZhaopin(card({ workExperiences: [{ companyName: '某教育培训机构', jobTitle: '初中化学辅导' }], educationExperiences: [{ schoolName: '沈阳理工大学', majorName: '化学工程', educationLevel: '本科' }] })), RULES);
  assert.equal(r.verdict, '待确认');
});

test('platform risk rules', () => {
  assert.deepEqual(riskCheck('关注公众号').platform, ['公众号']);
  assert.deepEqual(riskCheck('链接 xx.cn/r/20261011003').platform, ['6 位以上连续数字']);
  assert.deepEqual(riskCheck('面试在学校本部').platform, []);
  assert.ok(riskCheck('保证月薪一万').guard.length);
});

function tmpDb() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-')), 'hr.db');
  return openDb(f);
}

test('schedule: slots respect half-day and capacity, weekdays only', () => {
  const db = tmpDb();
  const sched = getSetting(db, 'schedule');
  setSetting(db, 'schedule', { ...sched, cap: 2 });
  const ins = db.prepare("INSERT INTO candidates(platform,uid,name,attend) VALUES('zhaopin',?,?,'待排程')");
  const ids = [1, 2, 3].map(i => Number(ins.run('u' + i, 'c' + i).lastInsertRowid));
  const s1 = findSlot(db, { half: 'pm' });
  assert.ok(s1 && ['13:00', '13:30', '14:00', '14:30', '15:00'].includes(s1.slot));
  book(db, ids[0], s1.date, s1.slot); book(db, ids[1], s1.date, s1.slot);
  const s2 = findSlot(db, { half: 'pm' });
  assert.notDeepEqual(s2, s1); // capacity 2 reached
  const am = findSlot(db, { half: 'am' });
  assert.ok(am.slot <= '11:00');
  for (const d of workDays(getSetting(db, 'schedule'), todayCN(), 5)) assert.ok(![0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()));
  const r = autoSchedule(db);
  assert.equal(r.placed.length, 1);
});

test('suggestReply without LLM: time request books a slot, salary hands off', async () => {
  const db = tmpDb();
  const settings = { org: getSetting(db, 'org'), rules: getSetting(db, 'rules'), schedule: getSetting(db, 'schedule'), ai: { ...getSetting(db, 'ai'), enabled: false }, kb: getSetting(db, 'kb') };
  const d1 = await suggestReply({ slots: {} }, [{ dir: 'in', text: '明天下午可以去面试' }], { settings, db, appt: null });
  assert.equal(d1.intent, '约面时间');
  assert.equal(d1.action, '约面试');
  assert.ok(d1.slot && d1.slot.slot >= '13:00' && d1.slot.date > todayCN());
  assert.equal(d1.blocked, false, JSON.stringify(d1.checks));
  const d2 = await suggestReply({ slots: {} }, [{ dir: 'in', text: '工资能保证一万吗' }], { settings, db, appt: null });
  assert.equal(d2.handoff, true);
  const d3 = await suggestReply({ slots: {} }, [{ dir: 'in', text: '你是机器人吗？' }], { settings, db, appt: null });
  assert.equal(d3.handoff, false);
  assert.match(d3.reply, /AI/);
  const d4 = await suggestReply({ slots: {} }, [{ dir: 'in', text: '我要找真人聊' }], { settings, db, appt: null });
  assert.equal(d4.handoff, true);
  const d5 = await suggestReply({ slots: {} }, [{ dir: 'in', text: '学校在哪？' }], { settings, db, appt: null });
  assert.match(d5.reply, /学校本部/);
});
