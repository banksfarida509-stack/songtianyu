import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getSetting, DEFAULT_SETTINGS } from '../src/db.js';
import { suggestReply, decideMode } from '../src/ai.js';
import { addDays, todayCN } from '../src/util.js';

const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hrsc-')), 't.db'));
const settings = { org: getSetting(db, 'org'), kb: getSetting(db, 'kb'), schedule: getSetting(db, 'schedule'), ai: { ...getSetting(db, 'ai'), enabled: false }, autoReply: getSetting(db, 'autoReply'), playbook: getSetting(db, 'playbook') };
const offer = [{ date: addDays(todayCN(), 1), slot: '09:30' }, { date: addDays(todayCN(), 1), slot: '13:00' }];
const ask = [{ dir: 'in', text: '你好，我投递了贵校的数学老师岗位' }];
const AR = { ...DEFAULT_SETTINGS.autoReply, enabled: true, hours: ['00:00', '23:59'] };

test('主动投递 + 不符合 → 婉拒，标记不合适，可全自动', async () => {
  const d = await suggestReply({ verdict: '不推荐', reason: '年龄超过上限', slots: {} }, ask, { settings, db, origin: 'applied', offer });
  assert.equal(d.intent, '投递-不符合');
  assert.equal(d.stateChange.attend, '不合适');
  assert.doesNotMatch(d.reply, /年龄|岁/);
  assert.equal(d.blocked, false);
  assert.equal(decideMode(d, { autoReply: AR, nowHM: '10:00', sentLastHour: 0 }).mode, 'auto');
});

test('投递后先聊了几句，读到简历判不符合 → 下一条礼貌婉拒', async () => {
  const h = [...ask, { dir: 'out', text: '收到你的投递，你现在是在职还是已经离职？' }, { dir: 'in', text: '已经离职了' }];
  const d = await suggestReply({ verdict: '不推荐', reason: '专升本', attend: '沟通中', slots: {} }, h, { settings, db, origin: 'applied', offer });
  assert.equal(d.intent, '投递-不符合');
  assert.equal(d.stateChange.attend, '不合适');
  assert.doesNotMatch(d.reply, /专升本|学历/);
  assert.match(d.reply, /不太匹配|不太契合/);
});

test('同事在会话里亲自聊过，或已约面试 → 不自动婉拒', async () => {
  const h = [...ask, { dir: 'out', text: '看你简历还是蛮合适的，方便聊聊吗', human: true }, { dir: 'in', text: '可以' }];
  const d = await suggestReply({ verdict: '不推荐', attend: '沟通中', slots: {} }, h, { settings, db, origin: 'applied', offer });
  assert.notEqual(d.intent, '投递-不符合');
  const h2 = [...ask, { dir: 'out', text: '你明天上午方便来面试吗？' }, { dir: 'in', text: '可以' }];
  const d2 = await suggestReply({ verdict: '不推荐', attend: '待确认', slots: {} }, h2, { settings, db, origin: 'applied', offer });
  assert.notEqual(d2.intent, '投递-不符合');
});

test('我们先打招呼的会话，判不符合也不自动婉拒', async () => {
  const h = [{ dir: 'out', text: '你好，看了你的简历比较适合' }, { dir: 'in', text: '你好' }, { dir: 'out', text: '你现在在职吗？' }, { dir: 'in', text: '离职了' }];
  const d = await suggestReply({ verdict: '不推荐', attend: '沟通中', slots: {} }, h, { settings, db, origin: 'greeted', offer });
  assert.notEqual(d.intent, '投递-不符合');
});

test('主动投递 + 符合 → 先寒暄、问在职情况，不急着约时间', async () => {
  const d = await suggestReply({ verdict: '推荐', slots: {} }, ask, { settings, db, origin: 'applied', offer });
  assert.equal(d.intent, '投递-符合');
  assert.match(d.reply, /在职/);
  assert.doesNotMatch(d.reply, /09:30/);
  assert.equal(d.blocked, false, JSON.stringify(d.checks));
});

test('无 AI 时也能记下在职情况和住处', async () => {
  const d = await suggestReply({ verdict: '推荐', slots: {} }, [{ dir: 'out', text: '你现在在职吗？' }, { dir: 'in', text: '已经离职了，住在铁西区附近' }], { settings, db, origin: 'applied', offer });
  assert.equal(d.slots.employed, '离职');
  assert.equal(d.slots.live, '铁西区');
});

test('主动投递 + 信息不全 → 先问在职情况，不问教资', async () => {
  const d = await suggestReply({ verdict: '待确认', slots: {} }, ask, { settings, db, origin: 'applied', offer });
  assert.equal(d.intent, '投递-待确认');
  assert.match(d.reply, /在职/);
  assert.doesNotMatch(d.reply, /资格证/);
});

test('按顺序问基本情况：在职 → 住处 → 科目 → 开始工作时间 → 邀约；从不追问教资', async () => {
  const base = [{ dir: 'out', text: '你好' }, { dir: 'in', text: '你好' }];
  const step = async slots => (await suggestReply({ verdict: '推荐', slots }, base, { settings, db, origin: 'greeted', offer })).reply;
  assert.match(await step({}), /在职/);
  assert.match(await step({ employed: '离职' }), /住/);
  assert.match(await step({ employed: '离职', live: '铁西' }), /科目/);
  assert.match(await step({ employed: '离职', live: '铁西', subject: '数学' }), /开始工作/);
  assert.match(await step({ employed: '离职', live: '铁西', subject: '数学', arrive: '下周' }), /初试/);
  for (const s of [{}, { employed: '离职' }]) assert.doesNotMatch(await step(s), /资格证/);
});

test('无 AI 时也能记下想教的科目和开始工作时间', async () => {
  const d = await suggestReply({ verdict: '推荐', slots: {} }, [{ dir: 'out', text: '想教哪科？' }, { dir: 'in', text: '我想教初中数学，下周就可以开始上班' }], { settings, db, origin: 'greeted', offer });
  assert.equal(d.slots.subject, '初中数学');
  assert.equal(d.slots.arrive, '下周');
});

test('平台自动招呼语在前、候选人发附件简历 → 仍按投递处理', async () => {
  const h = [{ dir: 'out', text: '您好，感谢关注，欢迎投递简历' }, { dir: 'in', text: '[卡片·附件简历] 这是我的附件简历，请查收' }];
  const d = await suggestReply({ verdict: '推荐', slots: {} }, h, { settings, db, origin: 'applied', offer });
  assert.equal(d.intent, '投递-符合');
});

test('投递卡片 → 平台自动招呼语（模板）→ 附件简历：仍按投递首条回复处理', async () => {
  const h = [{ dir: 'in', text: '[卡片] 对方投递了您的职位' }, { dir: 'out', text: '你好呀！沈阳最大教培企业招教师啦', tpl: true }, { dir: 'in', text: '[卡片·附件简历] 您好，这是我的附件简历，请查收' }];
  const d = await suggestReply({ verdict: '待确认', slots: {} }, h, { settings, db, origin: 'applied', offer });
  assert.equal(d.intent, '投递-待确认');
});

test('我们先打招呼的会话不走投递场景', async () => {
  const d = await suggestReply({ verdict: '推荐', slots: {} }, [{ dir: 'out', text: '你好，看到你在找数学老师的工作' }, { dir: 'in', text: '你好，学校在哪？' }], { settings, db, origin: 'greeted', offer });
  assert.ok(!String(d.intent).startsWith('投递'));
});
