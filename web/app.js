/* AI 招聘副驾 · 管理后台（原生 JS，无构建步骤） */
(function () {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BASE = location.pathname.startsWith('/hr') ? '/hr' : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => el.hidden = true, 2800); }

async function api(path, opt = {}) {
  const r = await fetch(BASE + '/api' + path, {
    method: opt.method || (opt.body ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: opt.body ? { 'Content-Type': 'application/json' } : {},
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  if (r.status === 401 && !path.startsWith('/login')) { S.me = null; renderLogin(); throw new Error('请先登录'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
  return data;
}

const S = { me: null, view: 'home', poolTab: '全部', q: '', vfilter: '全部', schedDate: null, picker: null, drawer: null, dtab: 'resume', chatId: null };
const ATTEND = ['确认参加', '待确认', '待排程', '改期中', '沟通中', '未联系', '不来', '未回复'];
const ACLS = { '确认参加': 't-ok', '待确认': 't-info', '待排程': 't-warn', '改期中': 't-ai', '沟通中': 't-grey', '未联系': 't-grey', '不来': 't-bad', '未回复': 't-grey' };
const ACOL = { '确认参加': 'var(--ok)', '待确认': 'var(--info)', '待排程': 'var(--warn)', '改期中': 'var(--ai)', '沟通中': '#AEB3BB', '未联系': '#D5D8DD', '不来': 'var(--bad)', '未回复': '#E4E6EA' };
const VCLS = { '推荐': 't-ok', '待确认': 't-warn', '不推荐': 't-grey' };
const tagA = a => `<span class="tag ${ACLS[a] || 't-grey'}"><span class="dot"></span>${esc(a)}</span>`;
const tagV = v => v ? `<span class="tag ${VCLS[v] || 't-grey'}">AI ${esc(v)}</span>` : '';
const srcBadge = b => b ? `<span class="badge-src ${b}">${{ ai: 'AI', rule: '规则', staff: '人工' }[b] || b}</span>` : '';
const halfTxt = p => !p || !p.half ? '—' : ({ am: '上午', pm: '下午', any: '全天', none: '需人工' }[p.half] || '—') + (p.date ? ' · ' + p.date.slice(5) : '');
const ph = (t, p, acts = '') => `<div class="ph"><div><h1>${t}</h1>${p ? `<p>${p}</p>` : ''}</div>${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
const loading = '<div class="empty-state">加载中…</div>';

/* ---------------- login ---------------- */
function renderLogin(msg = '') {
  $('#drawer-root').innerHTML = '';
  $('#root').innerHTML = `<div class="login"><form id="lf"><h1><span class="logo">副</span>AI 招聘副驾</h1>
    <label class="fi">用户名<input id="lu" autocomplete="username" value="admin"></label>
    <label class="fi">密码<input id="lp" type="password" autocomplete="current-password"></label>
    <div class="err" id="le">${esc(msg)}</div><button class="btn pri" style="padding:9px">登录</button></form></div>`;
  $('#lp').focus();
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    try { await api('/login', { body: { username: $('#lu').value.trim(), password: $('#lp').value } }); await boot(); }
    catch (er) { $('#le').textContent = er.message; }
  };
}

/* ---------------- shell ---------------- */
const ICON = {
  home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  screen: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  chat: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  pool: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.6c2.4 0 4.2 1.4 4.8 4"/>',
  sched: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.6 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1.1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
};
const VIEWS = [['home', '总览', '工作台'], ['screen', '采集初筛', '招聘流程'], ['chat', 'AI 约聊'], ['pool', '人才池'], ['sched', '面试排程'], ['settings', '设置', '系统']];
function shell() {
  $('#root').innerHTML = `<div class="app"><aside class="nav" id="nav"></aside><div class="content" id="main"></div></div>`;
  $('#nav').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) go(b.dataset.v); });
  renderNav();
}
function renderNav(badges = S.badges || {}) {
  S.badges = badges;
  const nav = $('#nav'); if (!nav) return;
  nav.innerHTML = `<div class="brand"><span class="logo">副</span><div><b>AI 招聘副驾</b><span>教师招聘 · ${esc(S.me?.today || '')}</span></div></div>` +
    VIEWS.map(([k, n, sec]) => `${sec ? `<div class="navsec">${sec}</div>` : ''}<button class="navi" data-v="${k}" ${S.view === k ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24">${ICON[k]}</svg>${n}${badges[k] ? `<span class="cnt">${badges[k]}</span>` : ''}</button>`).join('') +
    `<div class="nav-foot"><span class="ava">${esc((S.me?.user || '?')[0].toUpperCase())}</span><div><b style="font-weight:600">${esc(S.me?.user || '')}</b><div class="muted small"><a href="#" id="logout" style="color:inherit">退出登录</a></div></div></div>`;
  $('#logout').onclick = async e => { e.preventDefault(); await api('/logout', { body: {} }).catch(() => {}); S.me = null; renderLogin(); };
}
function go(v) { S.view = v; location.hash = v; render(); window.scrollTo(0, 0); }
async function render() {
  renderNav();
  const m = $('#main');
  try { await ({ home: vHome, screen: vScreen, chat: vChat, pool: vPool, sched: vSched, settings: vSettings })[S.view](m); }
  catch (e) { if (S.me) m.innerHTML = `<div class="empty-state"><b>加载失败</b>${esc(e.message)}</div>`; }
}

/* ---------------- 总览 ---------------- */
async function vHome(m) {
  m.innerHTML = loading;
  const d = await api('/stats');
  renderNav({ home: d.todo.length || 0, sched: d.pending || 0 });
  const n = a => d.byAttend[a] || 0;
  const kp = [['今日读取', d.screenedToday, '插件从招聘平台读取'], ['今日推荐', d.recommendedToday, 'AI 初筛结论为推荐'], ['人才池', d.total, '全部候选人'],
    ['今日面试', d.todayInterviews, `已分配面试官 ${d.todayAssigned}`, true], ['待排程', d.pending, d.pending ? '可一键 AI 安排' : '没有待排程'], ['插件状态', d.ext ? '在线' : '未连接', d.ext ? `最近 ${d.ext.at.slice(5, 16)}` : '安装插件后显示']];
  const maxDay = Math.max(1, ...d.days.map(x => x.n));
  m.innerHTML = ph('总览', `今天 ${d.today}。AI 在招聘平台读取、初筛、约聊，你只处理下面的事项。${d.llm ? '' : ' <b style="color:var(--bad)">AI 模型未配置，当前使用规则回退。</b>'}`,
    `<button class="btn" data-go="screen">采集初筛</button><button class="btn pri" data-go="sched">今日面试安排</button>`) +
    (d.total === 0 ? `<div class="card" style="margin-bottom:16px"><div class="empty-state"><b>还没有候选人数据</b>在“设置”里下载并安装浏览器插件，打开智联推荐人才页即自动读取初筛；也可以先在“设置 → 示例数据”导入示例看效果。</div></div>` : '') +
    `<div class="kpis">${kp.map(k => `<div class="card kpi ${k[3] ? 'hot' : ''}"><span class="l">${k[0]}</span><span class="v num">${esc(k[1])}</span><span class="s">${esc(k[2])}</span></div>`).join('')}</div>
    <div class="g2">
      <div class="card"><div class="card-h"><h3>需要你处理<span class="sub">${d.todo.length} 件 · 其余由 AI 处理</span></h3></div>
        <div class="card-b todo">${d.todo.length ? d.todo.map(t => `<div class="todo-i"><span class="tag ${{ '待你确认': 't-warn', '转人工': 't-bad', '改期中': 't-ai' }[t.k] || 't-grey'}">${esc(t.k)}</span><div><b>${esc(t.name)}</b><p>${esc(t.d || '')}</p></div><button class="btn sm" data-open="${t.id}">查看</button></div>`).join('') : '<p class="muted small" style="margin:0">没有需要你处理的事项。</p>'}</div></div>
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div class="card"><div class="card-h"><h3>约聊结果<span class="sub">人才池 ${d.total} 人</span></h3><button class="btn ghost sm" data-go="pool">查看人才池 →</button></div>
          <div class="card-b"><div class="stack">${ATTEND.map(a => n(a) ? `<i style="flex:${n(a)};background:${ACOL[a]}"></i>` : '').join('') || '<i style="flex:1;background:var(--grey-bg)"></i>'}</div>
          <div class="legend">${ATTEND.map(a => `<div><span class="dot" style="color:${ACOL[a]}"></span>${a}<span class="n">${n(a)}</span></div>`).join('')}</div></div></div>
        <div class="card"><div class="card-h"><h3>今日面试官状态</h3><button class="btn ghost sm" data-go="sched">去分配 →</button></div>
          <div class="card-b ivlist">${d.interviewers.map(iv => `<div class="ivrow"><b>${esc(iv.name)}</b>${iv.busyWith ? `<span class="tag t-red">面试中 · ${esc(iv.busyWith)}</span>` : '<span class="tag t-ok">空闲</span>'}<span class="muted small num">今日 ${iv.today} 场</span></div>`).join('')}</div></div>
        <div class="card"><div class="card-h"><h3>未来面试人数</h3></div>
          <div class="card-b ivbars">${d.days.map((x, i) => `<div class="ivbar"><span>${x.date.slice(5)} ${x.week}${i === 0 ? ' · 今天' : ''}</span><span class="tr"><i style="width:${x.n / maxDay * 100}%"></i></span><span class="num">${x.n} 人</span></div>`).join('')}</div></div>
      </div></div>`;
  $$('[data-go]', m).forEach(b => b.onclick = () => go(b.dataset.go));
  $$('[data-open]', m).forEach(b => b.onclick = () => openDrawer(+b.dataset.open));
}

/* ---------------- 采集初筛 ---------------- */
async function vScreen(m) {
  m.innerHTML = loading;
  const qs = new URLSearchParams({ order: 'score' });
  if (S.vfilter !== '全部') qs.set('verdict', S.vfilter);
  const [d, st] = await Promise.all([api('/candidates?' + qs), api('/settings')]);
  const vc = d.vcounts || {}, total = Object.values(vc).reduce((a, b) => a + b, 0);
  m.innerHTML = ph('采集初筛', '专员在智联推荐人才页浏览时，插件自动读取整页卡片数据并初筛，结论和理由直接显示在每张卡片上。这里汇总所有读取过的候选人，按分数排序。',
    `<button class="btn" data-go="settings">安装 / 下载插件</button>`) +
    `<div class="card" style="margin-bottom:16px"><div class="card-b" style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;font-size:13px">
      <span>插件：${st.ext ? `<b class="ok-dot">● 在线</b> 最近心跳 ${esc(st.ext.at)}（${esc(st.ext.page || '')}）` : '<b class="bad-dot">● 未连接</b> 请在“设置”下载安装插件'}</span>
      <span>AI 推荐理由：${st.llm ? '<b class="ok-dot">● 已接入学员系统 AI 接口</b>' : '<b class="bad-dot">● 未配置，使用规则理由</b>'}</span></div></div>
    <div class="card"><div class="toolbar"><div class="seg">${['全部', '推荐', '待确认', '不推荐'].map(v => `<button aria-pressed="${S.vfilter === v}" data-vf="${v}">${v}<span class="c">${v === '全部' ? total : vc[v] || 0}</span></button>`).join('')}</div></div>
    <div class="tbl-wrap"><table class="rowc"><thead><tr><th>候选人</th><th>学校 · 专业</th><th>AI 结论</th><th>分数</th><th>推荐理由</th><th>来源</th><th>约聊状态</th></tr></thead><tbody>
    ${d.rows.length ? d.rows.map(c => `<tr data-id="${c.id}"><td><div class="cand"><span class="ava">${esc((c.name || '?')[0])}</span><div><b>${esc(c.name)}${c.isDemo ? '<span class="demo-tag">示例</span>' : ''}</b><span>${c.age ?? '—'}岁 · ${esc(c.edu || '—')} · ${esc(c.years || '')}</span></div></div></td>
      <td>${esc(c.school || '—')}${c.schoolTag ? ` <span class="tag t-red">${esc(c.schoolTag)}</span>` : ''}<div class="muted small">${esc(c.major || '')}</div></td>
      <td>${tagV(c.verdict)}</td><td><span class="score">${c.score ?? '—'}</span></td><td class="latest">${esc(c.reason || '')}${srcBadge(c.reasonBy)}</td>
      <td class="small">${esc(c.source || '')}<div class="muted">${esc((c.createdAt || '').slice(5, 16))}</div></td><td>${tagA(c.attend)}</td></tr>`).join('')
      : `<tr><td colspan="7"><div class="empty-state"><b>还没有读取到候选人</b>安装插件后打开智联“推荐”页，即自动读取初筛。</div></td></tr>`}
    </tbody></table></div></div>`;
  $$('[data-go]', m).forEach(b => b.onclick = () => go(b.dataset.go));
  $$('[data-vf]', m).forEach(b => b.onclick = () => { S.vfilter = b.dataset.vf; vScreen(m); });
  $$('tbody tr[data-id]', m).forEach(r => r.onclick = () => openDrawer(+r.dataset.id));
}

/* ---------------- 人才池 ---------------- */
async function vPool(m) {
  if (!m.querySelector('#poolwrap')) m.innerHTML = loading;
  const qs = new URLSearchParams();
  if (S.poolTab !== '全部') qs.set('attend', S.poolTab);
  if (S.q.trim()) qs.set('q', S.q.trim());
  const d = await api('/candidates?' + qs);
  const counts = d.counts || {}, total = Object.values(counts).reduce((a, b) => a + b, 0);
  const order = c => ATTEND.indexOf(c.attend);
  const rows = d.rows.sort((a, b) => order(a) - order(b) || (a.appt && b.appt ? (a.appt.date + a.appt.slot).localeCompare(b.appt.date + b.appt.slot) : 0) || (b.score || 0) - (a.score || 0));
  const when = c => {
    if (c.appt) return `<div class="when"><b>${esc(c.appt.date.slice(5))} ${esc(c.appt.slot)}</b><span>${c.appt.interviewer ? `${c.appt.desk === '已结束' ? '已面试' : '已分配'} · ${esc(c.appt.interviewer)}` : c.appt.desk === '未到' ? '未到场' : '到场后前台分配'}</span></div>`;
    if (['待排程', '改期中'].includes(c.attend)) return `<div class="when"><span>偏好：${halfTxt(c.pref)}</span></div>`;
    return '<span class="muted">—</span>';
  };
  m.innerHTML = `<div id="poolwrap">` + ph('人才池', '按约聊结果管理：来不来、什么时间到场、由哪位面试官面试。点任意一行查看详细简历和约聊记录。') +
    `<div class="card"><div class="toolbar"><div class="seg">${['全部', ...ATTEND].map(t => `<button aria-pressed="${S.poolTab === t}" data-t="${t}">${t}<span class="c">${t === '全部' ? total : counts[t] || 0}</span></button>`).join('')}</div>
      <input class="search" id="q" placeholder="搜索姓名、学校、专业、岗位" value="${esc(S.q)}"></div>
    <div class="tbl-wrap"><table class="rowc"><thead><tr><th>候选人</th><th>岗位</th><th>初筛</th><th>来不来</th><th>面试安排</th><th>最新进展</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(c => `<tr data-id="${c.id}"><td><div class="cand"><span class="ava">${esc((c.name || '?')[0])}</span><div><b>${esc(c.name)}${c.isDemo ? '<span class="demo-tag">示例</span>' : ''}${c.handoff ? ' <span class="tag t-bad">转人工</span>' : ''}</b><span>${c.age ?? '—'}岁 · ${esc(c.edu || '—')} · ${esc(c.school || '')}</span></div></div></td>
      <td>${esc(c.job || '—')}<div class="muted small">${esc(c.source || '')}</div></td><td>${tagV(c.verdict)} <span class="score">${c.score ?? ''}</span></td><td>${tagA(c.attend)}</td><td>${when(c)}</td><td class="latest">${esc(c.lastNote || '')}</td><td><button class="btn sm">简历</button></td></tr>`).join('')
      : '<tr><td colspan="7"><div class="empty-state">没有符合条件的候选人</div></td></tr>'}</tbody></table></div></div></div>`;
  $$('[data-t]', m).forEach(b => b.onclick = () => { S.poolTab = b.dataset.t; vPool(m); });
  const q = $('#q', m);
  q.oninput = () => { S.q = q.value; clearTimeout(vPool._t); vPool._t = setTimeout(async () => { const pos = q.selectionStart; await vPool(m); const i = $('#q', m); i.focus(); i.setSelectionRange(pos, pos); }, 300); };
  $$('tbody tr[data-id]', m).forEach(r => r.onclick = () => openDrawer(+r.dataset.id));
}

/* ---------------- 详情抽屉 ---------------- */
async function openDrawer(id, tab) { S.drawer = id; S.dtab = tab || S.dtab || 'resume'; await renderDrawer(); }
async function renderDrawer() {
  const root = $('#drawer-root');
  if (!S.drawer) { root.innerHTML = ''; return; }
  const [c, sch] = await Promise.all([api('/candidates/' + S.drawer), api('/schedule')]);
  const a = c.appt;
  const slotsAll = [...sch.sched.am, ...sch.sched.pm];
  const memo = [['来不来', tagA(c.attend)], ['面试时间', a ? `${esc(a.date)} ${esc(a.slot)}（${esc(a.status)}）` : esc(halfTxt(c.pref))], ['面试官', a?.interviewer ? `${esc(a.interviewer)}（${esc(a.desk)}）` : a ? '到场后由前台按空闲分配' : '—'],
    ['面试地点', esc(sch.place)], ['教师资格证', esc(c.slots.cert || (c.certs || []).join('、') || '未知')], ['最早到岗', esc(c.slots.arrive || '未知')], ['转人工', c.handoff ? '是' : '否']];
  root.innerHTML = `<div class="scrim" id="scrim"></div><aside class="drawer" role="dialog" aria-label="${esc(c.name)} 详情">
    <div class="dh"><div class="dh-top"><span class="ava">${esc((c.name || '?')[0])}</span><div><h2>${esc(c.name)} ${tagA(c.attend)}</h2>
      <div class="meta">${c.age ?? '—'}岁 · ${esc(c.edu || '—')} · ${esc(c.years || '')} · ${esc(c.careerStatus || '')}</div><div class="muted small">岗位 ${esc(c.job || '—')} · 来源 ${esc(c.source || '')}</div></div><button class="x" id="dx" aria-label="关闭">✕</button></div>
      <div class="dh-sum"><div>面试安排<b>${a ? `${esc(a.date.slice(5))} ${esc(a.slot)}${a.interviewer ? ' · ' + esc(a.interviewer) : ''}` : esc(halfTxt(c.pref))}</b></div><div>初筛<b><span class="score">${c.score ?? '—'}</span> 分 · ${esc(c.verdict || '')}</b></div><div>推荐理由<b style="font-size:12.5px;font-weight:500">${esc(c.reason || '')}</b></div></div>
      <div class="dtabs" role="tablist">${[['resume', '详细简历'], ['chat', '约聊记录'], ['tl', '时间线'], ['act', '操作']].map(([k, n]) => `<button role="tab" aria-selected="${S.dtab === k}" data-dt="${k}">${n}</button>`).join('')}</div></div>
    <div class="db">${S.dtab === 'resume' ? `
      <div class="rs"><h4>求职意向</h4><div class="ri"><span class="t">期望</span><span>${esc(c.expect || '—')}</span></div></div>
      <div class="rs"><h4>工作经历</h4>${(c.work || []).length ? c.work.map(w => `<div class="ri"><span class="t">${esc(w.t)}</span><div><b>${esc(w.org)}</b> · ${esc(w.role)}</div></div>`).join('') : '<p class="muted small">无</p>'}</div>
      <div class="rs"><h4>教育经历</h4>${(c.edus || []).length ? c.edus.map(e => `<div class="ri"><span class="t">${esc(e.t)}</span><div><b>${esc(e.school)}</b>${e.tag ? ` <span class="tag t-red">${esc(e.tag)}</span>` : ''} · ${esc(e.major)} · ${esc(e.deg)}</div></div>`).join('') : '<p class="muted small">无</p>'}</div>
      <div class="rs"><h4>资格证书</h4><p style="margin:0;font-size:13px">${esc((c.certs || []).join('、') || '列表页未提供，约聊中追问')}</p></div>
      ${(c.skills || []).length ? `<div class="rs"><h4>技能标签</h4><div class="chips">${c.skills.map(x => `<span class="tag t-grey">${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${c.selfEval ? `<div class="rs"><h4>自我评价</h4><p style="margin:0;font-size:13px;color:var(--ink2)">${esc(c.selfEval)}</p></div>` : ''}
      <div class="rs"><h4>初筛证据</h4>${(c.rules || []).map(r => `<div class="rule"><span class="ic ${r.ok === true ? 'p' : r.ok === false ? 'f' : 'u'}">${r.ok === true ? '✓' : r.ok === false ? '✕' : '?'}</span><span>${esc(r.id)} ${esc(r.name)}<br><span class="ev">证据：${esc(r.ev)}</span></span></div>`).join('') || '<p class="muted small">无</p>'}</div>
      <p class="muted small">简历字段来自招聘平台页面数据，照片和联系方式不入库。</p>`
    : S.dtab === 'chat' ? `<div class="rs"><h4>AI 初聊纪要</h4><dl class="memo">${memo.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
      <div class="rs"><h4>对话记录</h4>${(c.messages || []).length ? c.messages.map(x => `<div class="bub ${x.dir === 'out' ? 'me' : ''}"><span class="mini-tag">${{ candidate: '候选人', ai: 'AI', staff: '专员' }[x.by] || ''} · ${esc((x.at || '').slice(5, 16))}</span><br>${esc(x.text)}</div>`).join('') : '<p class="muted small">还没有对话记录。</p>'}</div>`
    : S.dtab === 'tl' ? `<div class="rs"><h4>时间线</h4><div class="tl">${(c.events || []).map(x => `<div><span class="t">${esc(x.at.slice(5, 16))}</span><i></i><span>${esc(x.text)}</span></div>`).join('') || '<p class="muted small">无</p>'}</div></div>`
    : `<div class="rs"><h4>修改约聊结果</h4><div class="inline-form"><select class="inp" id="d-att">${ATTEND.map(x => `<option ${x === c.attend ? 'selected' : ''}>${x}</option>`).join('')}</select><button class="btn sm pri" id="d-att-save">保存</button></div></div>
      <div class="rs"><h4>安排到场时间</h4><div class="inline-form"><select class="inp" id="d-date">${sch.days.map(x => `<option value="${x.date}">${x.date.slice(5)} ${x.week}（${x.n} 人）</option>`).join('')}</select>
        <select class="inp" id="d-slot">${slotsAll.map(x => `<option>${x}</option>`).join('')}</select><button class="btn sm pri" id="d-book">约定</button></div>
        <div class="inline-form"><span class="small muted">或交给 AI 排：偏好</span><select class="inp" id="d-half"><option value="am">上午</option><option value="pm">下午</option><option value="any" selected>全天</option><option value="none">需人工</option></select><button class="btn sm" id="d-pend">设为待排程</button></div></div>
      <div class="rs"><h4>改判</h4><div class="inline-form"><select class="inp" id="d-v">${['推荐', '待确认', '不推荐'].map(x => `<option ${x === c.verdict ? 'selected' : ''}>${x}</option>`).join('')}</select><input class="inp" id="d-vr" placeholder="改判原因（必填）" style="flex:1;min-width:160px"><button class="btn sm" id="d-vs">改判</button></div></div>
      ${c.handoff ? `<div class="rs"><h4>转人工</h4><button class="btn sm" id="d-ho">已处理，交还 AI</button></div>` : ''}`}
    </div></aside>`;
  $('#scrim').onclick = $('#dx').onclick = () => { S.drawer = null; renderDrawer(); };
  $$('[data-dt]', root).forEach(b => b.onclick = () => { S.dtab = b.dataset.dt; renderDrawer(); });
  const after = async msg => { toast(msg); await renderDrawer(); render(); };
  if ($('#d-att-save')) $('#d-att-save').onclick = async () => { await api(`/candidates/${c.id}`, { method: 'PATCH', body: { attend: $('#d-att').value } }); after('已保存'); };
  if ($('#d-book')) $('#d-book').onclick = async () => { await api('/appointments', { body: { candidateId: c.id, date: $('#d-date').value, slot: $('#d-slot').value } }); after('已约定到场时间，记得在招聘平台发面试邀请'); };
  if ($('#d-pend')) $('#d-pend').onclick = async () => { await api(`/candidates/${c.id}`, { method: 'PATCH', body: { attend: '待排程', pref: { half: $('#d-half').value } } }); after('已设为待排程'); };
  if ($('#d-vs')) $('#d-vs').onclick = async () => { const r = $('#d-vr').value.trim(); if (!r) return toast('请填写改判原因'); await api(`/candidates/${c.id}`, { method: 'PATCH', body: { verdict: $('#d-v').value, reason: r } }); after('已改判'); };
  if ($('#d-ho')) $('#d-ho').onclick = async () => { await api(`/candidates/${c.id}`, { method: 'PATCH', body: { handoff: false } }); after('已交还 AI'); };
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.drawer) { S.drawer = null; renderDrawer(); } });

/* ---------------- AI 约聊 ---------------- */
async function vChat(m) {
  m.innerHTML = loading;
  const d = await api('/candidates');
  const list = d.rows.filter(c => ['沟通中', '待排程', '待确认', '确认参加', '改期中'].includes(c.attend) || c.handoff).slice(0, 80);
  if (!S.chatId || !list.find(c => c.id === S.chatId)) S.chatId = list[0]?.id || null;
  const c = S.chatId ? await api('/candidates/' + S.chatId) : null;
  m.innerHTML = ph('AI 约聊', '正式使用时，插件在智联聊天页读取实时消息并生成回复草稿，专员确认后发送；约聊结果自动写入人才池和面试排程。这里可以查看所有会话，并用“模拟候选人消息”测试 AI 回复。') +
    `<div class="card chat" style="grid-template-columns:250px minmax(0,1fr) 340px">
      <div class="convs">${list.length ? list.map(x => `<button class="conv ${x.id === S.chatId ? 'on' : ''}" data-c="${x.id}"><span class="r"><b>${esc(x.name)}</b>${x.handoff ? '<span class="tag t-bad">转人工</span>' : tagA(x.attend)}</span><p>${esc(x.lastNote || x.job || '')}</p></button>`).join('') : '<div class="empty-state">还没有会话</div>'}</div>
      <div class="thread">${c ? `<div class="th-h"><div><b>${esc(c.name)}</b> <span class="muted small">${esc(c.job || '')} · ${esc(c.source || '')}</span> <button class="btn ghost sm" id="ch-res">看简历</button></div>${tagA(c.attend)}</div>
        <div class="msgs" id="msgs">${(c.messages || []).map(x => `<div class="msg ${x.dir === 'out' ? 'me' : ''}"><div class="who">${{ candidate: '候选人', ai: '招聘方（AI）', staff: '招聘方' }[x.by] || ''}</div>${esc(x.text)}</div>`).join('') || '<div class="sys">还没有消息</div>'}</div>
        <div class="sim"><div class="lab">模拟候选人消息（测试 AI，不会发到招聘平台）</div>
          <div class="chat-test"><input class="inp" id="ct" placeholder="例如：明天下午可以去面试 / 工资能保证一万吗？"><button class="btn" id="ct-go">生成建议</button><button class="btn pri" id="ct-apply">生成并采用</button></div>
          <div class="opts">${['有初中数学教师资格证，明年 2 月能到岗', '明天下午可以去面试', '好的，我会准时到', '明天有事，能改个时间吗', '可以加个微信吗', '工资能保证一个月一万吗'].map(t => `<button class="opt" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>` : '<div class="empty-state">选择左侧会话</div>'}</div>
      <aside class="copilot">${c ? `<div class="cp-sec"><h4>已知信息（AI 抽取）</h4><dl class="slots">${[['教师资格证', c.slots.cert], ['最早到岗', c.slots.arrive], ['可面时间', c.slots.half ? halfTxt({ half: c.slots.half, date: c.slots.day }) : null], ['到场安排', c.appt ? `${c.appt.date.slice(5)} ${c.appt.slot}（${c.appt.status}）` : null]].map(([k, v]) => `<dt>${k}</dt><dd class="${v ? '' : 'miss'}">${esc(v || '缺')}</dd>`).join('')}</dl></div>
        <div class="cp-sec" id="draft"><h4>AI 建议</h4><p class="small muted" style="margin:0">输入候选人消息后生成。</p></div>` : ''}
        <div class="cp-sec small muted">发送前两道检查：我方护栏（承诺词、限制性表述、数字必须出自知识库）+ 平台拦截规则（6 位以上数字、公众号、支付转账等）。命中即转人工。</div></aside></div>`;
  $$('[data-c]', m).forEach(b => b.onclick = () => { S.chatId = +b.dataset.c; vChat(m); });
  if (!c) return;
  $('#ch-res').onclick = () => openDrawer(c.id, 'resume');
  const ms = $('#msgs'); ms.scrollTop = ms.scrollHeight;
  const run = async (text, apply) => {
    if (!text) return toast('请输入候选人消息');
    $('#draft').innerHTML = '<h4>AI 建议</h4><p class="typing">AI 正在理解消息、查到场名单…</p>';
    try {
      const r = await api(`/candidates/${c.id}/chat-test`, { body: { text, apply } });
      const dr = r.draft;
      const chk = (ok, n) => `<div><span class="tag ${ok ? 't-ok' : 't-bad'}">${ok ? '通过' : '命中'}</span>${esc(n)}</div>`;
      const dc = r.decision || {};
      const modeTag = { auto: ['t-ok', '全自动'], semi: ['t-warn', '半自动'], human: ['t-bad', '转人工'] }[dc.mode] || ['', ''];
      $('#draft').innerHTML = `<h4>AI 建议 · 分类：${esc(dr.intent)} <span class="mini-tag">（${esc(dr.model)}）</span></h4>
        <div style="margin:0 0 8px"><span class="tag ${modeTag[0]}">${modeTag[1]}</span> <span class="small muted">${esc(dc.why || '')}${dc.mode === 'auto' ? `，插件会在约 ${Math.round(dc.delayMs / 1000)} 秒后自动发送` : ''}</span></div>
        <div class="draft ${dr.blocked ? 'blocked' : ''}">${(dr.parts || [dr.reply]).map(esc).join('<br><span class="small muted">— 分两条发 —</span><br>')}</div>
        <div class="checks">${chk(!dr.checks.guard.length, '我方护栏' + (dr.checks.guard.length ? '：' + dr.checks.guard.join('、') : ''))}${chk(!dr.checks.platform.length, '平台拦截规则' + (dr.checks.platform.length ? '：' + dr.checks.platform.join('、') : ''))}</div>
        ${dr.action ? `<div class="act">建议动作：在平台点「${esc(dr.action)}」${dr.slot ? `（${esc(dr.slot.date)} ${esc(dr.slot.slot)}）` : ''}</div>` : ''}
        ${dr.handoff ? `<div class="act" style="border-color:var(--bad);color:var(--bad)">转人工：${esc(dr.handoffWhy || '')}</div>` : ''}
        <p class="small muted" style="margin:8px 0 0">${apply ? '已采用：消息和状态已写入人才池。' : '仅预览，未写入。'}</p>`;
      if (apply) { await sleep(400); const keep = $('#draft').innerHTML; await vChat(m); $('#draft').innerHTML = keep; }
    } catch (e) { $('#draft').innerHTML = `<h4>AI 建议</h4><p class="err">${esc(e.message)}</p>`; }
  };
  $('#ct-go').onclick = () => run($('#ct').value.trim(), false);
  $('#ct-apply').onclick = () => run($('#ct').value.trim(), true);
  $$('.opt', m).forEach(b => b.onclick = () => { $('#ct').value = b.dataset.t; });
}

/* ---------------- 面试排程 ---------------- */
async function vSched(m) {
  if (!m.querySelector('#schedwrap')) m.innerHTML = loading;
  const d = await api('/schedule' + (S.schedDate ? '?date=' + S.schedDate : ''));
  S.schedDate = d.date;
  renderNav({ ...S.badges, sched: d.pending.filter(p => p.pref.half !== 'none').length });
  const free = d.interviewers.filter(i => !i.busyWith).sort((a, b) => a.today - b.today);
  const card = a => {
    let st;
    if (a.desk === '已结束') st = `<span class="tag t-grey">已结束 · ${esc(a.interviewer)}</span>`;
    else if (a.desk === '已分配') st = `<span class="tag t-red">已分配 · ${esc(a.interviewer)}</span>${d.isToday ? `<button class="btn sm" data-fin="${a.id}">结束</button>` : ''}`;
    else if (a.desk === '未到') st = '<span class="tag t-bad">未到场</span>';
    else st = d.isToday ? `<button class="btn sm pri" data-pick="${a.id}">分配</button><button class="btn sm" data-ns="${a.id}">未到</button>` : '<span class="muted small">到场后由前台分配</span>';
    const pk = S.picker === a.id ? `<div class="picker"><div class="small muted">选择空闲面试官${free[0] ? ` · 建议 <b style="color:var(--accent)">${esc(free[0].name)}</b>（今日 ${free[0].today} 场）` : ''}</div>
      <div class="pk">${d.interviewers.map(i => `<button class="btn sm" ${i.busyWith ? 'disabled title="面试中"' : ''} data-as="${a.id}|${i.id}">${esc(i.name)}${i.busyWith ? ' · 面试中' : ''}</button>`).join('')}</div></div>` : '';
    return `<div class="ac ${a.desk === '已分配' ? 'asg' : a.desk === '已结束' || a.desk === '未到' ? 'done' : ''}"><button class="ac-n" data-res="${a.candidate_id}"><b>${esc(a.name)}</b><span>${esc(a.job || '')} · ${esc(a.edu || '')}</span></button>
      <div class="ac-s">${tagA(a.status)}</div><div class="ac-a">${st}</div>${pk}</div>`;
  };
  const halfBlock = (h, sl) => `<div class="half">${h} <span class="muted small">${sl[0]}–${sl[sl.length - 1]}</span></div>` + sl.map(s => {
    const cs = d.appts.filter(a => a.slot === s);
    return `<div class="trow"><div class="tt"><b class="num">${s}</b><span class="muted small">${cs.length}/${d.sched.cap}</span></div><div class="tcards">${cs.length ? cs.map(card).join('') : '<span class="muted small" style="padding:10px 4px">空档</span>'}</div></div>`;
  }).join('');
  const day = d.days.find(x => x.date === d.date) || { week: '' };
  m.innerHTML = `<div id="schedwrap">` + ph('面试排程', `AI 只约到场时间：上午 ${d.sched.am[0]}–${d.sched.am[d.sched.am.length - 1]}、下午 ${d.sched.pm[0]}–${d.sched.pm[d.sched.pm.length - 1]}，每半小时一档，每档最多 ${d.sched.cap} 人。候选人到场后，前台按面试官空闲情况分配；只有当天可以分配。面试地点：${esc(d.place)}。`,
    `<button class="btn pri" id="auto" ${d.pending.filter(p => p.pref.half !== 'none').length ? '' : 'disabled'}>AI 安排待排程（${d.pending.filter(p => p.pref.half !== 'none').length} 人）</button>`) +
    `<div class="days">${d.days.map((x, i) => `<button class="day ${x.date === d.date ? 'on' : ''}" data-day="${x.date}"><span class="dl">${x.date.slice(5)} ${x.week}${i === 0 && x.date === d.today ? ' · 今天' : ''}</span><b class="num">${x.n}<small> 人</small></b><span class="dm">上午 ${x.am} · 下午 ${x.pm}${x.date === d.today ? ` · 已分配 ${x.assigned}` : ''}</span></button>`).join('')}</div>
    <div class="sched2"><div class="card"><div class="card-h"><h3>${esc(d.date)}（${esc(day.week)}）到场安排<span class="sub">${d.appts.length} 人 · 已确认 ${d.appts.filter(a => a.status === '确认参加').length}</span></h3>
      ${d.isToday ? '<span class="tag t-red">今天 · 前台可分配</span>' : '<span class="tag t-grey">未到当天，只能查看</span>'}</div>
      <div class="tline">${halfBlock('上午', d.sched.am)}${halfBlock('下午', d.sched.pm)}</div></div>
    <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <div class="card"><div class="card-h"><h3>面试官状态<span class="sub">${d.isToday ? '实时' : '当天由前台分配'}</span></h3><button class="btn ghost sm" data-go="settings">管理面试官</button></div>
        <div class="card-b ivlist">${d.interviewers.map(i => `<div class="ivrow"><b>${esc(i.name)}</b>${i.busyWith ? `<span class="tag t-red">面试中 · ${esc(i.busyWith)}</span>` : '<span class="tag t-ok">空闲</span>'}<span class="muted small num">今日 ${i.today} 场</span></div>`).join('')}</div></div>
      <div class="card"><div class="card-h"><h3>待排程<span class="sub">约聊结果“愿意来”</span></h3></div>
        <div class="card-b queue">${d.pending.length ? d.pending.map(p => `<div class="q-i"><div><b>${esc(p.name)}</b> · ${esc(p.job || '')} <span class="score">${p.score ?? ''}</span><br><span>偏好 ${halfTxt(p.pref)}${p.pref.half === 'none' ? ' · <b style="color:var(--bad)">需人工安排</b>' : ''}</span></div><button class="btn sm" data-res="${p.id}">详情</button></div>`).join('') : '<p class="muted small" style="margin:0">没有待排程的候选人。</p>'}</div></div>
    </div></div></div>`;
  $$('[data-day]', m).forEach(b => b.onclick = () => { S.schedDate = b.dataset.day; S.picker = null; vSched(m); });
  $$('[data-res]', m).forEach(b => b.onclick = () => openDrawer(+b.dataset.res, 'chat'));
  $$('[data-go]', m).forEach(b => b.onclick = () => go(b.dataset.go));
  $$('[data-pick]', m).forEach(b => b.onclick = () => { S.picker = S.picker === +b.dataset.pick ? null : +b.dataset.pick; vSched(m); });
  $$('[data-as]', m).forEach(b => b.onclick = async () => {
    const [aid, iid] = b.dataset.as.split('|');
    try { await api(`/appointments/${aid}/assign`, { body: { interviewerId: +iid } }); S.picker = null; toast('已分配'); vSched(m); } catch (e) { toast(e.message); }
  });
  $$('[data-fin]', m).forEach(b => b.onclick = async () => { await api(`/appointments/${b.dataset.fin}/finish`, { body: {} }); toast('面试已结束，面试官已空闲'); vSched(m); });
  $$('[data-ns]', m).forEach(b => b.onclick = async () => { await api(`/appointments/${b.dataset.ns}/noshow`, { body: {} }); toast('已标记未到场'); vSched(m); });
  const au = $('#auto');
  if (au) au.onclick = async () => {
    au.disabled = true; au.textContent = 'AI 安排中…';
    const r = await api('/schedule/auto', { body: {} });
    toast(`已约到时段 ${r.placed.length} 人${r.manual.length ? `，${r.manual.length} 人需人工` : ''}；记得在招聘平台给他们发面试邀请`);
    if (r.placed[0]) S.schedDate = r.placed[0].date;
    vSched(m);
  };
}

/* ---------------- 设置 ---------------- */
async function vSettings(m) {
  m.innerHTML = loading;
  const [st, ivs] = await Promise.all([api('/settings'), api('/interviewers')]);
  const R = st.rules, SC = st.schedule, AI = st.ai, ORG = st.org, AR = st.autoReply;
  const MODES = { auto: '全自动', semi: '半自动', human: '转人工' };
  const AR_CATS = { 提问: '学校在哪？上几节课？', 提供信息: '有初中数学教资，2 月能到岗', 约面时间: '明天下午可以去面试', 确认参加: '好的，我会准时到',
    改期: '明天有事，能改个时间吗', 拒绝: '不考虑了，已经找到了', 议价: '工资能保证一万吗', 要求真人: '我想找真人聊', 交换联系方式: '可以加个微信吗', 其他: '其他消息' };
  m.innerHTML = ph('设置', '插件、AI 模型、初筛规则、面试时段、面试官和知识库。修改后点对应区块的“保存”。') + `
  <div class="g3" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
  <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
    <div class="card"><div class="card-h"><h3>浏览器插件</h3>${st.ext ? `<span class="tag t-ok">在线 · ${esc(st.ext.at.slice(5, 16))}</span>` : '<span class="tag t-grey">未连接</span>'}</div><div class="card-b" style="font-size:13px">
      <ol style="margin:0 0 10px;padding-left:18px;display:flex;flex-direction:column;gap:4px">
        <li>点“下载插件”，解压得到 <b>hr-agent-extension</b> 文件夹（已内置服务器地址和令牌）。</li>
        <li>Chrome 打开 <span class="code">chrome://extensions</span>，右上角打开“开发者模式”，点“加载已解压的扩展程序”，选择该文件夹。</li>
        <li>登录智联企业版，打开“推荐”页：每张卡片下方会出现 AI 结论和理由；打开“聊天”页：右侧出现 AI 回复建议。</li></ol>
      <div class="inline-form"><a class="btn pri" href="${BASE}/api/extension.zip">下载插件</a><button class="btn" id="rot">更换令牌</button></div>
      <p class="small muted" style="margin:10px 0 0">插件令牌：<span class="code">${esc(st.extToken)}</span>（更换后需重新下载插件）</p></div></div>
    <div class="card"><div class="card-h"><h3>AI 模型</h3>${st.llm ? '<span class="tag t-ok">已接入学员系统 AI 接口</span>' : '<span class="tag t-bad">未配置</span>'}</div><div class="card-b">
      <div class="grid-form"><label class="fi">主模型通道<input id="ai-p" value="${esc(AI.provider)}"></label><label class="fi">主模型<input id="ai-m" value="${esc(AI.model)}"></label>
      <label class="fi">备用通道<input id="ai-fp" value="${esc(AI.fallbackProvider)}"></label><label class="fi">备用模型<input id="ai-fm" value="${esc(AI.fallbackModel)}"></label>
      <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="ai-on" style="width:auto" ${AI.enabled ? 'checked' : ''}>启用 AI（关闭后只用规则理由和关键词回复）</label></div>
      <div class="inline-form"><button class="btn pri" id="ai-save">保存</button><button class="btn" id="ai-test">测试连接</button><span class="small" id="ai-res"></span></div></div></div>
    <div class="card"><div class="card-h"><h3>初筛规则</h3></div><div class="card-b"><div class="grid-form">
      <label class="fi">年龄上限<input id="r-age" type="number" value="${esc(R.maxAge)}"></label>
      <label class="fi">最低学历<select id="r-edu">${['大专', '本科', '硕士'].map(x => `<option ${x === R.minEdu ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="fi full">科目关键词（专业或职位命中任一即对口，用逗号分隔）<input id="r-kw" value="${esc(R.subjectKeywords.join('，'))}"></label>
      <label class="fi full">学校教学经历关键词（正则）<input id="r-sp" value="${esc(R.schoolPattern)}"></label>
      <label class="fi full">培训机构关键词（正则，只有这类经历判“待确认”）<input id="r-tp" value="${esc(R.trainingPattern)}"></label>
      <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="r-it" style="width:auto" ${R.intentTrack !== false ? 'checked' : ''}>意向型也推荐：没有教学经验，但学历、年龄达标且求职方向是教师类</label>
      <label class="fi">意向型年龄上限<input id="r-ia" type="number" value="${esc(R.intentMaxAge ?? 30)}"></label>
      <label class="fi">意向型最低学历<select id="r-ie">${['大专', '本科', '硕士'].map(x => `<option ${x === (R.intentMinEdu || '本科') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="fi full">求职方向关键词（命中任一即算教师类，逗号分隔）<input id="r-ik" value="${esc((R.intentKeywords || []).join('，'))}"></label></div>
      <div class="inline-form"><button class="btn pri" id="r-save">保存</button><button class="btn" id="r-re">按新规则重新初筛全部</button></div></div></div>
    <div class="card" id="ar-card"><div class="card-h"><h3>约聊回复方式</h3><span class="sub">候选人每条消息先由 AI 分类，再按分类处理</span></div><div class="card-b">
      <label class="fi full" style="flex-direction:row;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="ar-on" style="width:auto" ${AR.enabled ? 'checked' : ''}><b>开启全自动回复</b><span class="small muted">（关闭时，设为“全自动”的分类也只给建议）</span></label>
      <table class="tbl" style="margin:10px 0"><thead><tr><th>消息分类</th><th>示例</th><th>处理方式</th></tr></thead><tbody>
        ${Object.entries(AR_CATS).map(([k, ex]) => `<tr><td><b>${k}</b></td><td class="small muted">${esc(ex)}</td><td><select class="inp" data-pol="${k}" style="width:auto">${Object.entries(MODES).map(([v, t]) => `<option value="${v}" ${(AR.policy[k] || 'semi') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table>
      <p class="small muted" style="margin:0 0 8px">全自动：AI 直接回复并发送；半自动：插件给出建议，由你点发送；转人工：不回复，提醒你处理。回复没通过发送前检查时，一律转人工。</p>
      <div class="grid-form">
        <label class="fi">自动回复开始<input id="ar-h0" type="time" value="${esc(AR.hours[0])}"></label><label class="fi">自动回复结束<input id="ar-h1" type="time" value="${esc(AR.hours[1])}"></label>
        <label class="fi">最短等待（秒）<input id="ar-d0" type="number" value="${esc(AR.delayMin)}"></label><label class="fi">最长等待（秒）<input id="ar-d1" type="number" value="${esc(AR.delayMax)}"></label>
        <label class="fi">每小时最多自动发送<input id="ar-max" type="number" value="${esc(AR.maxPerHour)}"></label>
        <label class="fi" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="ar-scan" style="width:auto" ${AR.scanUnread !== false ? 'checked' : ''}>自动打开有未读消息的会话</label>
        <label class="fi full">回复风格（让 AI 像真人一样说话）<textarea id="ar-style" style="min-height:70px">${esc(AR.style)}</textarea></label></div>
      <div class="inline-form"><button class="btn pri" id="ar-save">保存</button></div></div></div>
    <div class="card" id="kbdoc-card"><div class="card-h"><h3>知识库（整段粘贴）</h3><span class="sub">AI 回复只能用这里和右侧问答里的事实</span></div><div class="card-b">
      <textarea id="kbdoc" class="inp" style="min-height:260px;font-family:inherit" placeholder="把学校介绍、岗位要求、薪资福利说明、面试流程、常见问题及答案等，直接整段粘贴到这里。&#10;&#10;建议格式（不强制）：&#10;【学校介绍】……&#10;【岗位与要求】……&#10;【薪资福利】……（不想让 AI 说的，就不要写进来）&#10;【面试流程】……&#10;【常见问题】问：……  答：……">${esc(st.kbDoc || '')}</textarea>
      <div class="inline-form"><button class="btn pri" id="kbdoc-save">保存知识库</button><span class="small muted" id="kbdoc-n">${(st.kbDoc || '').length} / 20000 字</span></div></div></div>
    <div class="card tester"><div class="card-h"><h3>发送前检查</h3><span class="sub">输入一条消息试试</span></div><div class="card-b">
      <textarea id="rt" class="inp" style="min-height:70px">可以关注我们的公众号，工资保证一万，链接 xxedu.cn/r/20261011003</textarea><div class="hits" id="hits"></div></div></div>
  </div>
  <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
    <div class="card"><div class="card-h"><h3>面试时段与地点</h3></div><div class="card-b"><div class="grid-form">
      <label class="fi full">上午到场时段（逗号分隔，最晚 11:00）<input id="s-am" value="${esc(SC.am.join(', '))}"></label>
      <label class="fi full">下午到场时段<input id="s-pm" value="${esc(SC.pm.join(', '))}"></label>
      <label class="fi">每档最多人数<input id="s-cap" type="number" value="${esc(SC.cap)}"></label><label class="fi">可查看天数<input id="s-days" type="number" value="${esc(SC.days)}"></label>
      <label class="fi">面试地点<input id="o-place" value="${esc(ORG.place)}"></label><label class="fi">AI 自称<input id="o-persona" value="${esc(ORG.persona)}"></label>
      <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="s-wd" style="width:auto" ${SC.weekdaysOnly ? 'checked' : ''}>只排工作日（周一至周五）</label></div>
      <div class="inline-form"><button class="btn pri" id="s-save">保存</button></div></div></div>
    <div class="card"><div class="card-h"><h3>面试官<span class="sub">${ivs.filter(i => i.active).length} 位在岗</span></h3></div><div class="card-b">
      ${ivs.map(i => `<div class="iv-row"><input class="inp" data-ivn="${i.id}" value="${esc(i.name)}"><button class="btn sm" data-ivs="${i.id}">保存</button><button class="btn sm" data-iva="${i.id}" data-on="${i.active ? 0 : 1}">${i.active ? '停用' : '启用'}</button></div>`).join('')}
      <div class="iv-row"><input class="inp" id="iv-new" placeholder="新增面试官姓名"><button class="btn sm pri" id="iv-add">添加</button><span></span></div></div></div>
    <div class="card"><div class="card-h"><h3>知识库<span class="sub">AI 回复只能使用这里的事实</span></h3></div><div class="card-b" id="kb">
      ${st.kb.map((k, i) => `<div class="kv-row"><input class="inp" data-kq="${i}" value="${esc(k.q)}"><input class="inp" data-ka="${i}" value="${esc(k.a)}"><button class="btn sm" data-kd="${i}">删除</button></div>`).join('')}
      <div class="inline-form"><button class="btn sm" id="kb-add">新增一条</button><button class="btn pri sm" id="kb-save">保存知识库</button></div></div></div>
    <div class="card"><div class="card-h"><h3>示例数据</h3></div><div class="card-b" style="font-size:13px"><p style="margin:0 0 8px" class="muted">导入 12 位示例候选人（标“示例”）用于验收演示；正式使用前清空。</p>
      <div class="inline-form"><button class="btn" id="demo-seed">导入示例数据</button><button class="btn" id="demo-clear">清空示例数据</button></div></div></div>
  </div></div>`;
  const list = v => v.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean);
  const save = async (body, msg = '已保存') => { await api('/settings', { method: 'PUT', body }); toast(msg); };
  $('#rot').onclick = async () => { await api('/settings/rotate-token', { body: {} }); toast('令牌已更换，请重新下载插件'); vSettings(m); };
  $('#ai-save').onclick = () => save({ ai: { enabled: $('#ai-on').checked, provider: $('#ai-p').value.trim(), model: $('#ai-m').value.trim(), fallbackProvider: $('#ai-fp').value.trim(), fallbackModel: $('#ai-fm').value.trim() } });
  $('#ai-test').onclick = async () => { $('#ai-res').textContent = '测试中…'; const r = await api('/tools/llm-test', { body: {} }); $('#ai-res').innerHTML = r.ok ? `<b class="ok-dot">● 正常</b> ${esc(r.provider)}/${esc(r.model)} · ${r.ms} ms · “${esc(r.reply)}”` : `<b class="bad-dot">● 失败</b> ${esc(r.error)}`; };
  $('#r-save').onclick = () => save({ rules: { maxAge: +$('#r-age').value, minEdu: $('#r-edu').value, subjectKeywords: list($('#r-kw').value), schoolPattern: $('#r-sp').value.trim(), trainingPattern: $('#r-tp').value.trim(),
    intentTrack: $('#r-it').checked, intentMaxAge: +$('#r-ia').value || 30, intentMinEdu: $('#r-ie').value, intentKeywords: list($('#r-ik').value) } });
  $('#ar-save').onclick = () => {
    const policy = {}; $$('[data-pol]', m).forEach(s => { policy[s.dataset.pol] = s.value; });
    const d0 = Math.max(5, +$('#ar-d0').value || 25), d1 = Math.max(d0, +$('#ar-d1').value || 90);
    return save({ autoReply: { enabled: $('#ar-on').checked, hours: [$('#ar-h0').value || '08:30', $('#ar-h1').value || '21:00'], delayMin: d0, delayMax: d1,
      maxPerHour: Math.max(1, +$('#ar-max').value || 40), scanUnread: $('#ar-scan').checked, policy, style: $('#ar-style').value.trim() } }, $('#ar-on').checked ? '已保存：全自动回复已开启' : '已保存');
  };
  $('#kbdoc').oninput = () => { $('#kbdoc-n').textContent = `${$('#kbdoc').value.length} / 20000 字`; };
  $('#kbdoc-save').onclick = () => save({ kbDoc: $('#kbdoc').value }, '知识库已保存，AI 下一条回复起生效');
  $('#r-re').onclick = async () => { await $('#r-save').onclick(); const r = await api('/settings/rescreen', { body: {} }); toast(`已按新规则重新初筛 ${r.rescreened} 人`); };
  $('#s-save').onclick = async () => {
    const am = list($('#s-am').value), pm = list($('#s-pm').value);
    if (![...am, ...pm].every(x => /^\d{2}:\d{2}$/.test(x))) return toast('时段格式应为 09:00');
    await api('/settings', { method: 'PUT', body: { schedule: { am, pm, cap: +$('#s-cap').value || 4, days: +$('#s-days').value || 5, weekdaysOnly: $('#s-wd').checked }, org: { ...ORG, place: $('#o-place').value.trim(), persona: $('#o-persona').value.trim() } } });
    toast('已保存');
  };
  $$('[data-ivs]', m).forEach(b => b.onclick = async () => { await api('/interviewers/' + b.dataset.ivs, { method: 'PATCH', body: { name: $(`[data-ivn="${b.dataset.ivs}"]`).value } }); toast('已保存'); });
  $$('[data-iva]', m).forEach(b => b.onclick = async () => { await api('/interviewers/' + b.dataset.iva, { method: 'PATCH', body: { active: b.dataset.on === '1' } }); vSettings(m); });
  $('#iv-add').onclick = async () => { const n = $('#iv-new').value.trim(); if (!n) return; await api('/interviewers', { body: { name: n } }); vSettings(m); };
  const kbRead = () => $$('[data-kq]', m).map(el => ({ id: 'KB-' + String(+el.dataset.kq + 1).padStart(2, '0'), q: el.value.trim(), a: $(`[data-ka="${el.dataset.kq}"]`, m).value.trim() })).filter(k => k.q && k.a);
  $('#kb-add').onclick = () => { const i = $$('[data-kq]', m).length; $('#kb-add').parentElement.insertAdjacentHTML('beforebegin', `<div class="kv-row"><input class="inp" data-kq="${i}" placeholder="问题"><input class="inp" data-ka="${i}" placeholder="标准答案"><span></span></div>`); };
  $$('[data-kd]', m).forEach(b => b.onclick = () => b.parentElement.remove());
  $('#kb-save').onclick = async () => { await save({ kb: kbRead() }); vSettings(m); };
  const rt = $('#rt'); const runRisk = async () => { const r = await api('/tools/riskcheck', { body: { text: rt.value } }); $('#hits').innerHTML = [...r.platform.map(n => `<div><span class="tag t-bad">命中</span>平台 · ${esc(n)}</div>`), ...r.guard.map(n => `<div><span class="tag t-bad">命中</span>护栏 · ${esc(n)}</div>`)].join('') || '<div><span class="tag t-ok">通过</span>没有命中任何规则</div>'; };
  rt.oninput = () => { clearTimeout(runRisk._t); runRisk._t = setTimeout(runRisk, 300); }; runRisk();
  $('#demo-seed').onclick = async () => { const r = await api('/demo/seed', { body: {} }); toast(`已导入 ${r.candidates} 位示例候选人`); };
  $('#demo-clear').onclick = async () => { const r = await api('/demo/clear', { body: {} }); toast(`已清空 ${r.removed} 位示例候选人`); };
}

/* ---------------- boot ---------------- */
async function boot() {
  try { S.me = await api('/me'); } catch { return; }
  const h = location.hash.slice(1);
  if (VIEWS.some(v => v[0] === h)) S.view = h;
  shell(); render();
  clearInterval(boot._t);
  boot._t = setInterval(() => { if (S.me && !S.drawer && ['home', 'sched'].includes(S.view) && !S.picker && document.visibilityState === 'visible') render(); }, 30000);
}
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (S.me && h !== S.view && VIEWS.some(v => v[0] === h)) { S.view = h; render(); } });
boot();
})();
