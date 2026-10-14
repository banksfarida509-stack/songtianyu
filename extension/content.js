// Isolated-world content script: talks to the backend (through background.js),
// draws the AI line under each recommend card and the copilot panel.
// Chat page: every candidate message is classified by the backend, which then
// decides 全自动 / 半自动 / 转人工 (see decideMode in server/src/ai.js).
(() => {
  if (window.__hraIso) return;
  window.__hraIso = true;
  // After the extension is reloaded without refreshing the page, the old copy keeps
  // running next to the new one. The newest copy takes over; older ones go quiet.
  const INSTANCE = `${Date.now()}-${Math.random()}`;
  document.querySelectorAll('#hra-panel').forEach(p => p.remove());
  window.postMessage({ __hra: 'takeover', id: INSTANCE }, location.origin);
  window.addEventListener('message', e => {
    if (e.source === window && e.data?.__hra === 'takeover' && e.data.id !== INSTANCE) { S.dead = true; S.pending = null; panel.remove(); }
  });
  const VERSION = chrome.runtime.getManifest().version;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (path, body) => new Promise(res => chrome.runtime.sendMessage({ type: 'api', path, body }, r => res(r || { error: chrome.runtime.lastError?.message || '插件后台无响应' })));
  const toMain = (type, data = {}) => window.postMessage({ __hra: 'iso', type, ...data }, location.origin);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let reqSeq = 0;
  // ask the MAIN-world script to do something and wait for its answer
  const callMain = (type, data, resultType, timeout = 15000) => new Promise(ok => {
    const reqId = `${Date.now()}-${++reqSeq}`;
    const h = e => { const d = e.data; if (d?.__hra === 'main' && d.type === resultType && d.data?.reqId === reqId) { window.removeEventListener('message', h); ok(d.data); } };
    window.addEventListener('message', h);
    toMain(type, { ...data, reqId });
    setTimeout(() => { window.removeEventListener('message', h); ok({ ok: false, msg: '超时' }); }, timeout);
  });

  const S = {
    results: {}, job: '', err: '', risk: false, greeting: false, stop: false, confirmGreet: false, target: 10, done: 0, phase: '', log: [],
    chat: null, draft: null, decision: null, chatMode: null, candidateId: null, busy: false, collapsed: false, lastSuggestSig: '',
    auto: null, autoPaused: false, pending: null, sending: false, todo: [], handledAt: 0, userAt: 0, scanSkip: [],
    collecting: null, confirmCollect: false, quietNext: 0, gap: 3,
  };
  // pause between two greetings (seconds); the choice is remembered
  const GAPS = [[3, 5], [5, 7], [7, 10], [10, 15]];
  try { chrome.storage.local.get('greetGap').then(v => { if (Number.isInteger(v.greetGap)) S.gap = v.greetGap; }); } catch { /* default 10–15 s */ }
  const log = m => { S.log.unshift(`${new Date().toTimeString().slice(0, 8)} ${m}`); S.log = S.log.slice(0, 40); draw(); };
  const MODE_TXT = { auto: '全自动', semi: '半自动', human: '转人工' };

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.id = 'hra-panel';
  document.documentElement.appendChild(panel);
  // which recruiting site: 智联 (rd6.zhaopin.com) or BOSS直聘 (zhipin.com)
  const PLATFORM = /zhipin\.com$/.test(location.hostname) ? 'boss' : 'zhaopin';
  const SITE = PLATFORM === 'boss' ? 'BOSS直聘' : '智联';
  // BOSS pages embed iframes; the script runs in each of them. Only one panel per tab:
  // the 推荐牛人 iframe shows the recommend panel, the top page shows the chat panel,
  // and the top page steps aside whenever an inner frame already shows a panel.
  const IN_FRAME = window !== window.top;
  const childPanelShown = () => {
    if (IN_FRAME) return false;
    for (const f of document.querySelectorAll('iframe')) {
      try { const p = f.contentDocument && f.contentDocument.getElementById('hra-panel'); if (p && !p.hidden) return true; } catch { /* cross-origin frame */ }
    }
    return false;
  };
  const isRec = () => PLATFORM === 'zhaopin' ? location.pathname.includes('/app/recommend')
    : /recommend/.test(location.pathname) && (IN_FRAME || !document.querySelector('iframe[src*="recommend"], iframe[name*="recommend"]'));
  const isIm = () => PLATFORM === 'boss' ? !IN_FRAME && /chat/.test(location.pathname) && !/recommend/.test(location.pathname) : location.pathname.includes('/app/im');

  // ---------- panel position: drag the red title bar; double-click it to reset; remembered per site ----------
  const POS_KEY = `hraPanel_${PLATFORM}_${IN_FRAME ? 'frame' : 'top'}`;
  function placePanel() {
    const p = S.pos;
    if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
      const w = panel.offsetWidth || 320, h = panel.offsetHeight || 60;
      panel.style.left = Math.max(0, Math.min(p.left, window.innerWidth - Math.min(w, 120))) + 'px';
      panel.style.top = Math.max(0, Math.min(p.top, window.innerHeight - Math.min(h, 40))) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    } else { panel.style.left = panel.style.top = ''; panel.style.right = ''; panel.style.bottom = ''; }
  }
  const savePanel = () => { try { chrome.storage.local.set({ [POS_KEY]: { pos: S.pos || null, mini: !!S.mini } }); } catch { /* not saved */ } };
  try { chrome.storage.local.get(POS_KEY).then(v => { const o = v[POS_KEY] || {}; S.pos = o.pos || null; S.mini = !!o.mini; draw(); }); } catch { /* defaults */ }
  let drag = null;
  panel.addEventListener('mousedown', e => {
    const handle = e.target.closest('.hra-head, .hra-pill');
    if (!handle || e.target.closest('button:not(.hra-pill)') || e.button !== 0) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4) drag.moved = true;
    if (!drag.moved) return;
    S.pos = { left: e.clientX - drag.dx, top: e.clientY - drag.dy };
    placePanel();
  });
  window.addEventListener('mouseup', () => { if (drag && drag.moved) { savePanel(); panel.dataset.dragged = '1'; setTimeout(() => { delete panel.dataset.dragged; }, 0); } drag = null; });
  panel.addEventListener('dblclick', e => { if (e.target.closest('.hra-head') && !e.target.closest('button')) { S.pos = null; placePanel(); savePanel(); } });
  window.addEventListener('resize', () => placePanel());

  function rank() {
    // people no colleague has talked to come first; those a colleague already talked to go last
    return Object.entries(S.results).map(([uid, r]) => ({ uid, ...r })).filter(r => r.verdict === '推荐').sort((a, b) => (!!a.peer - !!b.peer) || b.score - a.score);
  }
  function draw() {
    if (S.dead) return;
    if (childPanelShown()) { panel.hidden = true; return; }
    if (PLATFORM === 'boss' && !isIm() && !isRec()) {
      if (IN_FRAME) { panel.hidden = true; return; } // other BOSS iframes: no panel
      panel.hidden = false;
      panel.classList.remove('mini');
      panel.innerHTML = `<div class="hra-head"><b>AI 招聘副驾</b><span>BOSS直聘</span></div><div class="hra-body"><p class="hra-muted">插件已加载。请打开 BOSS直聘的「沟通」聊天页或「推荐牛人」页。${S.err ? `<br><span style="color:#C4313B">${esc(S.err)}</span>` : ''}</p></div>`;
      placePanel();
      return;
    }
    if (!isRec() && !isIm()) { panel.hidden = true; return; }
    panel.hidden = false;
    // minimized: a small round button that can be dragged anywhere
    panel.classList.toggle('mini', !!S.mini);
    if (S.mini) { panel.innerHTML = `<button class="hra-pill" data-a="mini" title="展开 AI 招聘副驾（可拖动）">AI${S.todo.length ? `<i>${S.todo.length}</i>` : ''}</button>`; bind(); placePanel(); return; }
    const head = `<div class="hra-head" title="按住拖动；双击回到默认位置"><b>AI 招聘副驾</b><span>${SITE} · ${isRec() ? '推荐页 · 初筛' : '聊天页 · 约聊'}</span><button class="hra-x" data-a="toggle">${S.collapsed ? '展开' : '收起'}</button><button class="hra-x" data-a="mini" title="缩成小按钮">—</button></div>`;
    if (S.collapsed) { panel.innerHTML = head; bind(); placePanel(); return; }
    let body = '';
    if (S.err) body += `<div class="hra-err">${esc(S.err)}</div>`;
    if (S.outdated) body += `<div class="hra-err">插件版本 ${esc(VERSION)} 不是最新（最新 ${esc(S.outdated)}）。请到后台“设置”重新下载插件、解压覆盖原文件夹，再在 chrome://extensions 点刷新 ↻，然后刷新本页。</div>`;
    if (S.risk) body += `<div class="hra-err">检测到平台风控提示（验证 / 操作频繁），已停止所有自动动作，请人工处理。</div>`;
    if (isRec()) body += drawRec();
    if (isIm()) body += drawIm();
    body += `<details class="hra-log"><summary>动作日志</summary>${S.log.map(l => `<div>${esc(l)}</div>`).join('') || '<div>无</div>'}</details>`;
    const open = panel.querySelector('.hra-log')?.open;
    panel.innerHTML = head + `<div class="hra-body">${body}</div>`;
    if (open) panel.querySelector('.hra-log').open = true;
    bind();
    placePanel();
  }
  // BOSS top page: step aside as soon as an inner frame shows its panel (and come back if it goes away)
  if (PLATFORM === 'boss' && !IN_FRAME) setInterval(() => { const child = childPanelShown(); if (child && !panel.hidden) panel.hidden = true; else if (!child && panel.hidden && (isIm() || isRec())) draw(); }, 3000);
  function drawRec() {
    const all = Object.values(S.results);
    const n = v => all.filter(r => r.verdict === v).length;
    const rk = rank();
    let b = '';
    if (S.imAlive === false) b += `<div class="hra-err">自动回复没有运行：${SITE}「消息」页没有打开，候选人的消息不会被回复。<button class="hra-btn sm" data-a="open-im">打开消息页</button></div>`;
    b += `<div class="hra-stats"><div><b>${all.length}</b>已初筛</div><div><b>${n('推荐')}</b>推荐</div><div><b>${n('待确认')}</b>待确认</div><div><b>${n('不推荐')}</b>不推荐</div></div>`;
    b += `<div class="hra-sub">推荐顺序（${esc(S.job || '当前岗位')}${S.roleName ? ` · 按${esc(S.roleName)}岗规则初筛` : ''}）</div><div class="hra-rank">${rk.length ? rk.slice(0, 12).map(r => `<div class="hra-ri" data-uid="${esc(r.uid)}"><b>${r.score}</b><span>${esc(r.name || '')}<i>${esc(r.reason || '')}</i></span><em>${r.greeted ? '已打招呼' : r.peer ? '同事聊过' : ''}</em></div>`).join('') : '<p class="hra-muted">暂无推荐的人。滚动页面加载更多，插件会自动读取。</p>'}</div>`;
    const q = S.quota;
    const qTxt = q ? `今日${esc(q.roleName)}岗已打 ${q.used} / ${q.cap}` : '';
    b += S.greeting
      ? `<p class="hra-muted">正在${S.cont ? '持续' : ''}打招呼：本次 ${S.done}${S.cont ? '' : ` / ${S.target}`}${qTxt ? ` · ${qTxt}` : ''}${S.phase ? ' · ' + esc(S.phase) : ''}</p><button class="hra-btn" data-a="stop">停止打招呼</button>`
      : S.confirmGreet
        ? `<p class="hra-muted">按 AI 推荐顺序打招呼，当前页推荐 ${rk.filter(r => !r.greeted).length} 位未打招呼${rk.some(r => !r.greeted && r.peer) ? `（其中 ${rk.filter(r => !r.greeted && r.peer).length} 位同事聊过）` : ''}；先打同事没聊过的，不够时自动往下加载更多，实在没有了再打同事聊过的。会消耗平台打招呼次数。${qTxt ? `<br><b>${qTxt}</b>（上限在后台“设置 → 推荐页打招呼”修改）` : ''}</p>
           <div class="hra-row"><label class="hra-muted"><input type="checkbox" id="hra-cont" ${S.cont ? 'checked' : ''}> 持续打到今日上限（页面刷新后自动继续）</label></div>
           ${S.cont ? '' : `<div class="hra-row"><label class="hra-muted">本次打 <input id="hra-n" type="number" min="1" max="100" value="${S.target || 10}" style="width:56px"> 位</label></div>`}
           <div class="hra-muted">每位间隔</div><div class="hra-seg">${GAPS.map(([lo, hi], i) => `<button data-a="gap:${i}" class="${S.gap === i ? 'on' : ''}">${lo}–${hi} 秒</button>`).join('')}</div>
           ${S.gap === 0 ? '<p class="hra-muted" style="color:#B25E09">间隔越短，越容易触发平台“操作频繁”验证；出现验证会自动停止。</p>' : ''}
           <div class="hra-row"><button class="hra-btn pri" data-a="greet-go">确认开始</button><button class="hra-btn" data-a="greet-cancel">取消</button></div>`
        : `<button class="hra-btn pri" data-a="greet" ${rk.some(r => !r.greeted) && !S.risk ? '' : 'disabled'}>按推荐顺序打招呼</button>`;
    return b;
  }
  function drawIm() {
    const A = S.auto;
    let b = `<div class="hra-auto ${A?.enabled && !S.autoPaused ? 'on' : ''}"><span>全自动回复：<b>${!A ? '读取中' : !A.enabled ? '未开启' : S.autoPaused ? '已暂停' : '运行中'}</b></span>
      ${A?.enabled ? `<button class="hra-btn sm" data-a="pause">${S.autoPaused ? '恢复' : '暂停'}</button>` : ''}
      <i id="hra-patrol">${S.patrolNote ? `巡检：${esc(S.patrolNote)}` : ''}</i>
      <i>${A ? `本小时自动发送 ${A.sentLastHour || 0}/${A.maxPerHour || 0}` : ''}${A && !A.enabled ? ' · 在后台“设置 → 约聊回复方式”里打开' : ''} · <a href="#" data-a="kb">编辑知识库</a></i></div>`;
    if (PLATFORM === 'boss') b += '<div class="hra-err" style="background:#FDF2E3;color:#B25E09">BOSS直聘适配中：先只给回复建议，由你点“直接发送”。请点下方“复制诊断信息”发给技术支持，验证后开放全自动。</div>';
    const c = S.chat;
    if (!c) b += `<p class="hra-muted">打开一个会话，插件会读取最新消息，分类后按设置自动回复或给出建议。${PLATFORM === 'boss' ? '如果打开会话后这里没有变化，说明还没读到聊天内容，请发诊断信息。' : ''}</p>`;
    else {
      b += `<div class="hra-sub">${esc(c.name)} · ${esc(c.job || '')}</div>`;
      const sc = S.screen;
      if (sc && S.candidateId) {
        const cls = sc.verdict === '推荐' ? 'ok' : sc.verdict === '不推荐' ? 'no' : 'warn';
        b += `<div class="hra-muted"><span class="hra-tag ${cls}">初筛 ${esc(sc.verdict || '未知')}${sc.verdict === '推荐' ? ' ' + sc.score : ''}</span> ${sc.role ? `<b>${esc(sc.role)}岗</b> · ` : ''}${esc({ applied: '主动投递', greeted: '我方打招呼', unknown: '' }[sc.origin] || '')}${sc.hasResume ? '' : ' · 未读到简历'}<br>${esc(sc.reason || '')}</div>`;
      }
      if (S.candidateId) {
        b += `<div class="hra-seg" title="只对这个会话生效">${[[null, '按分类'], ['semi', '半自动'], ['auto', '全自动'], ['human', '转人工']].map(([v, t]) => `<button data-a="mode:${v ?? ''}" class="${(S.chatMode ?? null) === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;
      }
      const d = S.draft, dc = S.decision;
      if (S.busy) b += '<p class="hra-muted">AI 正在分类并生成回复…</p>';
      else if (!d) b += `<p class="hra-muted">${c.messages.length && c.messages[c.messages.length - 1].dir === 'in' ? '' : '等候选人回复。'}</p><button class="hra-btn" data-a="suggest">生成回复建议</button>`;
      else {
        const ck = (ok, t) => `<div class="hra-ck ${ok ? 'ok' : 'bad'}">${ok ? '通过' : '命中'} · ${esc(t)}</div>`;
        b += `<div class="hra-muted">分类：<b>${esc(d.intent)}</b>${d.topic && d.topic !== '其他' ? ` · ${esc(d.topic)}` : ''}${d.asked > 1 ? ` · <b style="color:#C4313B">第 ${d.asked} 遍</b>` : ''} → <span class="hra-mode ${dc?.mode || ''}">${esc(MODE_TXT[dc?.mode] || '半自动')}</span> ${esc(dc?.why || '')}</div>`;
        if ((d.sources || []).length) b += `<div class="hra-muted">参考：${[...new Set(d.sources.map(x => x.title))].map(esc).join('、')}</div>`;
        b += `<div class="hra-draft ${d.blocked ? 'bad' : ''}">${(d.parts || [d.reply]).map(esc).join('<hr>')}</div>`;
        b += ck(!d.checks.guard.length, '我方护栏' + (d.checks.guard.length ? '：' + d.checks.guard.join('、') : '')) + ck(!d.checks.platform.length, '平台拦截规则' + (d.checks.platform.length ? '：' + d.checks.platform.join('、') : ''));
        if (d.handoff) b += `<div class="hra-err">转人工：${esc(d.handoffWhy || '')}</div>`;
        if (d.action) b += `<div class="hra-act">需要在平台点「${esc(d.action)}」${d.slot ? `：${esc(d.slot.date)} ${esc(d.slot.slot)}` : ''}</div>`;
        if (d.resumeAsk) b += `<div class="hra-act">这条回复会顺带索要附件简历，发送后自动点平台「${PLATFORM === 'boss' ? '求简历' : '要附件简历'}」</div>`;
        if (d.sentAuto) b += `<p class="hra-ok">已自动发送 ✓</p>`;
        else if (S.pending) b += `<div class="hra-cd">将在 <b id="hra-cd">${Math.max(0, Math.ceil((S.pending.due - Date.now()) / 1000))}</b> 秒后自动发送</div><div class="hra-row"><button class="hra-btn pri" data-a="send-now">立即发送</button><button class="hra-btn" data-a="cancel-auto">取消，我来处理</button></div>`;
        else if (S.sending) b += '<p class="hra-muted">正在发送…</p>';
        else {
          b += `<div class="hra-row">${d.blocked ? '' : '<button class="hra-btn pri" data-a="send-now">直接发送</button><button class="hra-btn" data-a="fill">填入输入框</button>'}${d.action ? `<button class="hra-btn" data-a="native">点「${esc(d.action)}」</button>` : ''}</div>
            <div class="hra-row"><button class="hra-btn" data-a="applied">我已发送</button><button class="hra-btn" data-a="suggest">重新生成</button><button class="hra-btn" data-a="skip">不回复</button></div>`;
        }
      }
    }
    // collect past conversations for the knowledge base (read only)
    if (S.collecting) b += `<div class="hra-cd">正在采集历史约聊：${S.collecting.done}/${S.collecting.total} ${esc(S.collecting.name || '')}</div><button class="hra-btn" data-a="collect-stop">停止采集</button>`;
    else if (S.confirmCollect) b += `<p class="hra-muted">将依次打开最近的会话，读取聊天记录交给后台，用来整理候选人常问的问题（薪资、待遇、作息等）。只读取，不发送任何消息；有未读消息的会话会跳过，以免被标成已读。</p>
      <div class="hra-row"><label class="hra-muted">最近 <input id="hra-hn" type="number" min="5" max="50" value="30" style="width:56px"> 个会话</label></div>
      <div class="hra-row"><button class="hra-btn pri" data-a="collect-go">开始采集</button><button class="hra-btn" data-a="collect-cancel">取消</button></div>`;
    else b += `<div class="hra-row"><button class="hra-btn" data-a="collect">采集历史约聊（学习话术）</button><button class="hra-btn" data-a="diag">复制诊断信息</button></div>`;
    if (S.todo.length) {
      b += `<div class="hra-sub">待你处理（${S.todo.length}）</div><div class="hra-rank">${S.todo.map(t => `<div class="hra-ri" data-open="${esc(t.sessionId)}"><b>${esc(MODE_TXT[t.mode] || '')}</b><span>${esc(t.name)}<i>${esc(t.why)}</i></span><em>${esc(t.at)}</em></div>`).join('')}</div>`;
    }
    return b;
  }
  function bind() {
    panel.querySelectorAll('[data-a]').forEach(b => b.onclick = e => { e.preventDefault(); act(b.dataset.a); });
    const nIn = panel.querySelector('#hra-n');
    if (nIn) nIn.oninput = () => { S.target = parseInt(nIn.value, 10) || S.target; };
    const cIn = panel.querySelector('#hra-cont');
    if (cIn) cIn.onchange = () => { S.cont = cIn.checked; S.contTouched = true; draw(); };
    panel.querySelectorAll('.hra-ri[data-uid]').forEach(el => el.onclick = () => {
      const card = document.querySelector(`[data-hra-uid="${CSS.escape(el.dataset.uid)}"]`);
      card && card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    panel.querySelectorAll('.hra-ri[data-open]').forEach(el => el.onclick = async () => {
      const r = await callMain('open', { id: el.dataset.open }, 'openResult');
      if (!r.ok) log(r.msg);
    });
  }
  async function act(a) {
    if (a === 'toggle') { S.collapsed = !S.collapsed; return draw(); }
    if (a === 'mini') { if (panel.dataset.dragged) return; S.mini = !S.mini; savePanel(); return draw(); }
    if (a === 'open-im') { chrome.runtime.sendMessage({ type: 'openIm', platform: PLATFORM }, () => void chrome.runtime.lastError); log('正在打开消息页（固定在标签栏最左边）'); return; }
    if (a === 'greet') { S.confirmGreet = true; draw(); return loadQuota(); }
    if (a === 'greet-cancel') { S.confirmGreet = false; return draw(); }
    if (a.startsWith('gap:')) {
      S.gap = Math.max(0, Math.min(GAPS.length - 1, +a.slice(4)));
      try { chrome.storage.local.set({ greetGap: S.gap }); } catch { /* remembered for this page only */ }
      return draw();
    }
    if (a === 'greet-go') {
      const q = await loadQuota();
      if (q && q.left <= 0) { S.confirmGreet = false; log(`今日${q.roleName}岗打招呼已达上限 ${q.cap} 位，明天再继续`); return; }
      if (!S.cont) {
        const n = parseInt(panel.querySelector('#hra-n')?.value, 10);
        S.target = Math.max(1, Math.min(100, n || 10));
      }
      S.confirmGreet = false; return greetLoop();
    }
    if (a === 'stop') { S.stop = true; setGreetRun(null); return; }
    if (a === 'suggest') return suggest(true);
    if (a === 'kb') { chrome.runtime.sendMessage({ type: 'openOptions' }); return; }
    if (a === 'collect') { S.confirmCollect = true; return draw(); }
    if (a === 'diag') {
      const r = await callMain('diagnose', {}, 'diagResult');
      const text = JSON.stringify({ version: VERSION, chat: r.data, inviteShape: S.inviteShape || null }, null, 1);
      api('/ext/diag', { kind: 'chat', data: JSON.parse(text) });
      try { await navigator.clipboard.writeText(text); log('诊断信息已复制，可以直接粘贴给技术支持'); } catch { log('诊断信息已上传到后台（复制到剪贴板失败）'); }
      return;
    }
    if (a === 'collect-cancel') { S.confirmCollect = false; return draw(); }
    if (a === 'collect-stop') { toMain('historyStop'); return; }
    if (a === 'collect-go') { const n = parseInt(panel.querySelector('#hra-hn')?.value, 10) || 30; S.confirmCollect = false; return collectHistory(Math.max(5, Math.min(50, n))); }
    if (a === 'pause') { S.autoPaused = !S.autoPaused; if (S.autoPaused) cancelPending('已暂停全自动'); log(S.autoPaused ? '本页已暂停全自动回复' : '本页已恢复全自动回复'); return; }
    if (a.startsWith('mode:') && S.candidateId) {
      const mode = a.slice(5) || null;
      const r = await api('/ext/chat/mode', { candidateId: S.candidateId, mode });
      if (r.error) return log('设置失败：' + r.error);
      S.chatMode = mode; log(`本会话改为：${mode ? MODE_TXT[mode] : '按分类'}`);
      return suggest(true);
    }
    if (a === 'fill' && S.draft) { toMain('fill', { text: S.draft.reply }); return; }
    if (a === 'native' && S.draft?.action) { toMain('native', { name: S.draft.action }); return; }
    if (a === 'send-now' && S.draft) { S.pending = null; return sendDraft(false); }
    if (a === 'cancel-auto') { cancelPending('已取消自动发送，改为你来处理'); addTodo('semi', '你取消了自动发送'); return; }
    if (a === 'skip') { doneTodo(); S.draft = null; S.handledAt = Date.now(); log('本条不回复'); return draw(); }
    if (a === 'applied' && S.draft && S.candidateId) {
      const r = await api('/ext/chat/applied', { candidateId: S.candidateId, draft: S.draft });
      log(r.error ? '写入失败：' + r.error : `已写入人才池：${r.data.candidate.attend}`);
      doneTodo(); S.draft = null; S.handledAt = Date.now(); draw();
    }
  }

  // ---------- recommend: screen + AI reasons + inline lines ----------
  async function onCards(cards, job) {
    S.job = job || S.job;
    const fresh = cards.filter(c => !S.results[c.resumeNumber]);
    if (!fresh.length) return paintLines();
    const r = await api('/ext/screen', { platform: PLATFORM, job: S.job, cards: fresh });
    if (r.error) { S.err = r.error; return draw(); }
    S.err = '';
    if (r.data.role) S.roleName = r.data.role.name;
    const names = Object.fromEntries(cards.map(c => [c.resumeNumber, c.userName]));
    for (const x of r.data.results) S.results[x.uid] = { ...x, name: names[x.uid] };
    log(`读取 ${fresh.length} 张卡片并初筛`);
    paintLines(); draw();
    if (S.quotaJob !== S.job) { S.quotaJob = S.job; loadQuota(); }
    maybeResumeGreet();
    const need = r.data.results.filter(x => x.reasonBy !== 'ai').map(x => x.uid);
    if (need.length) {
      const rr = await api('/ext/reasons', { platform: PLATFORM, uids: need });
      if (rr.data?.reasons) { for (const [k, v] of Object.entries(rr.data.reasons)) if (S.results[k]) { S.results[k].reason = v; S.results[k].reasonBy = 'ai'; } }
      // verdicts widened by the review against the role's notes
      let widened = 0;
      for (const [k, v] of Object.entries(rr.data?.verdicts || {})) if (S.results[k]) {
        if (S.results[k].verdict !== v.verdict && v.verdict !== '不推荐') widened++;
        Object.assign(S.results[k], { verdict: v.verdict, score: v.score, reason: v.reason, reasonBy: 'ai' });
      }
      if (widened) log(`按岗位备注复核：${widened} 人改为推荐 / 待确认`);
      paintLines(); draw();
    }
  }
  function paintLines() {
    for (const [uid, r] of Object.entries(S.results)) {
      const el = document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
      if (!el) continue;
      let line = el.querySelector(':scope > .hra-line');
      if (!line) { line = document.createElement('div'); line.className = 'hra-line'; el.appendChild(line); }
      const cls = r.verdict === '推荐' ? 'ok' : r.verdict === '待确认' ? 'warn' : 'no';
      const html = `<span class="hra-tag ${cls}">AI ${esc(r.verdict)}</span>${r.verdict !== '不推荐' ? `<b>${r.score} 分</b>` : ''}<span class="hra-why">${esc(r.reason)}</span>${r.reasonBy === 'ai' ? '<span class="hra-src">AI</span>' : ''}${r.greeted ? '<span class="hra-tag no">已打招呼</span>' : ''}${r.peer && !r.greeted ? `<span class="hra-tag warn" title="${esc(r.peer)}">同事聊过 · 最后打</span>` : ''}`;
      if (line.innerHTML !== html) line.innerHTML = html;
      el.classList.toggle('hra-v-ok', cls === 'ok'); el.classList.toggle('hra-v-warn', cls === 'warn'); el.classList.toggle('hra-v-no', cls === 'no');
    }
  }
  // today's greeting count and cap for this platform and the job's role (from the server)
  async function loadQuota() {
    const r = await api('/ext/greet/quota', { platform: PLATFORM, job: S.job });
    if (r.data) {
      S.quota = r.data;
      if (!S.contTouched) S.cont = r.data.continuous;
      draw();
    }
    return S.quota || null;
  }
  // a continuous run survives page refreshes / reloads: remembered per platform for today
  const RUN_KEY = `greetRun_${PLATFORM}`;
  const today = () => new Date().toLocaleDateString('sv-SE');
  const setGreetRun = v => { try { v ? chrome.storage.local.set({ [RUN_KEY]: { ...v, day: today() } }) : chrome.storage.local.remove(RUN_KEY); } catch { /* not remembered */ } };
  let resumeChecked = false;
  async function maybeResumeGreet() {
    if (resumeChecked || S.greeting || S.dead || !isRec() || !rank().length) return;
    resumeChecked = true;
    let run = null;
    try { run = (await chrome.storage.local.get(RUN_KEY))[RUN_KEY]; } catch { return; }
    if (!run || run.day !== today()) return;
    const q = await loadQuota();
    if (!q || q.left <= 0) return setGreetRun(null);
    S.cont = true; S.contTouched = true;
    log('上次的持续打招呼还没打完，10 秒后自动继续（点“停止打招呼”可取消）');
    S.greeting = true; S.phase = '10 秒后继续'; draw();
    for (let t = 0; t < 10000 && !S.stop; t += 500) await sleep(500);
    S.greeting = false;
    if (S.stop) { S.stop = false; setGreetRun(null); log('已取消自动继续'); return draw(); }
    greetLoop();
  }
  // Greets recommended candidates in rank order: S.target of them, or in continuous mode
  // until today's cap for the role. When the loaded list runs out it asks the page to
  // load more (up to 4 tries without new 推荐).
  async function greetLoop() {
    S.greeting = true; S.stop = false; S.done = 0; S.phase = ''; draw();
    if (S.cont) setGreetRun({ at: Date.now() });
    const skip = new Set();
    let dry = 0, why = '', fails = 0, away = 0, peerOk = false;
    const onPage = uid => !!document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
    const goal = () => S.cont ? Infinity : S.target;
    while (S.done < goal() && !S.stop && !S.risk && !S.dead) {
      if (S.quota && S.quota.left <= 0) { why = `今日${S.quota.roleName}岗打招呼已达上限 ${S.quota.cap} 位`; break; }
      // a greeting sometimes takes 智联 to another page: go back to the recommend list and continue
      if (!isRec()) {
        if (PLATFORM !== 'zhaopin' || ++away > 3) { why = '页面离开了推荐列表'; break; }
        S.phase = '回到推荐列表…'; draw();
        history.back();
        for (let t = 0; t < 5000 && !S.stop; t += 500) await sleep(500);
        continue;
      }
      away = 0;
      // first only people no colleague has talked to; once the list (after loading more) has
      // none of those left, the ones a colleague already talked to
      const r = rank().find(x => !x.greeted && !skip.has(x.uid) && onPage(x.uid) && (peerOk || !x.peer));
      if (!r) {
        if (++dry > 4) {
          if (!peerOk && rank().some(x => !x.greeted && x.peer)) { peerOk = true; dry = 0; log('同事没聊过的推荐人选已打完，开始给同事聊过的人打招呼'); continue; }
          why = '当前岗位已没有更多 AI 推荐的候选人'; break;
        }
        S.phase = '加载更多候选人…'; draw();
        toMain('more');
        for (let t = 0; t < 6000 && !S.stop; t += 500) await sleep(500);
        continue;
      }
      dry = 0; S.phase = `正在给 ${r.name} 打招呼`; draw();
      document.querySelector(`[data-hra-uid="${CSS.escape(r.uid)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(1200);
      const res = await new Promise(ok => { const h = e => { if (e.data?.__hra === 'main' && e.data.type === 'greetResult' && e.data.data.uid === r.uid) { window.removeEventListener('message', h); ok(e.data.data); } }; window.addEventListener('message', h); toMain('greet', { uid: r.uid }); setTimeout(() => ok({ ok: false, msg: '超时' }), 12000); });
      log(`${r.name}：${res.msg}`);
      if (res.ok) {
        S.results[r.uid].greeted = true;
        if (!/已沟通过/.test(res.msg)) {
          S.done++; fails = 0;
          const g = await api('/ext/greeted', { platform: PLATFORM, uid: r.uid, name: r.name, job: S.job });
          if (g.data?.quota) S.quota = g.data.quota;
        }
        paintLines(); draw();
      }
      else skip.add(r.uid);
      if (res.dialog) { S.stop = true; why = '平台弹出窗口，需要人工处理（见上一条日志）'; break; }
      if (res.unverified && ++fails >= 3) { S.stop = true; why = '连续 3 位未确认成功，请看页面是否有提示'; break; }
      if (S.done >= goal() || (S.quota && S.quota.left <= 0)) continue; // the loop head ends the run with the reason
      // nothing was sent (already contacted / card gone): move on without the pause
      if (/已沟通过/.test(res.msg) || (!res.ok && !res.unverified)) continue;
      const [lo, hi] = GAPS[S.gap] || GAPS[3];
      const wait = (lo + Math.random() * (hi - lo)) * 1000;
      S.phase = `等待 ${Math.round(wait / 1000)} 秒后继续`; draw();
      for (let t = 0; t < wait && !S.stop && !S.risk; t += 500) await sleep(500);
    }
    S.greeting = false; S.phase = '';
    const end = S.risk ? '因平台风控提示停止' : why ? `停止：${why}（本次成功 ${S.done} 位）` : S.stop ? `已手动停止（本次成功 ${S.done} 位）` : `完成：本次成功打招呼 ${S.done} 位`;
    log(end);
    // a continuous run is resumed after a refresh only when it was interrupted, not when it ended
    if (S.stop || S.risk || why) setGreetRun(null);
    if (!S.cont) setGreetRun(null);
    api('/ext/diag', { kind: 'greet', data: { version: VERSION, platform: PLATFORM, job: S.job, cont: !!S.cont, done: S.done, quota: S.quota || null, end, log: S.log.slice(0, 15) } });
    draw();
  }

  // ---------- chat: classify → 全自动 / 半自动 / 转人工 ----------
  const chatSig = c => c ? c.sessionId + ':' + (c.messages.length ? c.messages[c.messages.length - 1].id : '') : '';
  function addTodo(mode, why) {
    const c = S.chat; if (!c) return;
    S.todo = [{ sessionId: c.sessionId, name: c.name, mode, why, at: new Date().toTimeString().slice(0, 5) }, ...S.todo.filter(t => t.sessionId !== c.sessionId)].slice(0, 30);
  }
  function addTodoFor(sessionId, why) {
    const name = (why.match(/「(.+?)」/) || [])[1] || '';
    S.todo = [{ sessionId, name, mode: 'human', why: '插件打不开这个会话，请手动点开', at: new Date().toTimeString().slice(0, 5) }, ...S.todo.filter(t => t.sessionId !== sessionId)].slice(0, 30);
  }
  function doneTodo() { if (S.chat) S.todo = S.todo.filter(t => t.sessionId !== S.chat.sessionId); }
  function cancelPending(msg) { if (S.pending) { S.pending = null; if (msg) log(msg); } draw(); }

  // one reply generation at a time; a request that arrives meanwhile runs right after
  let suggestQueued = null;
  const aiRetries = new Map();
  async function suggest(force = false) {
    if (S.dead) return;
    if (S.busy) { suggestQueued = suggestQueued || force; return; }
    const c = S.chat;
    if (!c) return;
    const last = c.messages[c.messages.length - 1];
    const sig = chatSig(c);
    if (!force && (sig === S.lastSuggestSig || !last || last.dir !== 'in')) {
      // say once why this conversation is left alone
      if (sig !== S.lastSuggestSig && sig !== S.noReplySig) {
        S.noReplySig = sig;
        log(`${c.name || '当前会话'}：${!last ? '读不到聊天内容，跳过' : '最后一条是我方消息，等对方回复'}`);
      }
      return draw();
    }
    S.lastSuggestSig = sig; S.busy = true; S.draft = null; S.decision = null; S.pending = null; draw();
    const r = await api('/ext/chat/suggest', { platform: PLATFORM, sessionId: c.sessionId, uid: c.uid, name: c.name, job: c.job, origin: c.origin, profile: c.profile, phones: c.phones || [], messages: c.messages });
    S.busy = false;
    if (suggestQueued !== null) { const f = suggestQueued; suggestQueued = null; if (chatSig(S.chat) !== sig || f) return suggest(f); }
    if (chatSig(S.chat) !== sig) return; // conversation moved on while waiting
    if (r.error) { S.err = r.error; return draw(); }
    S.err = ''; S.draft = r.data.draft; S.decision = r.data.decision; S.chatMode = r.data.chatMode; S.candidateId = r.data.candidateId; S.screen = r.data.screen;
    S.handledAt = Date.now();
    // BOSS直聘: page reading is not verified yet, so nothing is sent automatically there
    if (PLATFORM === 'boss' && S.decision?.mode === 'auto') S.decision = { mode: 'semi', why: 'BOSS直聘适配验证中，先由你确认后点“直接发送”' };
    const dc = S.decision || { mode: 'semi', why: '' };
    log(`${c.name}：${S.draft.intent} → ${MODE_TXT[dc.mode]}（${dc.why}）`);
    // the AI failed for a moment: try again (twice) instead of falling back for good
    if (S.draft.byAi === false) {
      const n = (aiRetries.get(sig) || 0) + 1; aiRetries.set(sig, n);
      log(`AI 生成失败${S.draft.aiError ? '：' + S.draft.aiError : ''}${n <= 2 ? `，${n * 8} 秒后重试` : ''}`);
      if (n <= 2) { setTimeout(() => { if (chatSig(S.chat) === sig && !S.sending) suggest(true); }, n * 8000); }
    }
    if (dc.mode === 'auto' && S.auto?.enabled && !S.autoPaused && !S.risk) {
      S.pending = { sig, due: Date.now() + (dc.delayMs || 30000) };
      const mine = S.pending;
      setTimeout(() => { if (S.pending === mine) { S.pending = null; sendDraft(true); } }, dc.delayMs || 30000);
    } else if (dc.mode === 'human') {
      addTodo('human', dc.why);
      api('/ext/chat/applied', { candidateId: S.candidateId, draft: { intent: S.draft.intent, handoff: true, handoffWhy: dc.why } });
    } else addTodo('semi', `${S.draft.intent}：${dc.why}`);
    draw();
  }

  async function sendDraft(auto) {
    if (S.dead) return;
    const d = S.draft, sig = S.lastSuggestSig;
    if (!d || d.blocked || S.sending) return;
    if (auto && (chatSig(S.chat) !== sig || S.autoPaused || S.risk)) return log('会话有变化，取消自动发送');
    S.sending = true; draw();
    // two pages on the same conversation (a second 消息 tab, a colleague): only one may answer
    if (auto) {
      const cl = await api('/ext/chat/claim', { candidateId: S.candidateId, sig, by: INSTANCE });
      if (cl.data && cl.data.ok === false) { S.sending = false; d.sentAuto = true; log(`${S.chat?.name || ''}：${cl.data.why}，这里不再发送`); S.handledAt = Date.now(); return draw(); }
    }
    const parts = d.parts && d.parts.length ? d.parts : [d.reply];
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (i) await sleep(1500 + Math.random() * 2500);
      const r = await callMain('send', { text: parts[i] }, 'sendResult', 30000);
      if (!r.ok) { ok = false; log(`${S.chat?.name || ''}：发送失败（${r.msg}）`); break; }
    }
    S.sending = false;
    if (!ok) { addTodo('semi', '自动发送失败，请手动发'); return draw(); }
    const r = await api('/ext/chat/applied', { candidateId: S.candidateId, draft: d, auto });
    d.sentAuto = true; doneTodo();
    // time agreed → send the platform's interview invitation automatically
    if (d.action === '约面试' && d.slot && S.auto?.autoInvite && auto) {
      await sleep(2000 + Math.random() * 2000);
      const iv = await callMain('invite', { date: d.slot.date, slot: d.slot.slot, place: S.auto.place || '' }, 'inviteResult', 30000);
      log(`${S.chat?.name || ''}：${iv.msg}`);
      api('/ext/chat/invited', { candidateId: S.candidateId, ok: !!iv.ok, msg: iv.msg, shape: iv.shape || null });
      if (!iv.ok) addTodo('semi', `面试邀约没自动发出：${iv.msg}`);
    } else if (d.action) addTodo('semi', `已回复，需要你点「${d.action}」${d.slot ? ` ${d.slot.date} ${d.slot.slot}` : ''}`);
    // the reply asked for the attachment resume → also press the platform's request button
    if (d.resumeAsk) {
      await sleep(1500 + Math.random() * 1500);
      const rr = await callMain('askResume', {}, 'resumeResult', 15000);
      log(`${S.chat?.name || ''}：${rr.msg}`);
      api('/ext/chat/resume', { candidateId: S.candidateId, ok: !!rr.ok, msg: rr.msg });
      if (!rr.ok) addTodo('semi', `附件简历请求没发出：${rr.msg}`);
    }
    log(`${S.chat?.name || ''}：${auto ? '已全自动回复' : '已发送'}${r.error ? '（写入人才池失败：' + r.error + '）' : ''}`);
    S.handledAt = Date.now();
    if (S.auto) S.auto.sentLastHour = (S.auto.sentLastHour || 0) + (auto ? 1 : 0);
    draw();
  }

  async function collectHistory(max) {
    cancelPending();
    S.collecting = { done: 0, total: max, name: '' }; draw();
    const r = await callMain('history', { max }, 'historyResult', max * 15000);
    S.collecting = null; S.quietNext = Date.now(); // don't answer whatever conversation the collection ended on
    if (!r.ok) { log(`采集失败：${r.msg}`); return draw(); }
    let conv = 0, msgs = 0;
    for (let i = 0; i < r.sessions.length; i += 10) {
      const up = await api('/ext/chat/history', { platform: PLATFORM, sessions: r.sessions.slice(i, i + 10) });
      if (up.error) { log(`上传失败：${up.error}`); break; }
      conv += up.data.conversations; msgs += up.data.newMessages;
    }
    log(`采集完成：${conv} 个会话，新增 ${msgs} 条消息${r.skipped ? `，跳过 ${r.skipped} 个（有未读或未找到）` : ''}。到后台“知识库 → 从历史约聊学习”生成常见问题`);
    draw();
  }

  // full-auto patrol: open the next conversation with unread messages when idle
  // ---------- proactive follow-ups (打招呼久未回 / 已读不回) ----------
  let lastFollowCheck = 0;
  const followSkip = new Map(); // candidateId → retry after (ms)
  async function tryFollowup() {
    if (Date.now() - lastFollowCheck < 120000) return false;
    lastFollowCheck = Date.now();
    const r = await api('/ext/followups', { platform: PLATFORM });
    const due = (r.data?.due || []).filter(x => !(followSkip.get(x.candidateId) > Date.now()));
    if (!due.length) return false;
    const f = due[0];
    followSkip.set(f.candidateId, Date.now() + 15 * 60000); // whatever happens, not again for 15 min
    const what = f.kind === 'greet' ? '打招呼后未回复' : '已读未回复';
    note(`跟进：${f.name}（${what}）`);
    const o = await callMain('openBy', { uid: f.uid, name: f.name }, 'openResult', 30000);
    if (!o.ok) { log(`跟进 ${f.name}：${o.msg}`); return true; }
    await sleep(2500);
    const rs = await callMain('readState', {}, 'readStateResult');
    if (rs.name && f.name && rs.name !== f.name) { log(`跟进 ${f.name}：没切换到这个会话，跳过`); return true; }
    if (rs.lastDir !== 'out') { log(`跟进 ${f.name}：对方已有新消息，按正常流程回复`); return true; }
    const d = await api('/ext/followup/draft', { candidateId: f.candidateId, kind: f.kind, messages: rs.messages || [], lastOutRead: rs.read });
    if (d.error) { log(`跟进 ${f.name}：${d.error}`); return true; }
    if (d.data.skip) { log(`跟进 ${f.name}：${d.data.why}`); return true; }
    S.draft = d.data.draft; S.decision = d.data.decision; S.candidateId = d.data.candidateId;
    S.lastSuggestSig = chatSig(S.chat); S.handledAt = Date.now();
    const dc = S.decision || { mode: 'semi', why: '' };
    log(`${f.name}：${what} → 跟进（${MODE_TXT[dc.mode]}）`);
    if (dc.mode === 'auto' && S.auto?.enabled && !S.autoPaused && !S.risk) {
      S.pending = { sig: S.lastSuggestSig, due: Date.now() + Math.min(dc.delayMs || 15000, 20000) };
      const mine = S.pending;
      setTimeout(() => { if (S.pending === mine) { S.pending = null; sendDraft(true); } }, mine.due - Date.now());
    } else addTodo(dc.mode === 'human' ? 'human' : 'semi', `跟进（${what}）：${dc.why}`);
    draw();
    return true;
  }

  // why the patrol is (not) moving, shown on the panel
  const note = t => {
    if (S.patrolNote === t) return;
    S.patrolNote = t;
    const el = panel.querySelector('#hra-patrol');
    if (el) el.textContent = `巡检：${t}`; else draw();
  };
  let patrolling = false;
  async function patrol() {
    if (S.dead || patrolling) return;
    patrolling = true;
    try { await patrolOnce(); } finally { patrolling = false; }
  }
  async function patrolOnce() {
    const A = S.auto;
    if (!isIm()) return;
    if (!A?.enabled) return note('全自动未开启，不自动打开未读会话');
    if (A.scanUnread === false) return note('后台设置里关闭了“自动打开有未读消息的会话”');
    if (S.autoPaused) return note('已暂停');
    if (S.risk) return note('平台风控提示，已停止');
    if (S.collecting) return note('正在采集历史约聊');
    if (S.busy) return note('AI 正在写回复…');
    if (S.pending) return note('等待自动发送当前回复');
    if (S.sending) return note('正在发送…');
    // a conversation just opened whose messages are still loading: stay on it (up to 12 s), or it is skipped for good
    if (S.openedAt && Date.now() - S.openedAt < 15000 && (!S.chat || !S.chat.messages.length || S.chat.sessionId === S.openedFrom)) { toMain('tick'); return note('等待聊天内容和简历加载…'); }
    const idle = Math.ceil((20000 - (Date.now() - S.userAt)) / 1000);
    if (idle > 0) return note(`你正在操作页面，${idle} 秒后继续巡检`);
    const waitingOnYou = S.draft && !S.draft.sentAuto && S.decision?.mode !== 'auto';
    const left = Math.ceil(((waitingOnYou ? 60000 : 6000) - (Date.now() - S.handledAt)) / 1000);
    if (left > 0) return note(waitingOnYou ? `当前会话的建议等你处理，${left} 秒后先去处理其他未读` : `${left} 秒后查找下一个未读会话`);
    note('正在查找未读会话…');
    const from = S.chat ? S.chat.sessionId : null;
    const r = await callMain('nextUnread', { skip: S.scanSkip }, 'openResult', 30000);
    if (r.ok) S.openedFrom = from;
    // watchdog input: unread shown on the page but none could be picked up
    if (r.ok) { S.unreadStuckSince = 0; W.resets = 0; S.openedAt = Date.now(); }
    else if (r.none) { if ((r.badges || 0) > 0 || (r.unread || 0) > 0) S.unreadStuckSince = S.unreadStuckSince || Date.now(); else S.unreadStuckSince = 0; }
    if (r.ok) { log(r.msg); note(r.msg); }
    else if (r.failed && r.id) {
      // could not switch to it: skip for 10 minutes instead of retrying every 15 s
      S.scanSkip.push(r.id); setTimeout(() => { S.scanSkip = S.scanSkip.filter(x => x !== r.id); }, 600000);
      addTodoFor(r.id, r.msg); log(r.msg); note(r.msg);
    } else if (r.none) {
      // nothing unread: time for follow-ups on silent conversations
      if (await tryFollowup()) return;
      const t = `没有未读会话（读到会话 ${r.sessions ?? '?'} 个、红色角标 ${r.badges ?? '?'} 个）`;
      note(t);
      if (t !== S.lastNoneLog) { S.lastNoneLog = t; log(`巡检：${t}`); }
    }
    else { log(r.msg); note(r.msg); }
  }
  ['mousedown', 'keydown', 'wheel'].forEach(t => document.addEventListener(t, e => { if (e.isTrusted && !panel.contains(e.target)) S.userAt = Date.now(); }, true));

  // ---------- messages from MAIN world ----------
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__hra !== 'main' || e.source !== window) return;
    if (d.type === 'recommend') onCards(d.data.cards, d.data.job);
    if (d.type === 'inviteShape') { S.inviteShape = d.data; api('/ext/diag', { kind: 'invite', data: d.data }); log('已记录你发面试邀约的窗口结构，用于完善自动邀约'); }
    if (d.type === 'historyProgress' && S.collecting) { Object.assign(S.collecting, { done: d.data.done, total: d.data.total, name: d.data.name }); draw(); }
    if (d.type === 'chat' && S.collecting) return;
    if (d.type === 'chat' && S.quietNext && Date.now() - S.quietNext < 6000) {
      S.quietNext = false; S.chat = d.data; S.draft = null; S.decision = null; S.candidateId = null;
      S.lastSuggestSig = chatSig(d.data); S.handledAt = Date.now(); return draw();
    }
    if (d.type === 'chat') {
      const changed = !S.chat || S.chat.sessionId !== d.data.sessionId;
      // the resume turned up after the reply was drafted (and it is not sent yet): judge again with it
      const lateResume = !changed && d.data.profile && !S.chat.profile && chatSig(d.data) === S.lastSuggestSig && !S.sending && !(S.draft && S.draft.sentAuto)
        && d.data.messages.length && d.data.messages[d.data.messages.length - 1].dir === 'in';
      if (S.pending && chatSig(d.data) !== S.pending.sig) {
        if (changed) addTodo('semi', '自动回复被打断（切换了会话）');
        S.pending = null;
      }
      S.chat = d.data;
      // record a mobile number the page shows for this candidate (once per conversation and number)
      const phoneSig = `${d.data.sessionId}:${(d.data.phones || []).join(',')}`;
      if ((d.data.phones || []).length && S.phoneSig !== phoneSig) {
        S.phoneSig = phoneSig;
        api('/ext/chat/phones', { platform: PLATFORM, sessionId: d.data.sessionId, uid: d.data.uid, name: d.data.name, job: d.data.job, phones: d.data.phones });
      }
      if (changed) { S.draft = null; S.decision = null; S.chatMode = null; S.candidateId = null; S.screen = null; }
      if (lateResume) { S.pending = null; log(`${d.data.name || ''}：读到简历了，按简历重新判断`); suggest(true); }
      else suggest(false);
    }
    if (d.type === 'actionResult') log(d.data.msg);
    if (d.type === 'resumeShape') api('/ext/diag', { kind: 'resume', data: { version: VERSION, platform: PLATFORM, ...d.data } });
    if (d.type === 'risk' && !S.risk) { S.risk = true; S.stop = true; S.pending = null; log('检测到平台风控提示，已停止'); draw(); }
    if (d.type === 'error') console.debug('[hra]', d.data.msg);
  });

  // keep lines alive when the page re-renders; countdown; heartbeat
  setInterval(() => { if (isRec()) paintLines(); }, 2000);
  setInterval(() => { const el = panel.querySelector('#hra-cd'); if (el && S.pending) el.textContent = Math.max(0, Math.ceil((S.pending.due - Date.now()) / 1000)); }, 1000);
  setInterval(patrol, 5000);
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; S.draft = null; S.chat = null; S.pending = null; draw(); toMain('reread'); } }, 1000);
  // ---------- version alignment ----------
  const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  function checkVersion(latest) {
    if (!latest || !newer(latest, VERSION) || S.outdated === latest) return;
    S.outdated = latest;
    chrome.runtime.sendMessage({ type: 'selfUpdate', target: latest }, r => {
      if (r && r.started) log(`发现新版插件 ${latest}，正在自动更新并刷新页面…`);
      else { log(`插件版本 ${VERSION} 不是最新（${latest}），需要重新下载插件`); draw(); }
    });
  }

  // ---------- watchdog: keep the automation moving, report when it stalls ----------
  const W = { busySince: 0, patrolSince: 0, resets: 0 };
  async function report(kind, extra) {
    let page = null;
    try { page = (await callMain('diagnose', {}, 'diagResult', 8000)).data; } catch { /* page data optional */ }
    api('/ext/diag', { kind, data: { version: VERSION, platform: PLATFORM, path: location.pathname, frame: window !== window.top,
      state: { busy: S.busy, pending: !!S.pending, sending: S.sending, collecting: !!S.collecting, autoPaused: S.autoPaused, risk: S.risk, auto: S.auto, patrolNote: S.patrolNote, chat: S.chat ? { name: S.chat.name, n: S.chat.messages.length, lastDir: S.chat.messages.at(-1)?.dir } : null },
      log: S.log.slice(0, 20), page, ...extra } });
  }
  setInterval(async () => {
    if (S.dead) return;
    const now = Date.now();
    // an API call or a send that never came back
    if (S.busy) { W.busySince = W.busySince || now; if (now - W.busySince > 90000) { S.busy = false; W.busySince = 0; log('自检：AI 回复等待超时，已复位'); report('stall', { why: 'busy timeout' }); } } else W.busySince = 0;
    if (S.pending && now - S.pending.due > 60000) { S.pending = null; log('自检：自动发送没有触发，已复位'); report('stall', { why: 'pending missed' }); }
    if (patrolling) { W.patrolSince = W.patrolSince || now; if (now - W.patrolSince > 90000) { patrolling = false; W.patrolSince = 0; log('自检：巡检卡住，已复位'); } } else W.patrolSince = 0;
    // unread messages are there but nothing gets opened for 4 minutes
    if (S.auto?.enabled && !S.autoPaused && S.unreadStuckSince && now - S.unreadStuckSince > 240000) {
      S.unreadStuckSince = now; W.resets++;
      log(`自检：有未读消息但 4 分钟没有处理，已自动复位（第 ${W.resets} 次）并上报`);
      report('stall', { why: 'unread not handled', resets: W.resets });
      toMain('resetVisited');
      if (W.resets >= 2) {
        let last = 0; try { last = +sessionStorage.getItem('hraReloadAt') || 0; } catch { /* ignore */ }
        if (now - last > 1800000) { try { sessionStorage.setItem('hraReloadAt', String(now)); } catch { /* ignore */ } log('自检：仍未恢复，刷新页面'); setTimeout(() => location.reload(), 1500); }
      }
    }
  }, 30000);
  // page structure report once every 6 hours per page type, so adapters can be tuned without asking the recruiter
  setTimeout(async () => {
    if (S.dead || (!isIm() && !isRec())) return;
    const kind = PLATFORM === 'boss' ? (isRec() ? 'bossRec' : 'boss') : (isRec() ? 'rec' : 'chat');
    const key = `diagAt_${kind}_${VERSION}`;
    try { const v = await chrome.storage.local.get(key); if (Date.now() - (v[key] || 0) < 6 * 3600e3) return; await chrome.storage.local.set({ [key]: Date.now() }); } catch { return; }
    report(kind, { auto: true });
  }, 20000);

  const pageKind = () => isIm() ? 'im' : isRec() ? 'rec' : '';
  const ping = () => api('/ext/ping', { page: location.pathname, version: VERSION, platform: PLATFORM, kind: pageKind() }).then(r => {
    if (r.data?.extVersion) checkVersion(r.data.extVersion);
    S.err = r.error || (S.err.startsWith('连不上') || S.err.startsWith('插件') ? '' : S.err);
    if (r.data?.auto) { const was = S.auto?.enabled; S.auto = r.data.auto; if (was === false && S.auto.enabled) log('后台已开启全自动回复'); }
    if (r.data?.imAlive) S.imAlive = !!r.data.imAlive[PLATFORM] || isIm();
    // tell the background which platform is in use, so it keeps that platform's 消息 page open
    if (r.data?.auto && pageKind()) chrome.runtime.sendMessage({ type: 'seen', platform: PLATFORM, keepIm: !!(r.data.auto.enabled && r.data.auto.keepImTab) }, () => void chrome.runtime.lastError);
    draw();
  });
  // the background wakes the 消息 page every minute (its own timers are throttled while the tab is in the background)
  chrome.runtime.onMessage.addListener(m => { if (m?.type === 'wake' && isIm() && !S.dead) { toMain('tick'); patrol(); if (Date.now() - (S.pingAt || 0) > 50000) { S.pingAt = Date.now(); ping(); } } });
  ping(); setInterval(ping, 60000);
  draw();
})();
