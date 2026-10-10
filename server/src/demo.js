// Sample data for first-run acceptance. Every row is flagged is_demo=1 and the
// admin can remove all of it with one click (设置 → 清空示例数据).
import { screen } from './rules.js';
import { getSetting, addEvent } from './db.js';
import { todayCN, nowCN, s } from './util.js';
import { workDays } from './schedule.js';

const P = [
  ['孙女士', 25, '硕士', '陕西师范大学', '211', '学科教学（数学）', '1年', [['2025.07-至今', '某外国语学校', '初一数学教师']], ['初级中学教师资格证（数学）']],
  ['刘先生', 27, '本科', '东北师范大学', '211', '物理学', '3年', [['2023.07-至今', '某县第一中学', '高一物理教师']], ['高级中学教师资格证（物理）']],
  ['何女士', 26, '硕士', '辽宁大学', '', '英语', '2年', [['2024.07-至今', '某实验中学', '初中英语教师']], ['初级中学教师资格证（英语）']],
  ['陈先生', 31, '硕士', '华中师范大学', '211', '生物学', '3年', [['2020.09-2023.06', '华中师范大学', '助教（生物实验）']], []],
  ['马女士', 26, '本科', '沈阳师范大学', '', '数学与应用数学', '2年', [['2024.07-至今', '某民办初中', '初一数学教师']], ['初级中学教师资格证（数学）']],
  ['黄先生', 28, '本科', '渤海大学', '', '数学与应用数学', '4年', [['2022.07-至今', '某公办初中', '初二数学教师']], ['初级中学教师资格证（数学）']],
  ['杨女士', 25, '硕士', '东北师范大学', '211', '学科教学（物理）', '应届', [['2025.09-2026.01', '某省重点高中', '物理教师（实习）']], []],
  ['周先生', 29, '本科', '沈阳理工大学', '', '化学工程与工艺', '2年', [['2023.03-2025.06', '某教育培训机构', '初中化学辅导']], ['初级中学教师资格证（化学）']],
  ['吴女士', 24, '本科', '辽宁师范大学', '', '数学与应用数学', '应届', [['2025.09-2026.01', '某初级中学', '数学教师（实习）']], []],
  ['赵女士', 38, '硕士', '辽宁大学', '', '化学', '10年', [['2016.09-至今', '某培训学校', '化学教研组长']], []],
  ['王女士', 23, '本科', '鞍山师范学院', '', '市场营销', '1年', [['2024.07-2024.12', '某房产公司', '房产销售']], []],
  ['郑先生', 33, '大专', '某职业技术学院', '', '物理教育', '9年', [['2017.07-至今', '某托管机构', '物理辅导']], []],
];
// [index, attend, apptDayOffset(0=first workday) or null, slot, desk interviewer index or null, note]
const PLAN = [
  [0, '确认参加', 0, '09:00', null, '已确认，会带教师资格证原件。'],
  [1, '确认参加', 0, '09:00', null, '确认参加，询问了试讲课题。'],
  [2, '确认参加', 0, '09:30', null, '确认参加。'],
  [4, '待确认', 0, '13:00', null, '邀约已发，等候选人确认。'],
  [5, '确认参加', 1, '09:30', null, '确认参加。'],
  [3, '待排程', null, null, null, '愿意来，上午有空。', { half: 'am' }],
  [6, '待排程', null, null, null, '愿意来，下午方便。', { half: 'pm' }],
  [8, '沟通中', null, null, null, 'AI 在聊：正在了解资格证和可面试时间。'],
  [7, '沟通中', null, null, null, '只有培训机构经历，等专员确认。'],
];

export function seedDemo(db) {
  const rules = getSetting(db, 'rules');
  const sched = getSetting(db, 'schedule');
  const days = workDays(sched, todayCN(), sched.days);
  const ivs = db.prepare('SELECT id FROM interviewers WHERE active=1 ORDER BY sort,id').all();
  const now = nowCN();
  const ids = [];
  P.forEach((p, i) => {
    const [name, age, edu, school, tag, major, years, work, certs] = p;
    const n = { uid: `demo-${i + 1}`, name, age, edu, school, school_tag: tag, major, years,
      work: work.map(([t, org, role]) => ({ t, org, role })), edus: [{ t: '', school, major, deg: edu, tag }], skills: [], certs };
    const sc = screen(n, rules);
    const r = db.prepare(`INSERT OR IGNORE INTO candidates(platform,uid,name,age,edu,school,school_tag,major,years,career_status,expect,job,work_json,edu_json,skills_json,certs_json,self_eval,
      verdict,score,reason,reason_by,rules_json,attend,source,is_demo,created_at,updated_at) VALUES('zhaopin',?,?,?,?,?,?,?,?,'在职-正在找工作','沈阳 · 教师','理科老师',?,?,?,?,'',?,?,?,'rule',?,'未联系','智联 推荐列表（示例）',1,?,?)`)
      .run(n.uid, name, age, edu, school, tag, major, years, s(n.work), s(n.edus), '[]', s(certs), sc.verdict, sc.score, sc.reason, s(sc.rules), now, now);
    const id = r.changes ? Number(r.lastInsertRowid) : db.prepare("SELECT id FROM candidates WHERE platform='zhaopin' AND uid=?").get(n.uid).id;
    ids.push(id);
    if (r.changes) addEvent(db, id, `示例数据：规则初筛 ${sc.verdict} ${sc.score} 分`);
  });
  for (const [i, attend, dOff, slot, ivIdx, note, pref] of PLAN) {
    const id = ids[i];
    db.prepare('UPDATE candidates SET attend=?, last_note=?, pref_json=? WHERE id=?').run(attend, note, s(pref || {}), id);
    if (dOff != null && days[dOff]) {
      const has = db.prepare("SELECT 1 FROM appointments WHERE candidate_id=? AND status IN ('待确认','确认参加')").get(id);
      if (!has) {
        const iv = ivIdx != null && dOff === 0 && ivs[ivIdx] ? ivs[ivIdx].id : null;
        db.prepare(`INSERT INTO appointments(candidate_id,date,slot,status,desk,interviewer_id,assigned_at,created_at) VALUES(?,?,?,?,?,?,?,?)`)
          .run(id, days[dOff], slot, attend === '待确认' ? '待确认' : '确认参加', iv ? '已分配' : '未分配', iv, iv ? now : null, now);
      }
    }
  }
  const w = ids[8];
  if (!db.prepare('SELECT 1 FROM messages WHERE candidate_id=?').get(w)) {
    const m = db.prepare("INSERT INTO messages(candidate_id,dir,by,text,at) VALUES(?,?,?,?,?)");
    m.run(w, 'out', 'ai', '你好，我是 XX 教育的 AI 招聘助理。看到你在找初中数学老师的工作，方便聊几句吗？', now);
    m.run(w, 'in', 'candidate', '你好，请问学校在哪？', now);
    m.run(w, 'out', 'ai', '学校在沈阳，面试统一在学校本部。想先了解一下：你有教师资格证吗？最早什么时候能到岗？', now);
  }
  return { ok: true, candidates: ids.length };
}

export function clearDemo(db) {
  const r = db.prepare('DELETE FROM candidates WHERE is_demo=1').run();
  return { ok: true, removed: Number(r.changes) };
}
