import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMode, splitHuman } from '../src/ai.js';
import { DEFAULT_SETTINGS } from '../src/db.js';

const AR = { ...DEFAULT_SETTINGS.autoReply, enabled: true };
const draft = over => ({ intent: '提问', reply: '学校在沈阳，面试在学校本部。你有教师资格证吗？', blocked: false, handoff: false, ...over });
const opts = over => ({ autoReply: AR, override: null, nowHM: '10:00', sentLastHour: 0, ...over });

test('按分类：提问 → 全自动，带等待时间', () => {
  const d = decideMode(draft(), opts());
  assert.equal(d.mode, 'auto');
  assert.ok(d.delayMs >= AR.delayMin * 1000);
});
test('总开关关闭 → 半自动', () => {
  assert.equal(decideMode(draft(), opts({ autoReply: { ...AR, enabled: false } })).mode, 'semi');
});
test('议价默认转人工；回复没过检查一律转人工', () => {
  assert.equal(decideMode(draft({ intent: '议价' }), opts()).mode, 'human');
  assert.equal(decideMode(draft({ blocked: true }), opts({ override: 'auto' })).mode, 'human');
});
test('不在时段 / 超过每小时上限 → 半自动', () => {
  assert.equal(decideMode(draft(), opts({ nowHM: '22:30' })).mode, 'semi');
  assert.equal(decideMode(draft(), opts({ sentLastHour: 999 })).mode, 'semi');
});
test('AI 不可用时，自由问答不自动发', () => {
  assert.equal(decideMode(draft({ byAi: false }), opts()).mode, 'semi');
  assert.equal(decideMode(draft({ byAi: false, intent: '确认参加' }), opts()).mode, 'auto');
});
test('单个会话覆盖分类设置', () => {
  assert.equal(decideMode(draft({ intent: '其他' }), opts({ override: 'auto' })).mode, 'auto');
  assert.equal(decideMode(draft(), opts({ override: 'semi' })).mode, 'semi');
});
test('长回复有时拆成两条，拆开后内容不丢', () => {
  const t = '面试在学校本部，到了跟前台报名字就行。你这边有教师资格证吗？';
  for (let i = 0; i < 30; i++) {
    const p = splitHuman(t);
    assert.ok(p.length === 1 || p.length === 2);
    assert.equal(p.join('').replace(/。/g, ''), t.replace(/。/g, ''));
  }
});
