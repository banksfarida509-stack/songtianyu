// Small shared helpers: China-time dates, JSON helpers, ids.
import crypto from 'node:crypto';

const TZ = 'Asia/Shanghai';

/** YYYY-MM-DD in China time */
export function todayCN(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('sv-SE', { timeZone: TZ });
}

/** ISO-like local timestamp "YYYY-MM-DD HH:MM:SS" in China time */
export function nowCN() {
  return new Date().toLocaleString('sv-SE', { timeZone: TZ });
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
}

export const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function j(v, fallback = null) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

export function s(v) {
  return JSON.stringify(v ?? null);
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function clip(str, n) {
  str = String(str ?? '');
  return str.length > n ? str.slice(0, n) : str;
}
