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
const ATTEND = ['确认参加', '待确认', '待排程', '改期中', '沟通中', '未联系', '不来', '不合适', '未回复'];
const ACLS = { '确认参加': 't-ok', '待确认': 't-info', '待排程': 't-warn', '改期中': 't-ai', '沟通中': 't-grey', '未联系': 't-grey', '不来': 't-bad', '不合适': 't-grey', '未回复': 't-grey' };
const ACOL = { '确认参加': 'var(--ok)', '待确认': 'var(--info)', '待排程': 'var(--warn)', '改期中': 'var(--ai)', '沟通中': '#AEB3BB', '未联系': '#D5D8DD', '不来': 'var(--bad)', '不合适': '#C9CCD2', '未回复': '#E4E6EA' };
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
ICON.kb = '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10M9 8h5"/>';
const VIEWS = [['home', '总览', '工作台'], ['screen', '采集初筛', '招聘流程'], ['chat', 'AI 约聊'], ['pool', '人才池'], ['sched', '面试排程'], ['kb', '知识库', '系统'], ['settings', '设置']];
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
  try { await ({ home: vHome, screen: vScreen, chat: vChat, pool: vPool, sched: vSched, kb: vKb, settings: vSettings })[S.view](m); }
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
  // per platform: is the 消息 page (where auto replies run) open, and today's greetings against the caps
  const pg = d.extPages || {}, caps = (d.greet || {}).daily || {};
  const pageTag = (p, k) => { const x = pg[`${p}:${k}`]; const on = x && Date.now() - x.ms < 180000; return `<span class="tag ${on ? 't-ok' : k === 'im' ? 't-bad' : 't-grey'}">${k === 'im' ? '消息页' : '推荐页'} ${on ? '在线' : '未打开'}</span>${x ? `<span class="muted small"> 最近 ${esc(x.at.slice(5, 16))}</span>` : ''}`; };
  const runRow = (p, name) => `<div class="ivrow" style="flex-wrap:wrap;gap:8px"><b>${name}</b>${pageTag(p, 'im')}${pageTag(p, 'rec')}
    <span class="muted small">今日打招呼：${Object.entries(ROLE_LABEL).filter(([k]) => caps[k] !== undefined).map(([k, l]) => `${l} ${(d.greetToday?.[p] || {})[k] || 0}/${caps[k]}`).join(' · ')}</span></div>`;
  const runCard = `<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>插件运行状态</h3><span class="sub">自动回复只在招聘平台的「消息」页运行；消息页显示“未打开”时，候选人的消息不会被回复</span></div>
    <div class="card-b ivlist">${runRow('zhaopin', '智联')}${runRow('boss', 'BOSS直聘')}</div></div>`;
  m.innerHTML = ph('总览', `今天 ${d.today}。AI 在招聘平台读取、初筛、约聊，你只处理下面的事项。${d.llm ? '' : ' <b style="color:var(--bad)">AI 模型未配置，当前使用规则回退。</b>'}`,
    `<button class="btn" data-go="screen">采集初筛</button><button class="btn pri" data-go="sched">今日面试安排</button>`) +
    (d.total === 0 ? `<div class="card" style="margin-bottom:16px"><div class="empty-state"><b>还没有候选人数据</b>在“设置”里下载并安装浏览器插件，打开智联推荐人才页即自动读取初筛；也可以先在“设置 → 示例数据”导入示例看效果。</div></div>` : '') +
    runCard + `<div class="kpis">${kp.map(k => `<div class="card kpi ${k[3] ? 'hot' : ''}"><span class="l">${k[0]}</span><span class="v num">${esc(k[1])}</span><span class="s">${esc(k[2])}</span></div>`).join('')}</div>
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
    ${d.rows.length ? d.rows.map(c => `<tr data-id="${c.id}"><td><div class="cand"><span class="ava">${esc((c.name || '?')[0])}</span><div><b>${esc(c.name)}${c.roleName && c.role !== 'teacher' ? ` <span class="tag t-info">${esc(c.roleName)}</span>` : ''}${c.isDemo ? '<span class="demo-tag">示例</span>' : ''}</b><span>${c.age ?? '—'}岁 · ${esc(c.edu || '—')} · ${esc(c.years || '')}</span></div></div></td>
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
// 人才池岗位分类（与后台岗位 key 对应）
const POOL_ROLES = [['all', '全部岗位'], ['teacher', '教师'], ['xueguan', '学管师'], ['zixun', '课程顾问'], ['other', '其他']];
const ROLE_LABEL = Object.fromEntries(POOL_ROLES.slice(1));
async function vPool(m) {
  if (!m.querySelector('#poolwrap')) m.innerHTML = loading;
  S.poolRole = S.poolRole || 'all'; S.poolNote = S.poolNote || '';
  const qs = new URLSearchParams();
  if (S.poolTab !== '全部') qs.set('attend', S.poolTab);
  if (S.q.trim()) qs.set('q', S.q.trim());
  if (S.poolRole !== 'all') qs.set('role', S.poolRole);
  if (S.poolNote) qs.set('note', S.poolNote);
  if (S.poolReserve) qs.set('reserve', '1');
  if (S.poolResume) qs.set('resume', S.poolResume);
  const d = await api('/candidates?' + qs);
  const rc = d.rcounts || {}, rtotal = Object.values(rc).reduce((a, b) => a + b, 0);
  const counts = d.counts || {}, total = Object.values(counts).reduce((a, b) => a + b, 0);
  const order = c => ATTEND.indexOf(c.attend);
  const rows = d.rows.sort((a, b) => order(a) - order(b) || (a.appt && b.appt ? (a.appt.date + a.appt.slot).localeCompare(b.appt.date + b.appt.slot) : 0) || (b.score || 0) - (a.score || 0));
  const when = c => {
    if (c.appt) return `<div class="when"><b>${esc(c.appt.date.slice(5))} ${esc(c.appt.slot)}</b><span>${c.appt.interviewer ? `${c.appt.desk === '已结束' ? '已面试' : '已分配'} · ${esc(c.appt.interviewer)}` : c.appt.desk === '未到' ? '未到场' : '到场后前台分配'}</span></div>`;
    if (['待排程', '改期中'].includes(c.attend)) return `<div class="when"><span>偏好：${halfTxt(c.pref)}</span></div>`;
    return '<span class="muted">—</span>';
  };
  m.innerHTML = `<div id="poolwrap">` + ph('人才池', '按约聊结果管理：来不来、什么时间到场、由哪位面试官面试。点任意一行查看详细简历和约聊记录。') +
    `<div class="card"><div class="toolbar"><div class="seg">${POOL_ROLES.map(([k, t]) => `<button aria-pressed="${S.poolRole === k}" data-r="${k}">${t}<span class="c">${k === 'all' ? rtotal : rc[k] || 0}</span></button>`).join('')}</div>
      <div class="inline-form" style="gap:8px;margin:0">
      <button class="btn ${S.poolReserve ? 'pri' : ''}" id="preserve" title="收到附件简历的人自动进入人才库，也可在简历详情里手动加入">人才库（储备）<span class="c">${d.reserveCount || 0}</span></button>
      <select class="inp" id="presume" style="width:auto"><option value="">附件简历：全部</option>${['已收到', '已索要', '未索要'].map(t => `<option ${S.poolResume === t ? 'selected' : ''}>${t}（${(d.resumeCounts || {})[t] || 0}）</option>`).join('')}</select>
      <select class="inp" id="pnote" style="width:auto"><option value="">备注：全部</option><option value="has" ${S.poolNote === 'has' ? 'selected' : ''}>有备注（${d.ncount || 0}）</option><option value="none" ${S.poolNote === 'none' ? 'selected' : ''}>无备注</option></select></div></div>
    <div class="toolbar" style="padding-top:0"><div class="seg">${['全部', ...ATTEND].map(t => `<button aria-pressed="${S.poolTab === t}" data-t="${t}">${t}<span class="c">${t === '全部' ? total : counts[t] || 0}</span></button>`).join('')}</div>
      <input class="search" id="q" placeholder="搜索姓名、手机号、学校、专业、岗位、备注" value="${esc(S.q)}"></div>
    <div class="tbl-wrap"><table class="rowc"><thead><tr><th>候选人</th><th>岗位</th><th style="min-width:120px">手机号 <span class="muted small">（点击编辑）</span></th><th>初筛</th><th>来不来</th><th>面试安排</th><th>最新进展</th><th style="min-width:180px">备注 <span class="muted small">（点击编辑）</span></th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(c => `<tr data-id="${c.id}"><td><div class="cand"><span class="ava">${esc((c.name || '?')[0])}</span><div><b>${esc(c.name)}${c.isDemo ? '<span class="demo-tag">示例</span>' : ''}${c.handoff ? ' <span class="tag t-bad">转人工</span>' : ''}</b><span>${c.age ?? '—'}岁 · ${esc(c.edu || '—')} · ${esc(c.school || '')}</span></div></div></td>
      <td><span class="tag ${c.role === 'other' ? 't-grey' : 't-info'}">${esc(ROLE_LABEL[c.role] || c.roleName || '教师')}</span><div>${esc(c.job || '—')}</div><div class="muted small">${esc(c.source || '')}</div></td>
      <td class="note-cell num" data-phone="${c.id}" title="点击编辑手机号">${c.phone ? esc(c.phone) : '<span class="muted small">+ 填写</span>'}</td><td>${tagV(c.verdict)} <span class="score">${c.score ?? ''}</span><div style="margin-top:4px">${c.resumeStatus === '已收到' ? '<span class="tag t-ok">简历已收到</span>' : c.resumeStatus === '已索要' ? '<span class="tag t-warn">简历已索要</span>' : ''}${c.reserve ? ' <span class="tag t-ai">人才库</span>' : ''}</div></td><td>${tagA(c.attend)}</td><td>${when(c)}</td><td class="latest">${esc(c.lastNote || '')}</td>
      <td class="note-cell" data-note="${c.id}" title="点击编辑备注">${c.staffNote ? esc(c.staffNote) : '<span class="muted small">+ 添加备注</span>'}</td><td><button class="btn sm">简历</button></td></tr>`).join('')
      : '<tr><td colspan="9"><div class="empty-state">没有符合条件的候选人</div></td></tr>'}</tbody></table></div></div></div>`;
  $$('[data-t]', m).forEach(b => b.onclick = () => { S.poolTab = b.dataset.t; vPool(m); });
  $$('[data-r]', m).forEach(b => b.onclick = () => { S.poolRole = b.dataset.r; vPool(m); });
  $('#pnote', m).onchange = e => { S.poolNote = e.target.value; vPool(m); };
  $('#preserve', m).onclick = () => { S.poolReserve = !S.poolReserve; vPool(m); };
  $('#presume', m).onchange = e => { S.poolResume = e.target.value.replace(/（.*$/, ''); vPool(m); };
  // inline editing of 备注 / 手机号: Enter or leaving the box saves, Esc cancels
  const inlineEdit = (td, { id, field, label, empty, multiline, placeholder, max }) => {
    const c = rows.find(x => x.id === id), old = c[field] || '';
    td.innerHTML = multiline
      ? `<textarea class="inp" style="min-height:54px;font-size:12.5px" maxlength="${max}" placeholder="${placeholder}">${esc(old)}</textarea>`
      : `<input class="inp" style="font-size:12.5px" maxlength="${max}" placeholder="${placeholder}" value="${esc(old)}">`;
    const box = td.firstElementChild; box.focus(); box.setSelectionRange(old.length, old.length);
    let done = false;
    const show = () => { td.innerHTML = c[field] ? esc(c[field]) : `<span class="muted small">${empty}</span>`; };
    const finish = async save => {
      if (done) return; done = true;
      const v = box.value.trim();
      if (save && v !== old) {
        try { await api(`/candidates/${id}`, { method: 'PATCH', body: { [field]: v } }); c[field] = v; toast(v ? `${label}已保存` : `${label}已清空`); }
        catch (er) { toast(er.message); }
      }
      show();
    };
    box.onclick = ev => ev.stopPropagation();
    box.onkeydown = ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); } if (ev.key === 'Escape') finish(false); };
    box.onblur = () => finish(true);
  };
  $$('[data-note]', m).forEach(td => td.onclick = e => { e.stopPropagation(); if (td.querySelector('textarea')) return;
    inlineEdit(td, { id: +td.dataset.note, field: 'staffNote', label: '备注', empty: '+ 添加备注', multiline: true, placeholder: '例如：说话有亲和力，可优先；下周再联系', max: 300 }); });
  $$('[data-phone]', m).forEach(td => td.onclick = e => { e.stopPropagation(); if (td.querySelector('input')) return;
    inlineEdit(td, { id: +td.dataset.phone, field: 'phone', label: '手机号', empty: '+ 填写', multiline: false, placeholder: '11 位手机号', max: 13 }); });
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
  const memo = [['手机号', c.phone ? esc(c.phone) : '<span class="muted">未登记（交换电话或对方发来后自动登记）</span>'], ['来不来', tagA(c.attend)], ['面试时间', a ? `${esc(a.date)} ${esc(a.slot)}（${esc(a.status)}）` : esc(halfTxt(c.pref))], ['面试官', a?.interviewer ? `${esc(a.interviewer)}（${esc(a.desk)}）` : a ? '到场后由前台按空闲分配' : '—'],
    ['面试地点', esc(sch.place)], ['教师资格证', esc(c.slots.cert || (c.certs || []).join('、') || '未知')], ['最早到岗', esc(c.slots.arrive || '未知')], ['转人工', c.handoff ? '是' : '否']];
  root.innerHTML = `<div class="scrim" id="scrim"></div><aside class="drawer" role="dialog" aria-label="${esc(c.name)} 详情">
    <div class="dh"><div class="dh-top"><span class="ava">${esc((c.name || '?')[0])}</span><div><h2>${esc(c.name)} ${tagA(c.attend)} <span class="tag t-info">${esc(c.roleName || '教师')}</span></h2>
      <div class="meta">${c.age ?? '—'}岁 · ${esc(c.edu || '—')} · ${esc(c.years || '')} · ${esc(c.careerStatus || '')}</div><div class="muted small">职位 ${esc(c.job || '—')} · 来源 ${esc(c.source || '')}</div>
      <div class="inline-form" style="margin-top:6px;gap:6px;align-items:center"><span class="small">岗位分类</span><select class="inp" id="d-role" style="width:auto;padding:3px 8px">
        <option value="auto">按职位名自动识别${c.roleManual ? '' : `（${esc(ROLE_LABEL[c.role] || '教师')}）`}</option>
        ${POOL_ROLES.slice(1).map(([k, t]) => `<option value="${k}" ${c.roleManual && c.role === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <span class="small" style="margin-left:8px">附件简历</span><select class="inp" id="d-resume" style="width:auto;padding:3px 8px">${['未索要', '已索要', '已收到'].map(t => `<option ${c.resumeStatus === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <label class="small" style="display:flex;gap:4px;align-items:center;margin-left:8px"><input type="checkbox" id="d-reserve" ${c.reserve ? 'checked' : ''}>人才库（储备）</label></div>
      <textarea class="inp" id="d-note" maxlength="300" style="margin-top:6px;min-height:44px;font-size:12.5px" placeholder="备注（人才池可按备注筛选），离开输入框自动保存">${esc(c.staffNote || '')}</textarea></div><button class="x" id="dx" aria-label="关闭">✕</button></div>
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
  const refreshPool = () => { if (S.view === 'pool') vPool($('#main')); };
  $('#d-role').onchange = async e => { await api(`/candidates/${c.id}`, { method: 'PATCH', body: { role: e.target.value } }); toast(e.target.value === 'auto' ? '已改回按职位名自动识别' : `岗位已改为：${ROLE_LABEL[e.target.value]}`); renderDrawer(); refreshPool(); };
  $('#d-resume').onchange = async e => { await api(`/candidates/${c.id}`, { method: 'PATCH', body: { resumeStatus: e.target.value } }); toast(`附件简历：${e.target.value}`); refreshPool(); };
  $('#d-reserve').onchange = async e => { await api(`/candidates/${c.id}`, { method: 'PATCH', body: { reserve: e.target.checked } }); toast(e.target.checked ? '已加入人才库' : '已移出人才库'); refreshPool(); };
  $('#d-note').onblur = async e => { const v = e.target.value.trim(); if (v === (c.staffNote || '')) return; await api(`/candidates/${c.id}`, { method: 'PATCH', body: { staffNote: v } }); c.staffNote = v; toast('备注已保存'); refreshPool(); };
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
      <aside class="copilot">${c ? `<div class="cp-sec"><h4>已知信息（AI 抽取）</h4><dl class="slots">${[['在职情况', c.slots.employed], ['住处', c.slots.live], ['想教科目', c.slots.subject], ['教师资格证（加分项）', c.slots.cert], ['最早到岗', c.slots.arrive], ['可面时间', c.slots.half ? halfTxt({ half: c.slots.half, date: c.slots.day }) : null], ['到场安排', c.appt ? `${c.appt.date.slice(5)} ${c.appt.slot}（${c.appt.status}）` : null]].map(([k, v]) => `<dt>${k}</dt><dd class="${v ? '' : 'miss'}">${esc(v || '缺')}</dd>`).join('')}</dl></div>
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
      $('#draft').innerHTML = `<h4>AI 建议 · 分类：${esc(dr.intent)}${dr.topic ? ` · 主题：${esc(dr.topic)}` : ''}${dr.asked > 1 ? ` · <span style="color:var(--bad)">第 ${dr.asked} 遍</span>` : ''} <span class="mini-tag">（${esc(dr.model)}）</span></h4>
        ${(dr.sources || []).length ? `<div class="small muted" style="margin:0 0 6px">参考资料：${dr.sources.map(x => esc(x.title)).filter((v, i, a) => a.indexOf(v) === i).join('、')}</div>` : ''}
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

/* ---------------- 知识库 ---------------- */
// document text is extracted in the browser; libraries load on first use
const LIBS = {
  mammoth: ['https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js', 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js'],
  pdfjsLib: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js'],
  XLSX: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'],
};
async function lib(name) {
  if (window[name]) return window[name];
  for (const src of LIBS[name]) {
    try {
      await new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
      if (window[name]) {
        if (name === 'pdfjsLib') window.pdfjsLib.GlobalWorkerOptions.workerSrc = src.replace('pdf.min.js', 'pdf.worker.min.js');
        return window[name];
      }
    } catch { /* try next mirror */ }
  }
  throw new Error('文档解析组件加载失败，请检查网络后重试');
}
async function fileText(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (['txt', 'md', 'csv', 'json'].includes(ext)) return await f.text();
  if (ext === 'docx') return (await (await lib('mammoth')).extractRawText({ arrayBuffer: await f.arrayBuffer() })).value;
  if (ext === 'pdf') {
    const pdf = await (await lib('pdfjsLib')).getDocument({ data: await f.arrayBuffer() }).promise;
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      let line = '', lastY = null;
      for (const it of tc.items) { if (lastY != null && Math.abs(it.transform[5] - lastY) > 2) { out.push(line); line = ''; } line += it.str; lastY = it.transform[5]; }
      out.push(line, '');
    }
    return out.join('\n');
  }
  if (['xlsx', 'xls'].includes(ext)) {
    const X = await lib('XLSX');
    const wb = X.read(await f.arrayBuffer(), { type: 'array' });
    return wb.SheetNames.map(n => `【${n}】\n` + X.utils.sheet_to_csv(wb.Sheets[n], { FS: ' | ' }).replace(/( \| )+$/gm, '')).join('\n\n');
  }
  if (ext === 'doc') throw new Error('旧版 .doc 请先在 Word 里另存为 .docx');
  throw new Error(`不支持 .${ext} 文件`);
}

// knowledge-base document scope: all roles or one role
const KB_ROLES = { all: '通用', teacher: '教师', xueguan: '学管师', zixun: '课程顾问', other: '其他' };
const roleSel = (id, v, attr = '') => `<select class="inp" ${id ? `id="${id}"` : ''} ${attr} style="width:auto">${Object.entries(KB_ROLES).map(([k, t]) => `<option value="${k}" ${k === (v || 'all') ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
async function vKb(m) {
  m.innerHTML = loading;
  const d = await api('/kb/docs');
  const L = d.learned;
  const st = d.stats;
  m.innerHTML = ph('知识库', `AI 回复候选人时只能使用这里的事实。共 ${st.docs} 份文档（启用 ${st.enabled}），${st.chars.toLocaleString()} 字，切成 ${st.passages} 段；每次回复只取与问题最相关的几段。`,
    `<button class="btn" id="kb-learn">从历史约聊学习</button><button class="btn" id="kb-new">新建文字文档</button><span class="small muted">上传到</span>${roleSel('kb-uprole', 'all')}<button class="btn pri" id="kb-up">上传文档</button><input type="file" id="kb-file" multiple accept=".txt,.md,.csv,.docx,.pdf,.xlsx,.xls" hidden>`) + `
  <p class="small muted" style="margin:-6px 0 12px">文档可以标注所属岗位：AI 回复某个岗位的候选人时，只参考“通用”和该岗位的资料。学管师、咨询师各有一份【模板】，填写后勾选“启用”即可。</p>
  <div id="kb-edit"></div>
  <div class="card" id="kb-drop" style="margin-bottom:16px;border:2px dashed var(--line);text-align:center;padding:22px;cursor:pointer"><b>把文档拖到这里，或点击选择文件</b><div class="small muted" style="margin-top:4px">支持 Word（.docx）、PDF、Excel（.xlsx/.xls）、txt、md、csv，可一次选多个。扫描版 PDF（图片）无法读取文字。不想让 AI 对外说的内容不要上传。</div><div id="kb-prog" class="small" style="margin-top:6px"></div></div>
  <div class="g3" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)">
    <div class="card"><div class="card-h"><h3>文档</h3></div><div class="tbl-wrap"><table><thead><tr><th>标题</th><th>岗位</th><th>来源</th><th>字数</th><th>更新</th><th>启用</th><th></th></tr></thead><tbody>
      ${d.docs.length ? d.docs.map(x => `<tr><td><b>${esc(x.title)}</b></td><td>${roleSel('', x.role, `data-rl="${x.id}"`)}</td><td class="small muted">${esc(x.source || '')}</td><td class="num">${x.chars.toLocaleString()}</td><td class="small muted">${esc((x.updated_at || '').slice(5, 16))}</td>
        <td><input type="checkbox" data-en="${x.id}" ${x.enabled ? 'checked' : ''}></td><td style="white-space:nowrap"><button class="btn sm" data-ed="${x.id}">编辑</button> <button class="btn sm" data-del="${x.id}">删除</button></td></tr>`).join('')
        : '<tr><td colspan="7"><div class="empty-state">还没有文档。上传文档，或点“从历史约聊学习”自动整理常见问题。</div></td></tr>'}
    </tbody></table></div></div>
    <div class="card"><div class="card-h"><h3>检索测试</h3><span class="sub">输入候选人可能问的话，看 AI 会参考哪几段</span></div><div class="card-b">
      <div class="inline-form"><input class="inp" id="kb-q" placeholder="例如：你们几点下班？有五险一金吗？"><button class="btn" id="kb-qgo">查找</button></div><div id="kb-qres" class="small" style="margin-top:8px"></div></div></div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-h"><h3>从历史约聊学到的常见问题</h3><span class="sub">${L ? `分析了 ${L.conversations} 个会话、${L.questions} 条候选人消息 · ${esc(L.at.slice(5, 16))}` : '还没有分析过'}</span></div><div class="card-b" id="kb-learned">
    ${L && L.topics.length ? `<p class="small muted" style="margin:0 0 10px">标准答案根据你当时的回复整理，请核对修改后再加入知识库。“待补充”的地方需要你填写。</p>` + L.topics.map((t, i) => `<div class="kv-learn" style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><b>${esc(t.topic)}</b><span class="tag t-info">约 ${t.count} 次</span><span class="small muted">${t.examples.map(esc).join(' / ')}</span></div>
      <textarea class="inp" data-la="${i}" style="min-height:70px">${esc(t.answer)}</textarea>${t.gaps ? `<div class="small" style="color:var(--warn);margin-top:4px">还缺：${esc(t.gaps)}</div>` : ''}
      <div class="inline-form" style="margin-top:6px"><button class="btn sm pri" data-ladd="${i}">加入知识库</button></div></div>`).join('') + '<button class="btn" id="kb-ladd-all">全部加入为一份文档</button>'
      : '<div class="empty-state">先在智联聊天页插件面板点“采集历史约聊”，把过去的会话导入，再点右上角“从历史约聊学习”。AI 会按薪资、待遇福利、作息时间等主题归纳候选人最关心的问题，并根据你当时的回答整理标准答案。</div>'}
  </div></div>
  <div class="card" style="margin-top:16px"><div class="card-h"><h3>我的沟通话术</h3><span class="sub">${d.playbook?.at ? `从历史约聊学习于 ${esc(d.playbook.at.slice(5, 16))} · ` : ''}AI 自动回复时模仿这里的口吻和推进方式</span></div><div class="card-b">
    <label class="fi full" style="flex-direction:row;gap:8px;align-items:center;margin-bottom:8px"><input type="checkbox" id="pb-on" style="width:auto" ${d.playbook?.enabled !== false ? 'checked' : ''}>启用</label>
    <textarea class="inp" id="pb-text" style="min-height:260px;line-height:1.7" placeholder="点“从历史约聊学习”后自动生成，也可以自己写。建议按这些小标题：&#10;【整体风格】&#10;【候选人主动投递·条件合适】&#10;【候选人主动投递·条件不合适】&#10;【我打招呼后对方回复】&#10;【引导约面】&#10;【常用说法】&#10;【避免的说法】">${esc(d.playbook?.text || '')}</textarea>
    <div class="inline-form"><button class="btn pri" id="pb-save">保存话术</button><span class="small muted">只学说话方式；薪资、福利等事实仍以上面的文档为准。</span></div></div></div>`;
  $('#pb-save').onclick = async () => { await api('/settings', { method: 'PUT', body: { playbook: { ...(d.playbook || {}), enabled: $('#pb-on').checked, text: $('#pb-text').value.trim() } } }); toast('话术已保存，AI 下一条回复起生效'); };

  const upload = async files => {
    const prog = $('#kb-prog'); let ok = 0;
    for (const f of files) {
      prog.textContent = `正在读取 ${f.name}…`;
      try {
        const text = (await fileText(f)).replace(/\n{3,}/g, '\n\n').trim();
        if (!text) throw new Error('没有读到文字（可能是扫描件）');
        await api('/kb/docs', { body: { title: f.name.replace(/\.[^.]+$/, ''), content: text, source: `文件 .${f.name.split('.').pop()}`, role: $('#kb-uprole').value } });
        ok++;
      } catch (e) { toast(`${f.name}：${e.message}`); await sleep(1500); }
    }
    prog.textContent = '';
    toast(`已加入 ${ok} 份文档`); vKb(m);
  };
  $('#kb-up').onclick = $('#kb-drop').onclick = () => $('#kb-file').click();
  $('#kb-file').onchange = e => upload([...e.target.files]);
  const drop = $('#kb-drop');
  drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; };
  drop.ondragleave = () => { drop.style.borderColor = ''; };
  drop.ondrop = e => { e.preventDefault(); drop.style.borderColor = ''; upload([...e.dataTransfer.files]); };

  const editor = (doc = { title: '', content: '' }) => {
    $('#kb-edit').innerHTML = `<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>${doc.id ? '编辑文档' : '新建文字文档'}</h3></div><div class="card-b">
      <label class="fi full">标题<input class="inp" id="ke-t" value="${esc(doc.title)}" placeholder="例如：薪资福利说明"></label>
      <label class="fi" style="margin-top:8px">所属岗位 ${roleSel('ke-r', doc.role)}</label>
      <label class="fi full" style="margin-top:8px">内容（可直接粘贴整篇）<textarea class="inp" id="ke-c" style="min-height:380px;line-height:1.7">${esc(doc.content)}</textarea></label>
      <div class="inline-form"><button class="btn pri" id="ke-save">保存</button><button class="btn" id="ke-cancel">取消</button><span class="small muted" id="ke-n">${doc.content.length.toLocaleString()} 字</span></div></div></div>`;
    $('#ke-c').oninput = () => { $('#ke-n').textContent = `${$('#ke-c').value.length.toLocaleString()} 字`; };
    $('#ke-cancel').onclick = () => { $('#kb-edit').innerHTML = ''; };
    $('#ke-save').onclick = async () => {
      const body = { title: $('#ke-t').value.trim(), content: $('#ke-c').value, role: $('#ke-r').value };
      if (!body.content.trim()) return toast('内容不能为空');
      try { await api(doc.id ? `/kb/docs/${doc.id}` : '/kb/docs', { method: doc.id ? 'PATCH' : 'POST', body }); toast('已保存，AI 下一条回复起生效'); vKb(m); } catch (e) { toast(e.message); }
    };
    $('#kb-edit').scrollIntoView({ behavior: 'smooth' });
  };
  $('#kb-new').onclick = () => editor();
  $$('[data-ed]', m).forEach(b => b.onclick = async () => editor(await api(`/kb/docs/${b.dataset.ed}`)));
  $$('[data-del]', m).forEach(b => b.onclick = async () => { if (!confirm('删除这份文档？')) return; await api(`/kb/docs/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除'); vKb(m); });
  $$('[data-rl]', m).forEach(s => s.onchange = async () => { await api(`/kb/docs/${s.dataset.rl}`, { method: 'PATCH', body: { role: s.value } }); toast(`已标为：${KB_ROLES[s.value]}`); });
  $$('[data-en]', m).forEach(b => b.onchange = async () => { await api(`/kb/docs/${b.dataset.en}`, { method: 'PATCH', body: { enabled: b.checked } }); toast(b.checked ? '已启用' : '已停用，AI 不再参考这份文档'); });

  const search = async () => {
    const q = $('#kb-q').value.trim(); if (!q) return;
    const r = await api('/kb/search', { body: { q } });
    $('#kb-qres').innerHTML = `<div class="muted" style="margin-bottom:6px">识别主题：${esc(r.topic)}</div>` + (r.passages.length ? r.passages.map(p => `<div style="border-left:3px solid var(--accent);padding:4px 8px;margin-bottom:6px;background:var(--panel-2,#fafafa)"><b>${esc(p.title)}</b> <span class="muted">相关度 ${p.score}</span><div>${esc(p.text.slice(0, 220))}${p.text.length > 220 ? '…' : ''}</div></div>`).join('') : '<div style="color:var(--bad)">没找到相关段落 —— AI 会回复“我核实一下”，并转给你处理。</div>');
  };
  $('#kb-qgo').onclick = search;
  $('#kb-q').onkeydown = e => { if (e.key === 'Enter') search(); };

  $('#kb-learn').onclick = async () => {
    const b = $('#kb-learn'); b.disabled = true; b.textContent = 'AI 正在分析历史约聊…（约 20–60 秒）';
    try { const r = await api('/kb/learn', { body: {} }); if (!r.ok) toast(r.error); else toast(`分析完成：归纳出 ${r.topics.length} 个主题`); vKb(m); }
    catch (e) { toast(e.message); b.disabled = false; b.textContent = '从历史约聊学习'; }
  };
  const learnedDoc = idx => idx.map(i => `【${L.topics[i].topic}】\n${$(`[data-la="${i}"]`).value.trim()}`).join('\n\n');
  $$('[data-ladd]', m).forEach(b => b.onclick = async () => {
    const i = +b.dataset.ladd;
    await api('/kb/docs', { body: { title: `常见问题：${L.topics[i].topic}`, content: learnedDoc([i]), source: '历史约聊' } });
    toast('已加入知识库'); b.disabled = true; b.textContent = '已加入';
  });
  const all = $('#kb-ladd-all');
  if (all) all.onclick = async () => { await api('/kb/docs', { body: { title: '常见问题（来自历史约聊）', content: learnedDoc(L.topics.map((_, i) => i)), source: '历史约聊' } }); toast('已加入知识库'); vKb(m); };
}

/* ---------------- 设置 ---------------- */
async function vSettings(m) {
  m.innerHTML = loading;
  const [st, ivs] = await Promise.all([api('/settings'), api('/interviewers')]);
  const R = st.rules, SC = st.schedule, AI = st.ai, ORG = st.org, AR = st.autoReply, RO = st.roles || {}, FU = AR.followup || {}, GR = st.greet || {};
  const MODES = { auto: '全自动', semi: '半自动', human: '转人工' };
  const AR_CATS = { '跟进': '对方久未回复时的主动跟进（见下方“主动跟进”设置）', '投递-符合': '主动投递、初筛符合 → 感谢并邀约初试', '投递-不符合': '主动投递、初筛不符合 → 礼貌婉拒', '投递-待确认': '主动投递、简历信息不全 → 先问关键信息',
    提问: '学校在哪？上几节课？', 提供信息: '有初中数学教资，2 月能到岗', 约面时间: '明天下午可以去面试', 确认参加: '好的，我会准时到',
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
      <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="r-tzb" style="width:auto" ${R.requireTongzhaoBachelor !== false ? 'checked' : ''}>要求统招全日制本科：第一学历就是本科，专升本、大专、非统招本科一律不推荐（AI 复核不放宽）</label>
      <label class="fi full">最晚毕业年份（所有岗位：这一年之后毕业、还在上学的一律不推荐；填 0 不限）<input id="r-grad" type="number" value="${esc(R.maxGradYear ?? 2026)}"></label>
      <label class="fi full">科目关键词（专业或职位命中任一即对口，用逗号分隔）<input id="r-kw" value="${esc(R.subjectKeywords.join('，'))}"></label>
      <label class="fi full">学校教学经历关键词（正则）<input id="r-sp" value="${esc(R.schoolPattern)}"></label>
      <label class="fi full">培训机构关键词（正则，只有这类经历判“待确认”）<input id="r-tp" value="${esc(R.trainingPattern)}"></label>
      <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="r-it" style="width:auto" ${R.intentTrack !== false ? 'checked' : ''}>意向型也推荐：没有教学经验，但学历、年龄达标且求职方向是教师类</label>
      <label class="fi">意向型年龄上限<input id="r-ia" type="number" value="${esc(R.intentMaxAge ?? 30)}"></label>
      <label class="fi">意向型最低学历<select id="r-ie">${['大专', '本科', '硕士'].map(x => `<option ${x === (R.intentMinEdu || '本科') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="fi full">求职方向关键词（命中任一即算教师类，逗号分隔）<input id="r-ik" value="${esc((R.intentKeywords || []).join('，'))}"></label></div>
      <div class="inline-form"><button class="btn pri" id="r-save">保存</button><button class="btn" id="r-re">按新规则重新初筛全部</button></div></div></div>
    <div class="card" id="roles-card"><div class="card-h"><h3>岗位配置</h3><span class="sub">按平台上的职位名自动识别岗位；每个岗位有自己的初筛规则、约聊要了解的问题和沟通要点</span></div><div class="card-b">
      ${Object.entries(RO).map(([k, r]) => `<details class="role-box" style="border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-bottom:10px" ${k === 'teacher' ? '' : 'open'}>
        <summary style="cursor:pointer;font-weight:600">${esc(r.name)}${k === 'teacher' ? '<span class="small muted">（初筛规则见上方“初筛规则”）</span>' : ''}</summary>
        <div class="grid-form" style="margin-top:8px">
          ${k === 'teacher' ? '' : `<label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" data-ro-en="${k}" style="width:auto" ${r.enabled !== false ? 'checked' : ''}>启用这个岗位</label>`}
          <label class="fi full">职位名包含这些词就算这个岗位（逗号分隔）<input data-ro-jk="${k}" value="${esc((r.jobKeywords || []).join('，'))}"></label>
          ${r.rules ? `<label class="fi">年龄上限<input type="number" data-ro-age="${k}" value="${esc(r.rules.maxAge ?? 35)}"></label>
          <label class="fi">最低学历<select data-ro-edu="${k}">${['大专', '本科', '硕士'].map(x => `<option ${x === (r.rules.minEdu || '大专') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label class="fi">意向型年龄上限（没经验但求职方向对口）<input type="number" data-ro-young="${k}" value="${esc(r.rules.youngMaxAge ?? 28)}"></label>
          <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" data-ro-tz="${k}" style="width:auto" ${r.rules.requireTongzhao ? 'checked' : ''}>要求统招（全日制）学历；简历没写是否统招时，约聊中会问</label>
          <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" data-ro-tzx="${k}" style="width:auto" ${r.rules.eduSalesException ? 'checked' : ''}>在教育行业做过销售类岗位的，可以接受非统招</label>
          <label class="fi full">相关经历关键词（职位或公司名命中即算有经验）<input data-ro-exp="${k}" value="${esc((r.rules.expKeywords || []).join('，'))}"></label>
          <label class="fi full">相关专业关键词（加分）<input data-ro-major="${k}" value="${esc((r.rules.majorKeywords || []).join('，'))}"></label>
          <label class="fi full">求职方向关键词<input data-ro-intent="${k}" value="${esc((r.rules.intentKeywords || []).join('，'))}"></label>` : ''}
          <label class="fi full">约聊时依次了解（一行一个问题，AI 每条消息最多问一个）<textarea data-ro-q="${k}" style="min-height:96px">${esc((r.questions || []).map(q => q[1]).join('\n'))}</textarea></label>
          <label class="fi full">岗位沟通要点（工作内容、要突出什么、要确认什么）<textarea data-ro-focus="${k}" style="min-height:80px">${esc(r.focus || '')}</textarea></label>
          <label class="fi full"><span><b>岗位要求与特殊情况备注</b> <span class="small muted">— 规则判“不推荐 / 待确认”的人，AI 会按这里复核，符合放宽条件的改为推荐或待确认；只放宽，不会把规则合格的人判为不推荐</span></span>
            <textarea data-ro-notes="${k}" style="min-height:100px" placeholder="一行写一条，用大白话即可，例如：&#10;有公立学校教学经验的，年龄可以放宽到 40 岁&#10;专业不对口，但在培训机构带过 2 年以上班的也可以&#10;统招中专毕业、后来专升本或自考本科的，也可以考虑&#10;做过幼儿园老师、想转初中的，可以约来面试看看">${esc(r.notes || '')}</textarea></label>
        </div></details>`).join('')}
      <div class="inline-form"><button class="btn pri" id="ro-save">保存岗位配置</button><button class="btn" id="ro-re">保存并按新规则重新初筛全部</button></div></div></div>
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
        <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="ar-keep" style="width:auto" ${AR.keepImTab !== false ? 'checked' : ''}>插件自动打开并保持「消息」页（固定标签页，被关掉会重新打开；自动回复只在消息页运行）</label>
        <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="ar-inv" style="width:auto" ${AR.autoInvite !== false ? 'checked' : ''}>约定面试时间后，自动在平台点「约面试」发送面试邀约（全自动时）</label>
        <label class="fi full" style="flex-direction:row;gap:8px;align-items:center;margin-top:6px"><input type="checkbox" id="fu-on" style="width:auto" ${FU.enabled !== false ? 'checked' : ''}><b>主动跟进</b><span class="small muted">（对方不回复时，我们主动发一次跟进，引导继续沟通和约面）</span></label>
        <label class="fi">打招呼后多少小时未回复就跟进<input id="fu-gh" type="number" step="0.5" min="0.5" value="${esc(FU.greetHours ?? 3)}"></label>
        <label class="fi">已读后多少小时未回复就跟进<input id="fu-rh" type="number" step="0.5" min="0.5" value="${esc(FU.readHours ?? 1)}"></label>
        <label class="fi" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="fu-read" style="width:auto" ${FU.onlyIfRead !== false ? 'checked' : ''}>对方显示“已读”才跟进</label>
        <label class="fi">每位候选人最多跟进几次<input id="fu-max" type="number" min="1" value="${esc(FU.maxTotal ?? 3)}"></label>
        <label class="fi full">回复风格（让 AI 像真人一样说话）<textarea id="ar-style" style="min-height:70px">${esc(AR.style)}</textarea></label></div>
      <div class="inline-form"><button class="btn pri" id="ar-save">保存</button></div></div></div>
    <div class="card"><div class="card-h"><h3>推荐页打招呼</h3><span class="sub">每个平台分别计数，岗位按推荐页当前职位名识别</span></div><div class="card-b"><div class="grid-form">
      <label class="fi full" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="g-cont" style="width:auto" ${GR.continuous !== false ? 'checked' : ''}><b>持续打招呼</b><span class="small muted">（打完一批自动接着打，直到当天上限；页面刷新后自动继续）</span></label>
      ${Object.entries(RO).map(([k, r]) => `<label class="fi">${esc(r.name)}：每天每个平台最多<input type="number" min="0" data-g-cap="${k}" value="${esc((GR.daily || {})[k] ?? 0)}"></label>`).join('')}</div>
      <div class="inline-form"><button class="btn pri" id="g-save">保存</button></div></div></div>
    <div class="card"><div class="card-h"><h3>AI 对候选人的身份</h3></div><div class="card-b"><div class="grid-form">
      <label class="fi full">身份（AI 以这个身份第一人称回复）<input id="o-role" value="${esc(ORG.role || '')}" placeholder="招聘约访官，同时负责初试面试"></label>
      <label class="fi">候选人怎么称呼你（可空）<input id="o-agent" value="${esc(ORG.agentName || '')}" placeholder="例如：王老师"></label>
      <label class="fi">学校名称<input id="o-name" value="${esc(ORG.name || '')}"></label>
      <label class="fi">同一问题问到第几遍转你本人<input id="ar-rep" type="number" min="2" value="${esc(AR.repeatLimit ?? 2)}"></label></div>
      <p class="small muted" style="margin:6px 0 0">候选人明确问“你是不是机器人 / 真人”时，AI 仍会如实说明是 AI 招聘助理并可转人工。知识库文档在左侧“知识库”页面管理。</p>
      <div class="inline-form"><button class="btn pri" id="o-save">保存</button><button class="btn" data-go="kb">打开知识库</button></div></div></div>
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
  $('#r-save').onclick = () => save({ rules: { maxAge: +$('#r-age').value, minEdu: $('#r-edu').value, maxGradYear: Math.max(0, parseInt($('#r-grad').value, 10) || 0), requireTongzhaoBachelor: $('#r-tzb').checked, subjectKeywords: list($('#r-kw').value), schoolPattern: $('#r-sp').value.trim(), trainingPattern: $('#r-tp').value.trim(),
    intentTrack: $('#r-it').checked, intentMaxAge: +$('#r-ia').value || 30, intentMinEdu: $('#r-ie').value, intentKeywords: list($('#r-ik').value) } });
  // read every field from the page, so one card's save never reverts another card's edits
  const orgBody = () => ({ ...ORG, place: $('#o-place').value.trim(), persona: $('#o-persona').value.trim(),
    role: $('#o-role').value.trim(), agentName: $('#o-agent').value.trim(), name: $('#o-name').value.trim() || ORG.name });
  const arBody = () => {
    const policy = {}; $$('[data-pol]', m).forEach(s => { policy[s.dataset.pol] = s.value; });
    const d0 = Math.max(5, +$('#ar-d0').value || 25), d1 = Math.max(d0, +$('#ar-d1').value || 90);
    return { enabled: $('#ar-on').checked, hours: [$('#ar-h0').value || '08:30', $('#ar-h1').value || '21:00'], delayMin: d0, delayMax: d1,
      maxPerHour: Math.max(1, +$('#ar-max').value || 40), scanUnread: $('#ar-scan').checked, keepImTab: $('#ar-keep').checked, policy, style: $('#ar-style').value.trim(),
      repeatLimit: Math.max(2, +$('#ar-rep').value || 2), autoInvite: $('#ar-inv').checked,
      followup: { enabled: $('#fu-on').checked, greetHours: Math.max(0.5, +$('#fu-gh').value || 3), readHours: Math.max(0.5, +$('#fu-rh').value || 1),
        onlyIfRead: $('#fu-read').checked, maxTotal: Math.max(1, +$('#fu-max').value || 3) } };
  };
  $('#g-save').onclick = () => {
    const daily = { ...(GR.daily || {}) };
    $$('[data-g-cap]', m).forEach(i => { daily[i.dataset.gCap] = Math.max(0, parseInt(i.value, 10) || 0); });
    save({ greet: { ...GR, continuous: $('#g-cont').checked, daily } });
  };
  $('#ar-save').onclick = () => save({ autoReply: arBody() }, $('#ar-on').checked ? '已保存：全自动回复已开启' : '已保存');
  // roles: questions keep their field key when the wording is unchanged or by position
  const roBody = () => {
    const out = {};
    for (const [k, r] of Object.entries(RO)) {
      const v = a => $(`[${a}="${k}"]`, m);
      const lines = v('data-ro-q').value.split('\n').map(x => x.trim()).filter(Boolean);
      const old = r.questions || [];
      const questions = lines.map((q, i) => [(old.find(o => o[1] === q) || old[i] || [`q${i + 1}`])[0], q]);
      const o = { ...r, jobKeywords: list(v('data-ro-jk').value), questions, focus: v('data-ro-focus').value.trim(), notes: v('data-ro-notes').value.trim() };
      if (v('data-ro-en')) o.enabled = v('data-ro-en').checked;
      if (r.rules) o.rules = { ...r.rules, maxAge: +v('data-ro-age').value || 35, minEdu: v('data-ro-edu').value, youngMaxAge: +v('data-ro-young').value || 28,
        requireTongzhao: v('data-ro-tz').checked, eduSalesException: v('data-ro-tzx').checked,
        expKeywords: list(v('data-ro-exp').value), majorKeywords: list(v('data-ro-major').value), intentKeywords: list(v('data-ro-intent').value) };
      out[k] = o;
    }
    return out;
  };
  $('#ro-save').onclick = () => save({ roles: roBody() }, '岗位配置已保存');
  $('#ro-re').onclick = async () => {
    await save({ roles: roBody() });
    const b = $('#ro-re'); b.disabled = true; b.textContent = '重新初筛中，AI 正在按备注复核…（可能要 1–2 分钟）';
    try { const r = await api('/settings/rescreen', { body: {} }); toast(`已重新初筛 ${r.rescreened} 人；按岗位备注复核 ${r.reviewed} 人，其中 ${r.widened} 人改为推荐 / 待确认`); }
    catch (e) { toast(e.message); }
    b.disabled = false; b.textContent = '保存并按新规则重新初筛全部';
  };
  $('#o-save').onclick = () => save({ org: orgBody(), autoReply: arBody() });
  $$('[data-go]', m).forEach(b => b.onclick = () => go(b.dataset.go));
  $('#r-re').onclick = async () => { await $('#r-save').onclick(); const r = await api('/settings/rescreen', { body: {} }); toast(`已按新规则重新初筛 ${r.rescreened} 人`); };
  $('#s-save').onclick = async () => {
    const am = list($('#s-am').value), pm = list($('#s-pm').value);
    if (![...am, ...pm].every(x => /^\d{2}:\d{2}$/.test(x))) return toast('时段格式应为 09:00');
    await api('/settings', { method: 'PUT', body: { schedule: { am, pm, cap: +$('#s-cap').value || 4, days: +$('#s-days').value || 5, weekdaysOnly: $('#s-wd').checked }, org: orgBody() } });
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
