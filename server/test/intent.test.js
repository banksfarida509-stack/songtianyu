import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screen, normalizeZhaopin } from '../src/rules.js';
import { DEFAULT_SETTINGS } from '../src/db.js';

const rules = DEFAULT_SETTINGS.rules;
const card = over => normalizeZhaopin({
  resumeNumber: 'x1', userName: '测试', age: 25, educationLevel: '本科',
  workExperiences: [{ beginDate: '2023.07', endDate: '至今', companyName: '某科技公司', jobTitle: '运营专员' }],
  educationExperiences: [{ schoolName: '沈阳理工大学', majorName: '工商管理', educationLevel: '本科' }],
  ...over,
});

test('意向型：本科、≤30 岁、求职方向是老师，无教学经验 → 推荐', () => {
  const r = screen(card({ intentText: '初中数学老师 教师' }), rules);
  assert.equal(r.verdict, '推荐');
  assert.match(r.reason, /意向型/);
  assert.ok(r.rules.some(x => x.id === 'R05' && x.ok));
});

test('意向型：超过 30 岁不适用', () => {
  assert.equal(screen(card({ age: 31, intentText: '教师' }), rules).verdict, '不推荐');
});

test('意向型：大专不适用', () => {
  assert.equal(screen(card({ educationLevel: '大专', educationExperiences: [{ schoolName: 'x', majorName: '会计', educationLevel: '大专' }], intentText: '助教' }), rules).verdict, '不推荐');
});

test('意向型：求职方向不是教师类不适用', () => {
  assert.equal(screen(card({ intentText: '新媒体运营' }), rules).verdict, '不推荐');
});

test('意向型：关闭开关后不适用', () => {
  assert.equal(screen(card({ intentText: '教师' }), { ...rules, intentTrack: false }).verdict, '不推荐');
});

test('意向型分数低于有学校教学经历的人', () => {
  const a = screen(card({ intentText: '教师' }), rules);
  const b = screen(card({ workExperiences: [{ beginDate: '2023', endDate: '至今', companyName: '某县第一中学', jobTitle: '数学教师' }], educationExperiences: [{ schoolName: '辽宁大学', majorName: '数学与应用数学', educationLevel: '本科' }] }), rules);
  assert.equal(b.verdict, '推荐');
  assert.ok(a.score < b.score, `${a.score} < ${b.score}`);
});
