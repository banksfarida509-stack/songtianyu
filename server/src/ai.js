// AI layer: short recommendation reasons + chat reply suggestions.
// The LLM only extracts and drafts; state changes, slot booking and the
// send/no-send decision are deterministic and checked here.
import { chat, parseJson, llmConfigured } from './llm.js';
import { clip, todayCN, addDays } from './util.js';

// ---- platform blocking rules (taken from 智联 chat page im.riskRules, subset) ----
export const PLATFORM_RISK = [
  ['6 位以上连续数字', /[0-9]{6,}/],
  ['公众号', /公众号|公--众-号/],
  ['支付 / 转账', /支付宝|[Zz][Ff][Bb]|[转汇打付][帐账钱款]|卡号|账单|流水/],
  ['投资 / 虚拟币', /比特币|虚拟币|投资|入股/],
  ['第三方聊天软件', /脉信|云信|连信|口信|暗信|方信|企聊宝|ChatCube/],
];
export const GUARD = [
  ['承诺词“保证 / 一定”', /保证|一定能|肯定能|包过/],
  ['限制性表述（年龄 / 性别 / 婚育 / 户籍）', /已婚|未婚|生育|怀孕|男性优先|女性优先|户籍|本地人/],
];
export function riskCheck(text) {
  return {
    platform: PLATFORM_RISK.filter(([, re]) => re.test(text)).map(([n]) => n),
    guard: GUARD.filter(([, re]) => re.test(text)).map(([n]) => n),
  };
}

/** Numbers in a reply must come from the knowledge base or the booked slot. */
function numbersOutsideKb(text, allowed) {
  const nums = String(text).match(/\d+(?:[.:：]\d+)?/g) || [];
  return nums.filter(n => !allowed.includes(n.replace('：', ':')));
}

// ---- reasons ----
export async function polishReasons(settings, items) {
  // items: [{key, verdict, score, ruleReason, summary}]
  if (!items.length || !llmConfigured()) return null;
  const sys = `你是 K12 学校的招聘助理。根据规则结论和简历摘要，为每位候选人写一句不超过 36 个汉字的中文推荐理由，说清楚为什么推荐或不推荐。结论以规则为准，不得改变。只输出 JSON 数组：[{"key":"...","reason":"..."}]。`;
  const user = JSON.stringify(items.map(i => ({ key: i.key, 结论: i.verdict, 分数: i.score, 规则理由: i.ruleReason, 简历: i.summary })));
  const r = await chat(settings.ai, [{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 900, temperature: 0.2 });
  const arr = parseJson(r.content);
  const map = {};
  for (const x of Array.isArray(arr) ? arr : []) if (x && x.key && x.reason) map[x.key] = clip(String(x.reason).replace(/\s+/g, ''), 60);
  return { map, model: r.model };
}

// ---- chat suggestion ----
const INTENTS = ['提问', '提供信息', '约面时间', '确认参加', '改期', '拒绝', '议价', '要求真人', '交换联系方式', '其他'];

function fallbackIntent(text) {
  if (/真人|机器人|人工/.test(text)) return '要求真人';
  if (/工资|薪资|待遇|多少钱|保证.*万/.test(text)) return '议价';
  if (/微信|电话|手机号/.test(text)) return '交换联系方式';
  if (/改|换个时间|有事|去不了/.test(text)) return '改期';
  if (/不考虑|不去了|算了|已经找到|入职了/.test(text)) return '拒绝';
  if (/准时|好的.*到|一定到|会去|没问题/.test(text)) return '确认参加';
  if (/上午|下午|明天|后天|周[一二三四五六日]|点/.test(text)) return '约面时间';
  if (/资格证|到岗/.test(text)) return '提供信息';
  if (/[?？吗]/.test(text)) return '提问';
  return '其他';
}

/**
 * candidate: DB row (+parsed fields); history: [{dir:'in'|'out', text}]
 * ctx: {appt, settings}
 * Returns draft object; never sends anything itself.
 */
export async function suggestReply(candidate, history, ctx) {
  const { settings, appt } = ctx;
  const org = settings.org, kb = settings.kb, sched = settings.schedule;
  const last = [...history].reverse().find(m => m.dir === 'in');
  const lastText = last ? last.text : '';
  const slots = candidate.slots || {};
  const tomorrow = addDays(todayCN(), 1);

  let ai = null, model = null, err = null;
  if (llmConfigured() && settings.ai.enabled) {
    const sys = `你是${org.persona}，在招聘平台上和应聘教师岗位的候选人聊天。规则：
1. 身份透明：被问是否机器人时如实说是 AI 招聘助理，并表示可以转招聘老师。
2. 只能使用下面知识库里的事实，不得编造任何数字、薪资、承诺；知识库没有的问题回答“我请招聘老师确认后回复你”。
3. 不说“保证、一定”等承诺词，不提年龄、性别、婚育、户籍要求。
4. 不在消息里写电话、微信号、公众号、链接或 6 位以上数字；交换联系方式由平台按钮完成。
5. 目标：了解教师资格证、最早到岗时间、可面试时间（上午 9:00–11:00 或下午 13:00–15:00），然后约初试。面试地点统一在${org.place}。
6. 回复简短口语化，不超过 60 字。
知识库：${kb.map(k => `[${k.id}] ${k.q}：${k.a}`).join(' ')}
今天是 ${todayCN()}，明天是 ${tomorrow}。
已知信息：${JSON.stringify(slots)}；当前面试安排：${appt ? `${appt.date} ${appt.slot}（${appt.status}）` : '无'}。
只输出 JSON：{"intent":"${INTENTS.join('|')}","slots":{"cert":"有/没有/在考/null","arrive":"到岗时间或null","day":"YYYY-MM-DD 或 null","half":"am/pm/any/null"},"reply":"给候选人的回复","kb":["引用的知识库编号"]}`;
    const msgs = [{ role: 'system', content: sys }];
    for (const m of history.slice(-12)) msgs.push({ role: m.dir === 'in' ? 'user' : 'assistant', content: clip(m.text, 300) });
    try {
      const r = await chat(settings.ai, msgs, { maxTokens: 400, temperature: 0.3 });
      ai = parseJson(r.content); model = r.model;
    } catch (e) { err = e.message; }
  }
  const intent = INTENTS.includes(ai?.intent) ? ai.intent : fallbackIntent(lastText);
  const newSlots = {};
  if (ai?.slots) for (const [k, v] of Object.entries(ai.slots)) if (v && v !== 'null') newSlots[k] = String(v);
  if (!ai) { // keyword extraction fallback
    if (/有.*资格证|资格证.*有/.test(lastText)) newSlots.cert = '有';
    if (/上午/.test(lastText)) newSlots.half = 'am'; else if (/下午/.test(lastText)) newSlots.half = 'pm';
    if (/明天/.test(lastText)) newSlots.day = tomorrow;
  }

  let reply = ai?.reply ? String(ai.reply) : '';
  let action = null, slot = null, handoff = false, handoffWhy = null, stateChange = null;

  if (intent === '约面时间' || (intent === '提供信息' && newSlots.half)) {
    const half = newSlots.half && newSlots.half !== 'null' ? newSlots.half : 'any';
    const { findSlot } = await import('./schedule.js');
    slot = ctx.db ? findSlot(ctx.db, { half, fromDate: newSlots.day || null }) : null;
    if (slot) {
      const when = slot.date === tomorrow ? `明天（${slot.date.slice(5)}）` : slot.date.slice(5);
      reply = `好的，给你约在${when} ${slot.slot} 到${org.place}初试，到了跟前台报名字就行。我现在发正式面试邀请给你。`;
      action = '约面试';
      stateChange = { attend: '待确认' };
    } else {
      reply = '这几天的面试名额已经约满了，我请招聘老师和你确认其他时间。';
      handoff = true; handoffWhy = '可约时段已满';
    }
  } else if (intent === '确认参加' && appt) {
    reply = reply || `好的，${appt.date.slice(5)} ${appt.slot} 见，前一天和当天早上我会再提醒你。`;
    stateChange = { attend: '确认参加', apptStatus: '确认参加' };
  } else if (intent === '改期') {
    reply = reply || '没关系，你看哪天上午或下午方便？我重新帮你约。';
    stateChange = { attend: '改期中', apptStatus: '改期中' };
  } else if (intent === '拒绝') {
    reply = reply || '好的，感谢你抽时间了解，祝求职顺利，之后不再打扰你。';
    stateChange = { attend: '不来' };
  } else if (intent === '交换联系方式') {
    reply = '可以的，我发一个交换微信的请求，你点同意就行。';
    action = '换微信';
  } else if (intent === '议价' || intent === '要求真人') {
    handoff = true; handoffWhy = intent === '议价' ? '候选人议价' : '候选人要求真人';
    reply = reply || '这个问题我请招聘老师直接和你沟通。';
  }
  if (!reply) reply = '收到，想先了解一下：你有教师资格证吗？最早什么时候能到岗？';

  // ---- checks ----
  const kbText = kb.map(k => k.a).join(' ') + ' ' + [...sched.am, ...sched.pm].join(' ') + (slot ? ` ${slot.slot} ${slot.date.slice(5)}` : '') + (appt ? ` ${appt.slot} ${appt.date.slice(5)}` : '');
  const allowed = (kbText.match(/\d+(?:[.:：]\d+)?/g) || []).map(n => n.replace('：', ':'));
  const risk = riskCheck(reply);
  const badNums = numbersOutsideKb(reply, allowed);
  const guardHits = [...risk.guard, ...(badNums.length ? [`数字不在知识库：${badNums.join('、')}`] : [])];
  const blocked = guardHits.length > 0 || risk.platform.length > 0;
  if (blocked) { handoff = true; handoffWhy = handoffWhy || '回复未通过检查'; }

  return {
    intent, reply: clip(reply, 200), slots: newSlots, action, slot,
    checks: { guard: guardHits, platform: risk.platform }, blocked,
    handoff, handoffWhy, stateChange, model: model || (err ? `规则回退（${clip(err, 80)}）` : '规则回退（未配置 AI）'),
  };
}
