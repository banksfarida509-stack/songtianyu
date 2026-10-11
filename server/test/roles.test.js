import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ROLES, roleFor, screenRole } from '../src/roles.js';
import { normalizeZhaopin } from '../src/rules.js';
import { openDb, getSetting } from '../src/db.js';
import { retrieve } from '../src/kb.js';
import { suggestReply } from '../src/ai.js';
import { addDays, todayCN } from '../src/util.js';

test('按职位名识别岗位；教师是默认', () => {
  assert.equal(roleFor('学管师（月休6天）', DEFAULT_ROLES), 'xueguan');
  assert.equal(roleFor('课程顾问', DEFAULT_ROLES), 'zixun');
  assert.equal(roleFor('初高中文化课教师', DEFAULT_ROLES), 'teacher');
  assert.equal(roleFor('学管老师', DEFAULT_ROLES), 'xueguan');   // “老师”出现在学管职位里也归学管师
  assert.equal(roleFor('', DEFAULT_ROLES), 'teacher');
});

const card = over => normalizeZhaopin({ resumeNumber: 'r1', userName: 'x', age: 26, educationLevel: '大专', workExperiences: [], educationExperiences: [{ schoolName: '某职业学院', educationLevel: '大专', mode: '统招' }], ...over });
const xg = { key: 'xueguan', ...DEFAULT_ROLES.xueguan }, zx = { key: 'zixun', ...DEFAULT_ROLES.zixun };

test('学管师：做过班主任 / 客服 → 推荐；年龄超限 → 不推荐', () => {
  const ok = screenRole(card({ workExperiences: [{ beginDate: '2022', endDate: '至今', companyName: '某教育', jobTitle: '班主任' }] }), xg);
  assert.equal(ok.verdict, '推荐');
  assert.equal(screenRole(card({ age: 40, workExperiences: [{ companyName: 'x', jobTitle: '客服' }] }), xg).verdict, '不推荐');
});

test('咨询师：做过房产销售 → 推荐；没经验但求职方向是课程顾问的年轻人 → 推荐（意向型）', () => {
  assert.equal(screenRole(card({ workExperiences: [{ companyName: '某地产', jobTitle: '置业顾问' }] }), zx).verdict, '推荐');
  const intent = screenRole(card({ age: 23, intentText: '课程顾问', workExperiences: [{ companyName: '某工厂', jobTitle: '质检' }] }), zx);
  assert.equal(intent.verdict, '推荐');
  assert.match(intent.reason, /意向型/);
  assert.equal(screenRole(card({ age: 33, workExperiences: [{ companyName: '某工厂', jobTitle: '质检' }] }), zx).verdict, '不推荐');
});

const tzEdu = mode => ({ educationExperiences: [{ schoolName: '某职业学院', majorName: '学前教育', educationLevel: '大专', mode }] });

test('学管师：只要统招大专；非统招 → 不推荐；没写是否统招 → 待确认', () => {
  const exp = { workExperiences: [{ companyName: '某教育', jobTitle: '班主任' }] };
  assert.equal(screenRole(card({ ...exp, ...tzEdu('统招') }), xg).verdict, '推荐');
  const no = screenRole(card({ ...exp, ...tzEdu('自考') }), xg);
  assert.equal(no.verdict, '不推荐');
  assert.match(no.reason, /非统招/);
  assert.equal(screenRole(card({ ...exp, ...tzEdu('') }), xg).verdict, '待确认');
  assert.equal(screenRole(card({ ...exp, ...tzEdu('非全日制') }), xg).verdict, '不推荐');
});

test('咨询师：教育行业做过销售的，非统招也可以；其他行业销售 + 非统招 → 不推荐', () => {
  const eduSales = { workExperiences: [{ companyName: '某某教育培训学校', jobTitle: '课程顾问' }] };
  const otherSales = { workExperiences: [{ companyName: '某地产公司', jobTitle: '置业顾问' }] };
  assert.equal(screenRole(card({ ...eduSales, ...tzEdu('成人教育') }), zx).verdict, '推荐');
  assert.equal(screenRole(card({ ...otherSales, ...tzEdu('成人教育') }), zx).verdict, '不推荐');
  assert.equal(screenRole(card({ ...otherSales, ...tzEdu('统招') }), zx).verdict, '推荐');
});

test('聊天中说是自考大专（学管师）→ 礼貌婉拒，可全自动', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hrtz-')), 't.db'));
  const settings = { org: getSetting(db, 'org'), kb: getSetting(db, 'kb'), schedule: getSetting(db, 'schedule'), ai: { ...getSetting(db, 'ai'), enabled: false }, autoReply: getSetting(db, 'autoReply') };
  const h = [{ dir: 'out', text: '你的大专是统招全日制的吗？' }, { dir: 'in', text: '不是统招，是自考的' }];
  const d = await suggestReply({ verdict: '推荐', slots: {} }, h, { settings, db, origin: 'greeted', role: xg });
  assert.equal(d.declineTz, true);
  assert.equal(d.intent, '投递-不符合');
  assert.equal(d.stateChange.attend, '不合适');
  assert.doesNotMatch(d.reply, /统招|学历/);   // decline politely without naming the reason
  // 咨询师 with education-sales experience: not declined
  const d2 = await suggestReply({ verdict: '推荐', slots: {}, work_json: JSON.stringify([{ org: '某教育培训学校', role: '课程顾问' }]) }, h, { settings, db, origin: 'greeted', role: zx });
  assert.notEqual(d2.declineTz, true);
});

test('岗位资料只取通用 + 本岗位；咨询师的问题问销售经验，不问科目', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hrrole-')), 't.db'));
  const add = (title, content, role) => db.prepare("INSERT INTO kb_docs(title,source,content,role,created_at,updated_at) VALUES(?,?,?,?,'x','x')").run(title, 't', content, role);
  add('教师薪资', '教师工资：底薪加课时费', 'teacher');
  add('咨询师薪资', '咨询师工资：底薪加提成', 'zixun');
  add('学校地址', '学校在沈阳，工资按月发放', 'all');
  const titles = r => retrieve(db, '工资多少', { role: r }).map(p => p.title);
  assert.ok(titles('zixun').includes('咨询师薪资') && !titles('zixun').includes('教师薪资'));
  assert.ok(titles('teacher').includes('教师薪资') && !titles('teacher').includes('咨询师薪资'));
  assert.ok(titles('zixun').includes('学校地址'));

  const settings = { org: getSetting(db, 'org'), kb: getSetting(db, 'kb'), schedule: getSetting(db, 'schedule'), ai: { ...getSetting(db, 'ai'), enabled: false }, autoReply: getSetting(db, 'autoReply') };
  const offer = [{ date: addDays(todayCN(), 1), slot: '09:30' }];
  const h = [{ dir: 'out', text: '你好' }, { dir: 'in', text: '你好' }];
  const ask = async slots => (await suggestReply({ verdict: '推荐', slots }, h, { settings, db, origin: 'greeted', offer, role: zx })).reply;
  assert.match(await ask({ employed: '离职', live: '铁西' }), /统招/);
  assert.match(await ask({ employed: '离职', live: '铁西', tongzhao: '统招' }), /销售|招生|课程顾问/);
  assert.match(await ask({ employed: '离职', live: '铁西', tongzhao: '统招', exp: '有' }), /提成/);
  assert.doesNotMatch(await ask({ employed: '离职', live: '铁西' }), /科目/);
});
