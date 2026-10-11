// Knowledge base made of documents. Documents are split into passages; for each
// candidate message only the most relevant passages go into the prompt, so the
// knowledge base can grow to many documents without overflowing the model.
import { chat, parseJson, llmConfigured } from './llm.js';
import { clip, nowCN } from './util.js';

const CHUNK = 420;

// topic → extra words, so “几点下班” also finds the 作息 passage
export const TOPIC_WORDS = {
  薪资: '工资 薪资 薪酬 底薪 课时费 绩效 收入 月薪 年薪 奖金 提成',
  待遇福利: '待遇 福利 五险一金 社保 公积金 住宿 宿舍 食堂 午餐 餐补 交通 假期 寒暑假 带薪 体检',
  作息时间: '作息 上班 下班 几点 坐班 早自习 晚自习 周末 双休 单休 加班 值班 课时 课量 寒暑假',
  地点: '地点 地址 校区 位置 交通 本部',
  岗位要求: '要求 条件 学历 资格证 经验 专业 年级 科目',
  面试安排: '面试 初试 复试 试讲 流程 时间 带什么',
  学校情况: '学校 介绍 规模 学生 班级 办学 民办 公办 升学',
  入职发展: '入职 培训 晋升 发展 编制 合同 试用期 转正',
};
export const TOPICS = [...Object.keys(TOPIC_WORDS), '资格证', '到岗', '其他'];

function grams(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const seg of t.split(/[^\p{Script=Han}a-z0-9]+/u)) {
    if (!seg) continue;
    if (/^[a-z0-9]+$/.test(seg)) { if (seg.length > 1) out.add(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
    if (seg.length === 1) out.add(seg);
  }
  return out;
}

/** Split a document into passages of about CHUNK characters along paragraph lines. */
export function chunkText(title, content) {
  const paras = String(content || '').replace(/\r/g, '').split(/\n\s*\n|\n(?=【|#|\d+[.、]|[一二三四五六七八九十]+、|问[:：])/).map(x => x.trim()).filter(Boolean);
  const out = []; let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > CHUNK) {
      push();
      for (let i = 0; i < p.length; i += CHUNK) out.push(p.slice(i, i + CHUNK));
      continue;
    }
    if (cur.length + p.length > CHUNK) push();
    cur += (cur ? '\n' : '') + p;
  }
  push();
  return out.map((text, i) => ({ title, i, text }));
}

let cache = { key: '', chunks: [], df: new Map() };
function index(db) {
  const meta = db.prepare('SELECT COUNT(*) n, MAX(updated_at) u, SUM(length(content)) l FROM kb_docs WHERE enabled=1').get();
  const key = `${meta.n}|${meta.u}|${meta.l}`;
  if (cache.key === key) return cache;
  const chunks = [];
  for (const d of db.prepare('SELECT id,title,content FROM kb_docs WHERE enabled=1 ORDER BY id').all()) {
    for (const c of chunkText(d.title, d.content)) chunks.push({ ...c, docId: d.id, g: grams(c.title + ' ' + c.text) });
  }
  const df = new Map();
  for (const c of chunks) for (const g of c.g) df.set(g, (df.get(g) || 0) + 1);
  cache = { key, chunks, df };
  return cache;
}

/** Most relevant passages for a query (candidate messages + topic). */
export function retrieve(db, query, { topic, limit = 6, maxChars = 3200 } = {}) {
  const { chunks, df } = index(db);
  if (!chunks.length) return [];
  const q = grams(`${query} ${topic && TOPIC_WORDS[topic] ? TOPIC_WORDS[topic] : ''}`);
  const N = chunks.length;
  const scored = chunks.map(c => {
    let sc = 0;
    for (const g of q) if (c.g.has(g)) sc += Math.log(1 + N / (df.get(g) || 1));
    return { c, sc };
  }).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
  const out = []; let len = 0;
  for (const { c, sc } of scored) {
    if (out.length >= limit || len + c.text.length > maxChars) break;
    out.push({ docId: c.docId, title: c.title, text: c.text, score: Math.round(sc * 10) / 10 });
    len += c.text.length;
  }
  return out;
}

export function kbStats(db) {
  const r = db.prepare('SELECT COUNT(*) n, SUM(enabled) on_, SUM(length(content)) chars FROM kb_docs').get();
  return { docs: r.n, enabled: r.on_ || 0, chars: r.chars || 0, passages: index(db).chunks.length };
}

/**
 * Learn from past chats: candidate questions + what was answered, grouped by
 * topic. Produces draft Q&A for the recruiter to review; nothing is published
 * to the knowledge base until they click 加入知识库.
 */
export async function learnFromChats(db, ai) {
  const rows = db.prepare(`SELECT m.candidate_id cid, m.id, m.dir, m.by, m.text FROM messages m JOIN candidates c ON c.id=m.candidate_id
    WHERE c.is_demo=0 ORDER BY m.candidate_id, m.id`).all();
  // pair each candidate message with the next reply in the same conversation
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    if (m.dir !== 'in' || m.text.length < 3) continue;
    const nx = rows.slice(i + 1, i + 4).find(x => x.cid === m.cid && x.dir === 'out');
    pairs.push({ q: clip(m.text, 120), a: nx ? clip(nx.text, 160) : '' });
  }
  const convs = new Set(rows.map(r => r.cid)).size;
  if (!pairs.length) return { ok: false, error: '还没有历史约聊记录。请先在智联聊天页的插件面板点“采集历史约聊”。', conversations: convs, questions: 0 };
  if (!llmConfigured() || !ai.enabled) return { ok: false, error: 'AI 未配置，无法分析', conversations: convs, questions: pairs.length };
  const sample = pairs.slice(-260);
  const sys = `你在帮一所学校的招聘负责人整理教师岗位候选人的常见问题。下面是历史聊天里“候选人的问题 → 当时的回复”。
请按主题归纳候选人最关心的问题，重点关注：薪资、待遇福利、作息时间，其次是地点、岗位要求、面试安排、学校情况、入职发展等。
对每个主题：统计大约被问了多少次；列出 2–4 个典型问法；根据“当时的回复”整理一段标准答案（只用回复里出现过的事实，不要编造；回复里没有的写“（待补充：……）”）。
只输出 JSON 数组：[{"topic":"薪资","count":12,"examples":["..."],"answer":"...","gaps":"还缺哪些信息"}]，按 count 从高到低。`;
  const user = sample.map((p, i) => `${i + 1}. 问：${p.q}\n   答：${p.a || '（未回复）'}`).join('\n');
  const r = await chat(ai, [{ role: 'system', content: sys }, { role: 'user', content: clip(user, 24000) }], { maxTokens: 2500, temperature: 0.2 });
  const arr = parseJson(r.content);
  const topics = (Array.isArray(arr) ? arr : []).filter(x => x && x.topic).slice(0, 15).map(x => ({
    topic: clip(x.topic, 20), count: Number(x.count) || 0, examples: (x.examples || []).slice(0, 4).map(e => clip(e, 60)),
    answer: clip(x.answer, 600), gaps: clip(x.gaps, 200),
  }));
  return { ok: true, at: nowCN(), model: r.model, conversations: convs, questions: pairs.length, topics };
}
