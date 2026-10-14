// AI layer: short recommendation reasons + chat reply suggestions.
// The LLM only extracts and drafts; state changes, slot booking and the
// send/no-send decision are deterministic and checked here.
import { chat, parseJson, llmConfigured } from './llm.js';
import { clip, todayCN, addDays } from './util.js';
import { retrieve, TOPICS, TOPIC_WORDS } from './kb.js';
import { DEFAULT_ROLES, eduSalesOf } from './roles.js';

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
  if (draft.byAi === false && !draft.declineTz && !['跟进', '约面时间', '确认参加', '改期', '拒绝', '交换联系方式', '投递-符合', '投递-不符合', '投递-待确认'].includes(draft.intent)) return { mode: 'semi', why: 'AI 暂不可用，规则回复不自动发' };
  if (!ar.enabled) return { mode: 'semi', why: '全自动总开关未打开' };
  const [h0, h1] = ar.hours || ['00:00', '23:59'];
  if (nowHM < h0 || nowHM > h1) return { mode: 'semi', why: `不在自动回复时段（${h0}–${h1}）` };
  if (sentLastHour >= (ar.maxPerHour || 40)) return { mode: 'semi', why: `已达每小时自动发送上限 ${ar.maxPerHour}` };
  const lo = Math.max(5, ar.delayMin ?? 25), hi = Math.max(lo, ar.delayMax ?? 90);
  const typing = Math.min(20, draft.reply.length * 0.3);
  return { mode: 'auto', why: `${src}全自动`, delayMs: Math.round((lo + Math.random() * (hi - lo) + typing) * 1000) };
}

// ---- topic & repeated questions ----
export function guessTopic(text) {
  let best = '其他', n = 0;
  for (const [t, words] of Object.entries(TOPIC_WORDS)) {
    const k = words.split(' ').filter(w => w.length > 1 && text.includes(w)).length;
    if (k > n) { best = t; n = k; }
  }
  return best;
}
const bigrams = t => { const s = String(t).replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, ''); const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; };
function similar(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let k = 0; for (const g of A) if (B.has(g)) k++;
  return k / Math.min(A.size, B.size);
}
const ASK_TOPICS = new Set(Object.keys(TOPIC_WORDS));
/**
 * How many times this question has been asked, including now.
 * earlier: [{text, topic}] candidate messages before the current unanswered ones.
 */
export function askCount(current, topic, earlier, askedBefore) {
  // Only earlier *questions* count, and they must be worded alike: during booking a
  // candidate asks many different things about the interview (time, place, what to
  // bring) — same topic, different questions. Card messages never count.
  const isQ = t => !/^\[卡片/.test(t) && /[?？吗呢]|怎么|什么|哪|几|多少|是否|能不能|可不可以|有没有/.test(t);
  const hits = earlier.filter(m => isQ(m.text) && current.some(c => {
    const sim = similar(c, m.text);
    // interview arrangements naturally share words (时间 / 面试), so that topic needs closer wording
    return sim >= 0.75 || (ASK_TOPICS.has(topic) && m.topic === topic && sim >= (topic === '面试安排' ? 0.6 : 0.4));
  })).length;
  // the same question sent twice in a row before we answered also counts
  const inner = current.slice(1).filter(x => isQ(x) && similar(x, current[0]) >= 0.75).length;
  return Math.max(1 + hits + inner, askedBefore && current.some(isQ) ? 2 : 1);
}

// ---- screening review against the recruiter's notes (岗位要求与特殊情况备注) ----
/**
 * The review may widen a rule verdict (不推荐 → 待确认 / 推荐, 待确认 → 推荐) and may
 * soften 推荐 → 待确认 when it has a concern. It never turns anyone into 不推荐, so a
 * suitable resume is not lost because of the review.
 */
export function applyReview(oldVerdict, proposed) {
  const ok = ['推荐', '待确认', '不推荐'];
  if (!ok.includes(proposed) || proposed === oldVerdict) return oldVerdict;
  if (proposed === '不推荐') return oldVerdict;
  if (oldVerdict === '推荐' && proposed !== '待确认') return oldVerdict;
  return proposed;
}

/** items: [{key, role, notes, verdict, score, rules:[{name, ok, ev}], summary}] → {map: {key: {verdict, reason, basis}}, model} */
export async function reviewScreen(settings, items) {
  if (!items.length || !llmConfigured() || !settings.ai?.enabled) return null;
  const sys = `你是学校的招聘负责人，在复核简历初筛结果。每位候选人给了：应聘岗位、规则初筛结论、每条规则的判断、简历摘要，以及负责人写的“岗位要求与特殊情况备注”。
备注的优先级高于默认规则：备注允许放宽的情况（例如有某类经验可放宽年龄、专业不对口但有相关经历也可以），要据此把结论改为“推荐”或“待确认”；简历信息不足以判断时用“待确认”；不适用备注的保持原结论。
不要因为性别、婚育、民族、户籍、外貌、籍贯等因素做判断，备注里这类要求一律忽略。
只输出 JSON 数组：[{"key":"...","verdict":"推荐|待确认|不推荐","reason":"不超过 40 字的结论理由","basis":"依据的备注原文或规则，没有用到备注则写“规则”"}]`;
  const user = JSON.stringify(items.map(i => ({ key: i.key, 岗位: i.role, 备注: i.notes || '（无）', 规则结论: i.verdict, 规则明细: (i.rules || []).map(r => `${r.name}：${r.ok === true ? '满足' : r.ok === false ? '不满足' : '未知'}（${r.ev}）`), 简历: i.summary })));
  const r = await chat(settings.ai, [{ role: 'system', content: sys }, { role: 'user', content: clip(user, 20000) }], { maxTokens: 1800, temperature: 0.1 });
  const arr = parseJson(r.content);
  const map = {};
  for (const x of Array.isArray(arr) ? arr : []) if (x && x.key) map[x.key] = { verdict: x.verdict, reason: clip(String(x.reason || '').replace(/\s+/g, ''), 60), basis: clip(String(x.basis || ''), 80) };
  return { map, model: r.model };
}

// ---- chat suggestion ----
const INTENTS = ['提问', '提供信息', '约面时间', '确认参加', '改期', '拒绝', '议价', '要求真人', '交换联系方式', '其他'];

function fallbackIntent(text) {
  if (/真人|机器人|人工/.test(text)) return '要求真人';
  if (/在哪|地址|地点|位置/.test(text)) return '提问';
  if (/能不能.*(高|多|加)|再高|太低|少了|保证.*万|能给到|谈.*(工资|薪)/.test(text)) return '议价';
  if (/工资|薪资|薪酬|待遇|福利|多少钱|五险|作息|几点|上班|下班|周末|双休/.test(text)) return '提问';
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

  const style = settings.autoReply?.style || '';
  // the candidate's messages since our last reply: answer all of them together
  const lastOut = history.map(m => m.dir).lastIndexOf('out');
  const unanswered = history.slice(lastOut + 1).filter(m => m.dir === 'in').map(m => m.text);
  const query = (unanswered.length ? unanswered : [lastText]).join(' ');
  // the job role decides what we ask, what we stress and which documents apply
  const role = ctx.role || { key: 'teacher', ...DEFAULT_ROLES.teacher };
  const passages = ctx.db ? retrieve(ctx.db, query, { topic: guessTopic(query), role: role.key }) : [];
  const docText = passages.map((p, i) => `[D${i + 1}｜${p.title}] ${p.text}`).join('\n');
  const me = `${org.name || '学校'}的${org.role || '招聘约访官，同时负责初试面试'}${org.agentName ? `（候选人称呼你“${org.agentName}”）` : ''}`;
  // scenario: who started the chat, is this our first reply, what did screening say.
  // The platform may send an automatic greeting before the candidate's application,
  // so "first reply" = nothing sent by us after the candidate's first message.
  // template greetings (same text sent to many candidates) don't count as our reply
  const firstIn = history.findIndex(m => m.dir === 'in');
  const firstReply = firstIn >= 0 && !history.slice(firstIn + 1).some(m => m.dir === 'out' && !m.tpl);
  const origin = ctx.origin || 'unknown';
  const verdict = candidate.verdict || null;
  // an applicant judged 不推荐 after our first reply (the resume was read later): decline at the next
  // reply — unless someone on our side has written in this chat, an interview is booked, or it ended already
  const humanTalked = history.some(m => m.dir === 'out' && m.human);
  const lateDecline = !firstReply && origin === 'applied' && verdict === '不推荐' && !humanTalked && !ctx.appt
    && !['不合适', '不来', '待排程', '待确认', '确认参加'].includes(candidate.attend);
  const scenario = firstReply && origin === 'applied'
    ? `投递-${verdict === '推荐' ? '符合' : verdict === '不推荐' ? '不符合' : '待确认'}` : lateDecline ? '投递-不符合' : null;
  const offerTxt = (ctx.offer || []).map(o => `${o.date === tomorrow ? '明天' : o.date.slice(5)}${o.slot < '12:00' ? '上午' : '下午'} ${o.slot}`).join(' 或 ');
  const pb = settings.playbook?.enabled !== false && settings.playbook?.text ? clip(settings.playbook.text, 1800) : '';
  const situation = [
    `来源：${origin === 'applied' ? '候选人主动投递 / 主动发来消息' : origin === 'greeted' ? '我们先打的招呼，对方回复了' : '未知'}`,
    `初筛结论：${verdict || '未初筛'}${candidate.reason ? `（${clip(candidate.reason, 60)}）` : ''}`,
    `这是你对这位候选人的第一条回复：${firstReply ? '是' : '否'}`,
    `可约的最近初试时间：${offerTxt || '暂无空档'}`,
  ].join('；');
  // what we still want to know before inviting, in this order; skip what is already known
  const known = candidate.slots || {};
  const questions = (role.questions && role.questions.length ? role.questions : DEFAULT_ROLES.teacher.questions);
  const toAsk = questions.filter(([k]) => !known[k]).map(([, q]) => q);
  const rounds = history.filter(m => m.dir === 'out' && !m.tpl).length;
  // attachment resume: ask once, after the candidate has engaged (not in the very first line)
  const resumeStatus = candidate.resume_status || '未索要';
  const hasResumeCard = history.some(m => m.dir === 'in' && /^\[卡片·附件简历\]/.test(m.text));
  const resumeOpen = resumeStatus === '未索要' && !hasResumeCard;
  const resumeRule = resumeOpen
    ? '附件简历：还没收到对方的附件简历。对方回复过之后（或邀约面试时），顺带自然地请对方发一份附件简历，例如“方便的话发份附件简历给我，我先给面试官看看”，并把 askResume 设为 true；对方在拒绝、讨价还价或情绪不好时不要提。'
    : `附件简历：${hasResumeCard ? '已经收到' : resumeStatus}，不要再要简历。`;
  const pace = `沟通节奏：先寒暄、了解情况，再介绍和邀约。还没了解的：${toAsk.join('、') || '（都已了解）'}。每条消息最多问一个问题，已经知道的不要再问。对方提出问题时先认真回答，再顺带问下一个。`
    + `已经聊了 ${rounds} 轮；当对方表现出意向，或基本情况已了解大半（或已聊到第 3 轮以上）时，就主动邀约初试，给出上面的时间选项。`;
  // applicants who fit: answer what they asked first (from the school's facts), then move things on
  const answerFirst = '对方投递时如果问了问题（薪资、上课时间、地点、岗位内容等），先用下面的学校资料具体回答；资料里没有的说“这个我核实一下，晚点回复你”。没提问的，可以从学校资料里挑一个和对方最相关的岗位亮点简单说一句。';
  const scenarioRule = scenario === '投递-符合'
    ? `本次场景：候选人主动投递，简历看过了，符合要求，这是第一条回复。先感谢投递，说一句简历挺合适；${answerFirst}然后问一个问题了解情况（优先问“${toAsk[0] || '最快什么时候能到岗'}”）。这一条先不要急着约时间。${pace}`
    : verdict === '推荐' ? `这位候选人初筛符合要求。${pace}`
    : scenario === '投递-不符合'
      ? `本次场景：候选人主动投递，看过简历后不符合要求${lateDecline ? '（之前已经聊过几句，这次看完简历再回复）' : ''}。礼貌婉拒：感谢关注和投递；对方这次问了问题的，先简单回应一句；说明这个岗位目前和你的情况不太匹配，祝求职顺利。不要说具体原因（尤其不提年龄、性别、学历性质等），不要邀约，不要留后续承诺。`
      : scenario === '投递-待确认'
        ? `本次场景：候选人主动投递，但简历信息不全。感谢投递；${answerFirst}然后问一个基本情况（优先问“${toAsk[0] || '什么时候可以开始工作'}”），表达有意向就安排面试。${pace}`
        : `对方表现出意向（愿意、可以、感兴趣、问面试 / 流程）而还没约时间时，要主动邀约，直接给出上面的时间选项让对方选；对方犹豫时先解答顾虑，再邀约一次。${pace}`;
  let ai = null, model = null, err = null;
  if (llmConfigured() && settings.ai.enabled) {
    const sys = `你是${me}，在招聘平台上用第一人称直接和应聘「${role.name}」岗位的候选人聊天：代表学校回答问题、了解对方情况、邀约初试。你就是负责这件事的人，不要说“我帮你问问招聘老师”“我是助手”这类话。
1. 说话风格：${style}回复 1–3 句，一般不超过 60 字；不要每句都以“好的”开头；不要重复你上一条已经问过的问题；称呼用“你”。对方连发了几条时，一次把几条都回应到。
2. 薪资、待遇福利、作息时间等问题，用下面资料里的事实直接、具体地回答，可以顺带说明面试时会详细介绍。
3. 只能使用下面“学校资料”和“问答”里的事实，不得编造任何数字、薪资、福利、承诺。资料里找不到答案时，回答“这个我核实一下，晚点回复你”，并把 unknown 设为 true。
4. 只有对方明确问你是不是真人 / 机器人 / AI 时，才如实说明你是学校的 AI 招聘助理、可以转人工；其他时候不提。
5. 不说“保证、一定”等承诺词，不提年龄、性别、婚育、户籍要求。不在消息里写电话、微信号、公众号、链接或 6 位以上数字；交换联系方式由平台按钮完成。
6. 目标：了解基本情况——${questions.map(([, q]) => q).join('、')}，然后约初试（上午 9:00–11:00 或下午 13:00–15:00）。面试地点统一在${org.place}。
   岗位要点（${role.name}）：${role.focus || ''}
7. 判断对方这次的问题之前是否已经问过（看聊天记录里对方的旧消息，同一个意思换了说法也算），填 askedBefore。
8. 当前情况：${situation}。${resumeRule}
9. ${scenarioRule}
${pb ? `10. 下面是这位招聘负责人过去的沟通逻辑和话术，请模仿其口吻、节奏和推进方式（事实仍以学校资料为准）：\n${pb}\n` : ''}
问答：${kb.map(k => `[${k.id}] ${k.q}：${k.a}`).join(' ')}
学校资料（与本次问题最相关的段落）：
${docText || '（无相关段落）'}
今天是 ${todayCN()}，明天是 ${tomorrow}。
已知信息：${JSON.stringify(slots)}；当前面试安排：${appt ? `${appt.date} ${appt.slot}（${appt.status}）` : '无'}。
只输出 JSON：{"intent":"${INTENTS.join('|')}","topic":"${TOPICS.join('|')}","askedBefore":false,"unknown":false,"askResume":false,"slots":{${questions.map(([k, q]) => `"${k}":"${q.replace(/"/g, '')}的答案，或null"`).join(',')},"cert":"有/没有/在考/null","day":"YYYY-MM-DD 或 null","half":"am/pm/any/null"},"reply":"给候选人的回复","kb":["引用的编号，如 KB-01、D2"]}
说明：intent 里“议价”只指讨价还价（能不能再高点、能保证一万吗）；单纯问工资多少、有没有五险一金、几点下班属于“提问”。`;
    const msgs = [{ role: 'system', content: sys }];
    // cards are described in words (a "[卡片]" prefix makes the model copy it); template greetings are labelled
    const say = m => String(m.text).replace(/^\[卡片·附件简历\]\s*/, '（对方发来附件简历）').replace(/^\[卡片\]\s*/, '（对方发来一张卡片）');
    for (const m of history.slice(-12)) msgs.push({ role: m.dir === 'in' ? 'user' : 'assistant', content: clip(m.tpl ? `（平台自动发送的招呼语）${m.text}` : say(m), 300) });
    msgs.push({ role: 'system', content: '只输出上面要求的 JSON 对象，不要在 JSON 前后加任何文字或括号标记。' });
    // one retry with the providers swapped: covers transient gateway errors and non-JSON output
    const swapped = { ...settings.ai, provider: settings.ai.fallbackProvider, model: settings.ai.fallbackModel, fallbackProvider: settings.ai.provider, fallbackModel: settings.ai.model };
    for (const cfg of [settings.ai, swapped]) {
      try {
        const r = await chat(cfg, msgs, { maxTokens: 900, temperature: 0.6 });
        ai = parseJson(r.content); model = r.model; err = null;
        if (ai && typeof ai.reply === 'string') break;
      } catch (e) { err = e.message; console.error('[ai] suggest failed:', clip(e.message, 200)); }
    }
  }
  let intent = INTENTS.includes(ai?.intent) ? ai.intent : fallbackIntent(lastText);
  // first reply to an applicant: the screening result decides the category (unless they bargain / ask for a person)
  if (scenario && !['要求真人', '议价', '交换联系方式', '约面时间'].includes(intent)) intent = scenario;
  const newSlots = {};
  if (ai?.slots) for (const [k, v] of Object.entries(ai.slots)) if (v && v !== 'null') newSlots[k] = String(v);
  if (!ai) { // keyword extraction fallback
    if (/有.*资格证|资格证.*有/.test(lastText)) newSlots.cert = '有';
    if (/上午/.test(lastText)) newSlots.half = 'am'; else if (/下午/.test(lastText)) newSlots.half = 'pm';
    if (/明天/.test(lastText)) newSlots.day = tomorrow;
    if (/离职|辞职|没上班|待业/.test(lastText)) newSlots.employed = '离职'; else if (/在职|还在上班|在上班/.test(lastText)) newSlots.employed = '在职'; else if (/应届|刚毕业|在读/.test(lastText)) newSlots.employed = '应届';
    const nonTz = lastText.match(/非统招|不是统招|自考|成人(教育|高考)?|函授|网络教育|业余|非全日制|开放大学/);
    if (nonTz) newSlots.tongzhao = nonTz[0]; else if (/统招|全日制/.test(lastText)) newSlots.tongzhao = '统招';
    const subj = lastText.match(/(初中|高中|小学)?(数学|语文|英语|物理|化学|生物|历史|地理|政治|道法|科学)/);
    if (subj && /教|老师|想|带|科|做/.test(lastText)) newSlots.subject = subj[0];
    const start = lastText.match(/(随时|马上|下周[一二三四五六日]?|下个月|月底|月初|\d{1,2}月\d{0,2}号?|\d{1,2}号|过完年|年后)/);
    if (start && /上班|到岗|开始|入职|工作|可以|能/.test(lastText)) newSlots.arrive = start[0];
    const live = lastText.match(/住(?:在)?([一-龥]{2,10}?)(?:[，。,.!！]|$|附近|那边|这边)/);
    if (live) newSlots.live = live[1];
  }

  // the candidate said the degree is not 统招, and the role requires it (no exception applies) → decline politely
  const RR = role.rules || {};
  const tzAns = String(newSlots.tongzhao || '');
  const saysNonTz = /非统招|不是统招|自考|成人|函授|网络教育|业余|非全日制|开放大学|^否|^不是/.test(tzAns);
  const workList = candidate.work || (() => { try { return JSON.parse(candidate.work_json || '[]'); } catch { return []; } })();
  const declineTz = RR.requireTongzhao && saysNonTz && !(RR.eduSalesException && eduSalesOf(workList));
  if (declineTz) intent = '投递-不符合';
  let reply = ai?.reply && !declineTz ? String(ai.reply) : '';
  let action = null, slot = null, handoff = false, handoffWhy = null, stateChange = null;

  if (intent === '投递-不符合') {
    reply = reply || pick(['你好，谢谢你的投递和关注。这个岗位目前和你的情况不太匹配，这次先不安排面试了，祝你早日找到合适的工作。', '谢谢你投递我们学校。综合看了下，这个岗位暂时和你的背景不太契合，先不打扰了，祝求职顺利。']);
    stateChange = { attend: '不合适' };
  } else if (intent === '投递-符合') {
    reply = reply || pick([`你好，谢谢投递！简历我看了，挺合适的。想先了解下，你现在是在职还是已经离职了？`, `你好呀，收到你的简历了，背景挺符合我们要求的。方便说下你现在是在职状态吗？`]);
  } else if (intent === '投递-待确认') {
    reply = reply || '你好，谢谢投递！想先了解下，你现在是在职还是已经离职了？';
  } else if (intent === '约面时间' || (intent === '提供信息' && newSlots.half)) {
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
      reply = pick(['这几天面试名额排满了，我看看还能不能加个时间，晚点回你。', '最近几天的面试都约满了，我协调一下其他时间再告诉你。']);
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
    reply = reply || '薪资是按经验定级的，具体能到多少我核实一下再跟你细说。';
  } else if (intent === '要求真人') {
    // “你是机器人吗” → answer honestly; only an explicit ask for a person hands off
    if (/真人|人工|转.*老师|找.*(老师|负责人|领导)/.test(lastText)) { handoff = true; handoffWhy = '候选人要求真人'; reply = reply || '好的，稍等，我安排负责老师直接跟你聊。'; }
    else reply = reply || `是的，我是${org.persona}，你想跟负责老师直接聊的话我随时帮你转。`;
  }

  // ---- topic, “don't know”, same question asked again ----
  const topic = TOPICS.includes(ai?.topic) ? ai.topic : guessTopic(query);
  if (ai?.unknown === true && !handoff) { handoff = true; handoffWhy = `学校资料里没有答案（${topic}），需要你补充或回复`; }
  let asked = 1;
  if (['提问', '议价'].includes(intent)) {
    asked = askCount(unanswered.length ? unanswered : [lastText], topic, ctx.earlierQuestions || [], ai?.askedBefore === true);
    const limit = settings.autoReply?.repeatLimit ?? 2;
    if (asked >= limit) {
      handoff = true; handoffWhy = `同一问题（${topic}）候选人问了第 ${asked} 遍，需要你本人回复`;
    }
  }
  if (!reply && /在哪|地址|地点|位置/.test(lastText)) {
    const k = kb.find(x => /地点|地址/.test(x.q));
    if (k) reply = `${k.a}${toAsk[0] ? `方便说下，你${toAsk[0]}？` : ''}`;
  }
  // no AI: ask the next basic question that is still unknown
  const nextQ = toAsk[0] ? `方便说下，你${toAsk[0]}？` : null;
  if (!reply) reply = nextQ ? `收到。${nextQ}` : `收到。${offerTxt ? `方便来学校初试吗？${offerTxt}都可以。` : '方便的话约个时间来学校初试？'}`;

  // ---- ask for the attachment resume (once; the extension then clicks the platform's own button) ----
  const resumeAsk = resumeOpen && !handoff && !declineTz && verdict !== '不推荐'
    && !['拒绝', '议价', '要求真人', '投递-不符合', '改期'].includes(intent)
    && (ai?.askResume === true || (!ai && rounds >= 1 && ['提供信息', '约面时间', '确认参加', '提问', '其他', '投递-符合', '投递-待确认'].includes(intent)));
  if (resumeAsk && !/简历/.test(reply)) reply = `${reply.replace(/[。！!]?$/, '。')}方便的话发份附件简历给我，我先给面试官看看。`;

  // ---- checks ----
  const kbText = kb.map(k => k.a).join(' ') + ' ' + docText + ' ' + (ctx.offer || []).map(o => `${o.date.slice(5)} ${o.slot}`).join(' ') + ' ' + [...sched.am, ...sched.pm].join(' ') + (slot ? ` ${slot.slot} ${slot.date.slice(5)}` : '') + (appt ? ` ${appt.slot} ${appt.date.slice(5)}` : '');
  const allowed = (kbText.match(/\d+(?:[.:：]\d+)?/g) || []).map(n => n.replace('：', ':'));
  const risk = riskCheck(reply);
  const badNums = numbersOutsideKb(reply, allowed);
  const guardHits = [...risk.guard, ...(badNums.length ? [`数字不在知识库：${badNums.join('、')}`] : [])];
  const blocked = guardHits.length > 0 || risk.platform.length > 0;
  if (blocked) { handoff = true; handoffWhy = handoffWhy || '回复未通过检查'; }

  reply = clip(reply, 200);
  return {
    intent, topic, asked, reply, parts: splitHuman(reply), slots: newSlots, action, slot, byAi: !!ai, aiError: ai ? null : clip(err || '', 160), declineTz, resumeAsk,
    sources: passages.map(p => ({ title: p.title, text: clip(p.text, 80) })),
    checks: { guard: guardHits, platform: risk.platform }, blocked,
    handoff, handoffWhy, stateChange, model: model || (err ? `规则回退（${clip(err, 80)}）` : '规则回退（未配置 AI）'),
  };
}
