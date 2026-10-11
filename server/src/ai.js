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

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/** Longer replies are sometimes sent as two bubbles, the way people type. */
export function splitHuman(text) {
  if (text.length < 28 || Math.random() < 0.4) return [text];
  const cuts = [...text.matchAll(/[。！？!?]/g)].map(m => m.index + 1).filter(i => i > 6 && i < text.length - 4);
  if (!cuts.length) return [text];
  const mid = text.length / 2;
  const at = cuts.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  return [text.slice(0, at).replace(/。$/, ''), text.slice(at).trim()];
}

export const CHAT_MODES = { auto: '全自动', semi: '半自动', human: '转人工' };

/**
 * Decide how this draft is handled. Full-auto only when every gate passes;
 * anything doubtful falls back to 半自动 (suggestion) or 转人工.
 * opts: { autoReply, override ('auto'|'semi'|null), nowHM 'HH:MM', sentLastHour }
 */
export function decideMode(draft, { autoReply, override, nowHM, sentLastHour }) {
  const ar = autoReply || {};
  if (draft.blocked) return { mode: 'human', why: '回复没通过发送前检查' };
  if (draft.handoff) return { mode: 'human', why: draft.handoffWhy || '需要人工' };
  const byPolicy = (ar.policy || {})[draft.intent] || 'semi';
  const want = override || byPolicy;
  const src = override ? '本会话设为' : `分类「${draft.intent}」设为`;
  if (want === 'human') return { mode: 'human', why: `${src}转人工` };
  if (want === 'semi') return { mode: 'semi', why: `${src}半自动` };
  // without the LLM the canned reply cannot answer free questions; only fixed-flow intents may go out alone
  if (draft.byAi === false && !['约面时间', '确认参加', '改期', '拒绝', '交换联系方式'].includes(draft.intent)) return { mode: 'semi', why: 'AI 暂不可用，规则回复不自动发' };
  if (!ar.enabled) return { mode: 'semi', why: '全自动总开关未打开' };
  const [h0, h1] = ar.hours || ['00:00', '23:59'];
  if (nowHM < h0 || nowHM > h1) return { mode: 'semi', why: `不在自动回复时段（${h0}–${h1}）` };
  if (sentLastHour >= (ar.maxPerHour || 40)) return { mode: 'semi', why: `已达每小时自动发送上限 ${ar.maxPerHour}` };
  const lo = Math.max(5, ar.delayMin ?? 25), hi = Math.max(lo, ar.delayMax ?? 90);
  const typing = Math.min(20, draft.reply.length * 0.3);
  return { mode: 'auto', why: `${src}全自动`, delayMs: Math.round((lo + Math.random() * (hi - lo) + typing) * 1000) };
}

// ---- chat suggestion ----
const INTENTS = ['提问', '提供信息', '约面时间', '确认参加', '改期', '拒绝', '议价', '要求真人', '交换联系方式', '其他'];

function fallbackIntent(text) {
  if (/真人|机器人|人工/.test(text)) return '要求真人';
  if (/在哪|地址|地点|位置/.test(text)) return '提问';
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

  const kbDoc = clip(settings.kbDoc || '', 6000);
  const style = settings.autoReply?.style || '';
  let ai = null, model = null, err = null;
  if (llmConfigured() && settings.ai.enabled) {
    const sys = `你代表${org.name || '学校'}招聘组，在招聘平台上和应聘教师岗位的候选人聊天。规则：
1. 说话风格：${style}回复 1–2 句，一般不超过 50 字；不要每句都以“好的”开头，不要重复你上一条已经问过的问题；称呼用“你”。
2. 身份透明：对方问你是不是机器人 / AI 时，如实说是${org.persona}，并说可以转招聘老师；没被问到时不用主动强调。
3. 只能使用下面知识库里的事实，不得编造任何数字、薪资、福利、承诺；知识库没有的问题，回答“这个我跟招聘老师确认一下再回你”。
4. 不说“保证、一定”等承诺词，不提年龄、性别、婚育、户籍要求。
5. 不在消息里写电话、微信号、公众号、链接或 6 位以上数字；交换联系方式由平台按钮完成。
6. 目标：了解教师资格证、最早到岗时间、可面试时间（上午 9:00–11:00 或下午 13:00–15:00），然后约初试。面试地点统一在${org.place}。
知识库（问答）：${kb.map(k => `[${k.id}] ${k.q}：${k.a}`).join(' ')}
${kbDoc ? `知识库（资料原文，编号 DOC）：\n${kbDoc}\n` : ''}今天是 ${todayCN()}，明天是 ${tomorrow}。
已知信息：${JSON.stringify(slots)}；当前面试安排：${appt ? `${appt.date} ${appt.slot}（${appt.status}）` : '无'}。
只输出 JSON：{"intent":"${INTENTS.join('|')}","slots":{"cert":"有/没有/在考/null","arrive":"到岗时间或null","day":"YYYY-MM-DD 或 null","half":"am/pm/any/null"},"reply":"给候选人的回复","kb":["引用的知识库编号"]}`;
    const msgs = [{ role: 'system', content: sys }];
    for (const m of history.slice(-12)) msgs.push({ role: m.dir === 'in' ? 'user' : 'assistant', content: clip(m.text, 300) });
    // one retry with the providers swapped: covers transient gateway errors and non-JSON output
    const swapped = { ...settings.ai, provider: settings.ai.fallbackProvider, model: settings.ai.fallbackModel, fallbackProvider: settings.ai.provider, fallbackModel: settings.ai.model };
    for (const cfg of [settings.ai, swapped]) {
      try {
        const r = await chat(cfg, msgs, { maxTokens: 400, temperature: 0.6 });
        ai = parseJson(r.content); model = r.model; err = null;
        if (ai && typeof ai.reply === 'string') break;
      } catch (e) { err = e.message; console.error('[ai] suggest failed:', clip(e.message, 200)); }
    }
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
      reply = pick([
        `行，那就${when} ${slot.slot}，来${org.place}初试，到了跟前台报一下名字就可以。`,
        `可以的，给你约${when} ${slot.slot}，地点在${org.place}，到前台说名字就行。`,
        `那定${when} ${slot.slot}吧，${org.place}面试，到了找前台报名字。`,
      ]);
      action = '约面试';
      stateChange = { attend: '待确认' };
    } else {
      reply = pick(['这几天面试名额排满了，我问下招聘老师还能不能加个时间，晚点回你。', '最近几天的面试都约满了，我跟招聘老师商量下其他时间再告诉你。']);
      handoff = true; handoffWhy = '可约时段已满';
    }
  } else if (intent === '确认参加' && appt) {
    reply = reply || pick([`好嘞，那${appt.date.slice(5)} ${appt.slot} 见。`, `行，${appt.date.slice(5)} ${appt.slot} 见，路上注意安全。`]);
    stateChange = { attend: '确认参加', apptStatus: '确认参加' };
  } else if (intent === '改期') {
    reply = reply || pick(['没事，你看哪天上午或者下午方便？我重新给你排。', '可以的，那你看换到哪天合适？上午下午都行。']);
    stateChange = { attend: '改期中', apptStatus: '改期中' };
  } else if (intent === '拒绝') {
    reply = reply || pick(['好的，理解，祝你找工作顺利。', '明白了，谢谢你回复，祝一切顺利。']);
    stateChange = { attend: '不来' };
  } else if (intent === '交换联系方式') {
    reply = pick(['可以，我这边发个交换微信的请求，你点同意就行。', '行，我发个换微信的请求给你，同意一下就好。']);
    action = '换微信';
  } else if (intent === '议价') {
    handoff = true; handoffWhy = '候选人议价';
    reply = reply || '薪资是按经验定级的，具体这块我让招聘老师直接跟你说。';
  } else if (intent === '要求真人') {
    // “你是机器人吗” → answer honestly; only an explicit ask for a person hands off
    if (/真人|人工|转.*老师|找.*(老师|负责人|领导)/.test(lastText)) { handoff = true; handoffWhy = '候选人要求真人'; reply = reply || '好的，我这就请招聘老师来跟你聊。'; }
    else reply = reply || `是的，我是${org.persona}，你想跟招聘老师直接聊的话我随时帮你转。`;
  }
  if (!reply && /在哪|地址|地点|位置/.test(lastText)) {
    const k = kb.find(x => /地点|地址/.test(x.q));
    if (k) reply = `${k.a}你这边有教师资格证吗？`;
  }
  if (!reply) reply = pick(['收到。你这边有教师资格证吗？', '好的。方便说下你有没有教师资格证吗？最快什么时候能到岗？']);

  // ---- checks ----
  const kbText = kb.map(k => k.a).join(' ') + ' ' + kbDoc + ' ' + [...sched.am, ...sched.pm].join(' ') + (slot ? ` ${slot.slot} ${slot.date.slice(5)}` : '') + (appt ? ` ${appt.slot} ${appt.date.slice(5)}` : '');
  const allowed = (kbText.match(/\d+(?:[.:：]\d+)?/g) || []).map(n => n.replace('：', ':'));
  const risk = riskCheck(reply);
  const badNums = numbersOutsideKb(reply, allowed);
  const guardHits = [...risk.guard, ...(badNums.length ? [`数字不在知识库：${badNums.join('、')}`] : [])];
  const blocked = guardHits.length > 0 || risk.platform.length > 0;
  if (blocked) { handoff = true; handoffWhy = handoffWhy || '回复未通过检查'; }

  reply = clip(reply, 200);
  return {
    intent, reply, parts: splitHuman(reply), slots: newSlots, action, slot, byAi: !!ai,
    checks: { guard: guardHits, platform: risk.platform }, blocked,
    handoff, handoffWhy, stateChange, model: model || (err ? `规则回退（${clip(err, 80)}）` : '规则回退（未配置 AI）'),
  };
}
