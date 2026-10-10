// Interview slot booking. AI books only an arrival slot; the front desk assigns
// an interviewer on the day, based on who is free at that moment.
import { todayCN, addDays, weekday, toMin, nowCN } from './util.js';
import { getSetting, addEvent } from './db.js';

export function workDays(sched, from = todayCN(), n = sched.days) {
  const out = [];
  let d = from;
  while (out.length < n) {
    const w = weekday(d);
    if (!sched.weekdaysOnly || (w !== 0 && w !== 6)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

export function slotsOf(sched, half) {
  return half === 'am' ? sched.am : half === 'pm' ? sched.pm : [...sched.am, ...sched.pm];
}

const ACTIVE = "status IN ('待确认','确认参加')";

export function countAt(db, date, slot) {
  return db.prepare(`SELECT COUNT(*) n FROM appointments WHERE date=? AND slot=? AND ${ACTIVE}`).get(date, slot).n;
}

/** First free slot from `fromDate` (default tomorrow) matching am/pm preference. */
export function findSlot(db, { half = 'any', fromDate = null } = {}) {
  const sched = getSetting(db, 'schedule');
  const start = fromDate && fromDate > todayCN() ? fromDate : addDays(todayCN(), 1);
  for (const d of workDays(sched, start, 10)) {
    for (const sl of slotsOf(sched, half)) {
      if (countAt(db, d, sl) < sched.cap) return { date: d, slot: sl };
    }
  }
  return null;
}

/** Create (or replace) the candidate's active appointment. */
export function book(db, candidateId, date, slot, status = '待确认') {
  db.prepare(`UPDATE appointments SET status='已取消' WHERE candidate_id=? AND ${ACTIVE}`).run(candidateId);
  db.prepare('INSERT INTO appointments(candidate_id,date,slot,status,created_at) VALUES(?,?,?,?,?)').run(candidateId, date, slot, status, nowCN());
  db.prepare("UPDATE candidates SET attend=?, updated_at=? WHERE id=?").run(status, nowCN(), candidateId);
  addEvent(db, candidateId, `约到场时间 ${date} ${slot}（${status}）`);
}

export function activeAppt(db, candidateId) {
  return db.prepare(`SELECT * FROM appointments WHERE candidate_id=? AND status IN ('待确认','确认参加','改期中') ORDER BY id DESC LIMIT 1`).get(candidateId);
}

/** Place every 待排程 candidate. Returns {placed:[], manual:[]} */
export function autoSchedule(db) {
  const list = db.prepare("SELECT * FROM candidates WHERE attend='待排程' ORDER BY score DESC").all();
  const placed = [], manual = [];
  for (const c of list) {
    const pref = c.pref_json ? JSON.parse(c.pref_json) : {};
    if (pref.half === 'none') { manual.push({ id: c.id, name: c.name, why: pref.note || '候选人时间特殊，需人工协调' }); continue; }
    const r = findSlot(db, { half: pref.half || 'any', fromDate: pref.date || null });
    if (!r) { manual.push({ id: c.id, name: c.name, why: '未来可约时段已满' }); continue; }
    book(db, c.id, r.date, r.slot, '待确认');
    db.prepare('UPDATE candidates SET last_note=? WHERE id=?').run(`AI 已约 ${r.date} ${r.slot} 到场，需在招聘平台发面试邀请并等候选人确认。`, c.id);
    placed.push({ id: c.id, name: c.name, ...r });
  }
  return { placed, manual };
}

export function interviewerStatus(db, date = todayCN()) {
  const ivs = db.prepare('SELECT * FROM interviewers WHERE active=1 ORDER BY sort,id').all();
  return ivs.map(iv => {
    const busy = db.prepare(`SELECT a.id, c.name FROM appointments a JOIN candidates c ON c.id=a.candidate_id
      WHERE a.interviewer_id=? AND a.desk='已分配' AND a.date=? ORDER BY a.assigned_at DESC LIMIT 1`).get(iv.id, date);
    const n = db.prepare(`SELECT COUNT(*) n FROM appointments WHERE interviewer_id=? AND date=? AND desk IN ('已分配','已结束')`).get(iv.id, date).n;
    return { id: iv.id, name: iv.name, busyWith: busy ? busy.name : null, apptId: busy ? busy.id : null, today: n };
  });
}

export const halfOf = slot => (toMin(slot) < 720 ? 'am' : 'pm');
