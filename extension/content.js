// v1.0「只筛选 + 回复建议」面板（隔离环境）。
// - 推荐页：读取页面已加载的卡片 → 后台初筛 → 卡片下方显示 AI 结论；不打招呼、不翻页、不加载更多。
// - 聊天页：你打开的会话里候选人发来新消息时，生成回复建议；你点「复制」后自己粘贴、自己点平台的「发送」。
//   插件不往平台输入框里写字，不调用平台接口（页面脚本只读已加载的数据）。
//   不自动发送、不自动打开其他会话、不主动跟进、不点平台上的任何按钮。
// 旧版（打招呼、全自动回复等）见 hragentOS_旧版v0.9.13_备份。
(() => {
  if (window.__hraIso) return;
  window.__hraIso = true;
  // 扩展重新加载但页面没刷新时，旧副本还在运行：最新的接管，旧的停用
  const INSTANCE = `${Date.now()}-${Math.random()}`;
  document.querySelectorAll('#hra-panel').forEach(p => p.remove());
  window.postMessage({ __hra: 'takeover', id: INSTANCE }, location.origin);
  window.addEventListener('message', e => {
    if (e.source === window && e.data?.__hra === 'takeover' && e.data.id !== INSTANCE) { S.dead = true; panel.remove(); }
  });
  const VERSION = chrome.runtime.getManifest().version;
  const PLATFORM = 'zhaopin';
  const SITE = '智联';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (path, body) => new Promise(res => chrome.runtime.sendMessage({ type: 'api', path, body }, r => res(r || { error: chrome.runtime.lastError?.message || '插件后台无响应' })));
  const toMain = (type, data = {}) => window.postMessage({ __hra: 'iso', type, ...data }, location.origin);
  let reqSeq = 0;
  const callMain = (type, data, resultType, timeout = 15000) => new Promise(ok => {
    const reqId = `${Date.now()}-${++reqSeq}`;
    const h = e => { const d = e.data; if (d?.__hra === 'main' && d.type === resultType && d.data?.reqId === reqId) { window.removeEventListener('message', h); ok(d.data); } };
    window.addEventListener('message', h);
    toMain(type, { ...data, reqId });
    setTimeout(() => { window.removeEventListener('message', h); ok({ ok: false, msg: '超时' }); }, timeout);
  });

  const S = {
    results: {}, job: '', roleSel: '', roleName: '', roles: null, err: '', risk: false, log: [],
    chat: null, draft: null, candidateId: null, screen: null, busy: false, lastSuggestSig: '', copied: '',
    collapsed: false, mini: false, pos: null, dead: false, outdated: '',
  };
  const log = m => { S.log.unshift(`${new Date().toTimeString().slice(0, 8)} ${m}`); S.log = S.log.slice(0, 40); draw(); };
  const isRec = () => location.pathname.includes('/app/recommend');
  const isIm = () => location.pathname.includes('/app/im');

  // ---------- 面板：拖动标题栏移动，双击复位，位置记住 ----------
  const panel = document.createElement('div');
  panel.id = 'hra-panel';
  document.documentElement.appendChild(panel);
  const POS_KEY = `hraPanel_${PLATFORM}_top`;
  function placePanel() {
    const p = S.pos;
    if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
      const w = panel.offsetWidth || 320, h = panel.offsetHeight || 60;
      panel.style.left = Math.max(0, Math.min(p.left, window.innerWidth - Math.min(w, 120))) + 'px';
      panel.style.top = Math.max(0, Math.min(p.top, window.innerHeight - Math.min(h, 40))) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    } else { panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = ''; }
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

  // ---------- 绘制 ----------
  const rank = () => Object.entries(S.results).map(([uid, r]) => ({ uid, ...r })).filter(r => r.verdict === '推荐').sort((a, b) => b.score - a.score);
  function draw() {
    if (S.dead) return;
    if (!isRec() && !isIm()) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.classList.toggle('mini', !!S.mini);
    if (S.mini) { panel.innerHTML = '<button class="hra-pill" data-a="mini" title="展开 AI 招聘副驾（可拖动）">AI</button>'; bind(); placePanel(); return; }
    const head = `<div class="hra-head" title="按住拖动；双击回到默认位置"><b>AI 招聘副驾</b><span>${SITE} · ${isRec() ? '推荐页 · 初筛' : '聊天页 · 回复建议'}</span><button class="hra-x" data-a="toggle">${S.collapsed ? '展开' : '收起'}</button><button class="hra-x" data-a="mini" title="缩成小按钮">—</button></div>`;
    if (S.collapsed) { panel.innerHTML = head; bind(); placePanel(); return; }
    let body = '';
    if (S.err) body += `<div class="hra-err">${esc(S.err)}</div>`;
    if (S.outdated) body += `<div class="hra-muted">后台记录的插件版本是 ${esc(S.outdated)}，你用的是 ${esc(VERSION)}（只筛选 + 回复建议版），无需更新。</div>`;
    if (S.risk) body += '<div class="hra-err">页面出现平台风控提示（验证 / 操作频繁），请先人工处理。</div>';
    if (isRec()) body += drawRec();
    if (isIm()) body += drawIm();
    body += `<details class="hra-log"><summary>记录</summary>${S.log.map(l => `<div>${esc(l)}</div>`).join('') || '<div>无</div>'}</details>`;
    const open = panel.querySelector('.hra-log')?.open;
    panel.innerHTML = head + `<div class="hra-body">${body}</div>`;
    if (open) panel.querySelector('.hra-log').open = true;
    bind();
    placePanel();
  }

  function drawRec() {
    const all = Object.values(S.results);
    const n = v => all.filter(r => r.verdict === v).length;
    const rk = rank();
    let b = `<div class="hra-stats"><div><b>${all.length}</b>已初筛</div><div><b>${n('推荐')}</b>推荐</div><div><b>${n('待确认')}</b>待确认</div><div><b>${n('不推荐')}</b>不推荐</div></div>`;
    const RO = S.roles || [['teacher', '教师'], ['xueguan', '学管师'], ['zixun', '课程顾问']];
    b += `<div class="hra-row hra-muted">职位：<b>${esc(S.job || '未识别')}</b>　按 <select id="hra-role" class="hra-sel">${[['', `自动${S.roleName && !S.roleSel ? `（${esc(S.roleName)}）` : ''}`], ...RO].map(([k, t]) => `<option value="${k}" ${(S.roleSel || '') === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select> 岗规则初筛</div>`;
    b += `<div class="hra-sub">推荐的人（按分数，点一下定位到卡片）</div><div class="hra-rank">${rk.length ? rk.slice(0, 15).map(r => `<div class="hra-ri" data-uid="${esc(r.uid)}"><b>${r.score}</b><span>${esc(r.name || '')}<i>${esc(r.reason || '')}</i></span></div>`).join('') : '<p class="hra-muted">暂无推荐的人。你往下滚动页面加载更多卡片，插件会自动读取并初筛。</p>'}</div>`;
    b += '<p class="hra-muted">插件只给出筛选结论，不会替你打招呼。</p>';
    return b;
  }

  function drawIm() {
    const c = S.chat;
    if (!c) return '<p class="hra-muted">打开一个会话。候选人发来新消息时，这里会给出回复建议，由你确认后自己点平台的「发送」。</p>';
    let b = `<div class="hra-sub">${esc(c.name)} · ${esc(c.job || '')}</div>`;
    const sc = S.screen;
    if (sc && S.candidateId) {
      const cls = sc.verdict === '推荐' ? 'ok' : sc.verdict === '不推荐' ? 'no' : 'warn';
      b += `<div class="hra-muted"><span class="hra-tag ${cls}">初筛 ${esc(sc.verdict || '未知')}${sc.verdict === '推荐' ? ' ' + sc.score : ''}</span> ${sc.role ? `<b>${esc(sc.role)}岗</b> · ` : ''}${esc({ applied: '主动投递', greeted: '我方打招呼', unknown: '' }[sc.origin] || '')}${sc.hasResume ? '' : ' · 未读到简历'}<br>${esc(sc.reason || '')}</div>`;
    }
    const d = S.draft;
    const last = c.messages[c.messages.length - 1];
    if (S.busy) return b + '<p class="hra-muted">AI 正在写回复建议…</p>';
    if (!d) return b + `<p class="hra-muted">${last && last.dir === 'in' ? '' : '最后一条是我方消息，等对方回复。'}</p><button class="hra-btn" data-a="suggest">生成回复建议</button>`;
    const ck = (ok, t) => `<div class="hra-ck ${ok ? 'ok' : 'bad'}">${ok ? '通过' : '命中'} · ${esc(t)}</div>`;
    b += `<div class="hra-muted">对方意图：<b>${esc(d.intent)}</b>${d.topic && d.topic !== '其他' ? ` · ${esc(d.topic)}` : ''}${d.asked > 1 ? ` · <b style="color:#C4313B">第 ${d.asked} 遍问</b>` : ''}</div>`;
    if ((d.sources || []).length) b += `<div class="hra-muted">参考资料：${[...new Set(d.sources.map(x => x.title))].map(esc).join('、')}</div>`;
    const parts = d.parts && d.parts.length ? d.parts : [d.reply];
    b += `<div class="hra-draft ${d.blocked ? 'bad' : ''}">${parts.map(esc).join('<hr>')}</div>`;
    b += ck(!d.checks.guard.length, '我方护栏' + (d.checks.guard.length ? '：' + d.checks.guard.join('、') : '')) + ck(!d.checks.platform.length, '平台拦截规则' + (d.checks.platform.length ? '：' + d.checks.platform.join('、') : ''));
    if (d.handoff) b += `<div class="hra-err">建议你亲自回复：${esc(d.handoffWhy || '')}</div>`;
    if (d.action) b += `<div class="hra-act">建议你在平台上点「${esc(d.action)}」${d.slot ? `：${esc(d.slot.date)} ${esc(d.slot.slot)}` : ''}</div>`;
    if (d.resumeAsk) b += '<div class="hra-act">这条回复提到了附件简历，需要的话请你在平台上点「要附件简历」</div>';
    if (d.blocked) b += '<p class="hra-muted">这条建议没通过检查，不建议直接使用，请参考后自己改写。</p>';
    b += `<div class="hra-row"><button class="hra-btn pri" data-a="copy">${S.copied === d.reply ? '已复制 ✓' : '复制'}</button><button class="hra-btn" data-a="suggest">换一条</button></div>
      <p class="hra-muted">复制后自己粘贴到平台输入框，检查无误再点「发送」。插件不会往平台页面里写任何内容。</p>
      <div class="hra-row"><button class="hra-btn" data-a="applied">我已发送</button><button class="hra-btn" data-a="skip">不回复</button><button class="hra-btn" data-a="diag">复制诊断信息</button></div>`;
    return b;
  }

  function bind() {
    panel.querySelectorAll('[data-a]').forEach(b => b.onclick = e => { e.preventDefault(); act(b.dataset.a); });
    const rSel = panel.querySelector('#hra-role');
    if (rSel) rSel.onchange = () => setRoleSel(rSel.value);
    panel.querySelectorAll('.hra-ri[data-uid]').forEach(el => el.onclick = () => {
      const card = document.querySelector(`[data-hra-uid="${CSS.escape(el.dataset.uid)}"]`);
      card && card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  async function act(a) {
    if (a === 'toggle') { S.collapsed = !S.collapsed; return draw(); }
    if (a === 'mini') { if (panel.dataset.dragged) return; S.mini = !S.mini; savePanel(); return draw(); }
    if (a === 'suggest') return suggest(true);
    const d = S.draft;
    if (a === 'copy' && d) {
      try { await navigator.clipboard.writeText(d.reply); S.copied = d.reply; log('回复建议已复制，请粘贴到输入框后自己点发送'); }
      catch { log('复制失败，请手动选中上面的建议复制'); }
      return draw();
    }
    if (a === 'skip') { S.draft = null; log('本条不回复'); return draw(); }
    if (a === 'applied' && d && S.candidateId) {
      const r = await api('/ext/chat/applied', { candidateId: S.candidateId, draft: d });
      log(r.error ? '写入失败：' + r.error : `已记入人才池：${r.data.candidate.attend}`);
      S.draft = null; return draw();
    }
    if (a === 'diag') {
      const r = await callMain('diagnose', {}, 'diagResult');
      const text = JSON.stringify({ version: VERSION, chat: r.data }, null, 1);
      api('/ext/diag', { kind: 'chat', data: JSON.parse(text) });
      try { await navigator.clipboard.writeText(text); log('诊断信息已复制，可以直接粘贴给技术支持'); } catch { log('诊断信息已上传到后台（复制到剪贴板失败）'); }
    }
  }

  // ---------- 推荐页：初筛 ----------
  const roleKey = job => `roleSel_${PLATFORM}_${job || ''}`;
  async function loadRoleSel(job) {
    try { S.roleSel = (await chrome.storage.local.get(roleKey(job)))[roleKey(job)] || ''; } catch { S.roleSel = ''; }
  }
  function rescreenAll() {
    S.results = {}; S.roleName = '';
    document.querySelectorAll('.hra-line').forEach(x => x.remove());
    toMain('reread'); // 页面脚本重新读一遍卡片 → 按新岗位初筛
  }
  async function setRoleSel(v) {
    S.roleSel = v || '';
    try { v ? chrome.storage.local.set({ [roleKey(S.job)]: v }) : chrome.storage.local.remove(roleKey(S.job)); } catch { /* this page only */ }
    log(v ? `「${S.job || '当前职位'}」改为按指定岗位规则初筛` : `「${S.job || '当前职位'}」改为按职位名自动识别岗位`);
    rescreenAll();
  }
  async function onCards(cards, job) {
    if (job && job !== S.job) {
      const had = !!S.job;
      S.job = job;
      await loadRoleSel(job);
      if (had) { log(`切换到职位「${job}」，按这个岗位重新初筛`); rescreenAll(); return; }
    }
    const fresh = cards.filter(c => !S.results[c.resumeNumber]);
    if (!fresh.length) return paintLines();
    const r = await api('/ext/screen', { platform: PLATFORM, job: S.job, role: S.roleSel || undefined, cards: fresh });
    if (r.error) { S.err = r.error; return draw(); }
    S.err = '';
    if (r.data.role) S.roleName = r.data.role.name;
    if (r.data.roles) S.roles = r.data.roles;
    const names = Object.fromEntries(cards.map(c => [c.resumeNumber, c.userName]));
    for (const x of r.data.results) S.results[x.uid] = { ...x, name: names[x.uid] };
    log(`读取 ${fresh.length} 张卡片并初筛`);
    paintLines(); draw();
    const need = r.data.results.filter(x => x.reasonBy !== 'ai').map(x => x.uid);
    if (need.length) {
      const rr = await api('/ext/reasons', { platform: PLATFORM, uids: need });
      if (rr.data?.reasons) { for (const [k, v] of Object.entries(rr.data.reasons)) if (S.results[k]) { S.results[k].reason = v; S.results[k].reasonBy = 'ai'; } }
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
      const html = `<span class="hra-tag ${cls}">AI ${esc(r.verdict)}</span>${r.verdict !== '不推荐' ? `<b>${r.score}<small>分</small></b>` : ''}<span class="hra-why">${esc(r.reason)}</span>${r.reasonBy === 'ai' ? '<span class="hra-src">AI</span>' : ''}`;
      if (line.innerHTML !== html) line.innerHTML = html;
      el.classList.toggle('hra-v-ok', cls === 'ok'); el.classList.toggle('hra-v-warn', cls === 'warn'); el.classList.toggle('hra-v-no', cls === 'no');
    }
  }

  // ---------- 聊天页：只为你当前打开的会话生成回复建议 ----------
  const chatSig = c => c ? c.sessionId + ':' + (c.messages.length ? c.messages[c.messages.length - 1].id : '') : '';
  let suggestQueued = null;
  async function suggest(force = false) {
    if (S.dead) return;
    if (S.busy) { suggestQueued = suggestQueued || force; return; }
    const c = S.chat;
    if (!c) return;
    const last = c.messages[c.messages.length - 1];
    const sig = chatSig(c);
    // 只在对方发来新消息时自动生成；最后一条是我方的就等对方回复（可以手动点「生成回复建议」）
    if (!force && (sig === S.lastSuggestSig || !last || last.dir !== 'in')) return draw();
    S.lastSuggestSig = sig; S.busy = true; S.draft = null; S.copied = ''; draw();
    const r = await api('/ext/chat/suggest', { platform: PLATFORM, sessionId: c.sessionId, uid: c.uid, name: c.name, job: c.job, origin: c.origin, profile: c.profile, phones: c.phones || [], messages: c.messages });
    S.busy = false;
    if (suggestQueued !== null) { const f = suggestQueued; suggestQueued = null; if (chatSig(S.chat) !== sig || f) return suggest(f); }
    if (chatSig(S.chat) !== sig) return; // 等待期间会话变了
    if (r.error) { S.err = r.error; return draw(); }
    // 后台返回的「全自动 / 半自动」决定在 v1.0 一律忽略：只展示建议，不发送
    S.err = ''; S.draft = r.data.draft; S.candidateId = r.data.candidateId; S.screen = r.data.screen;
    log(`${c.name}：${S.draft.intent} → 已生成回复建议${S.draft.byAi === false ? '（AI 暂不可用，用的是规则回复）' : ''}`);
    draw();
  }

  // ---------- 来自页面脚本（只读数据） ----------
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__hra !== 'main' || e.source !== window) return;
    if (d.type === 'recommend') onCards(d.data.cards, d.data.job);
    if (d.type === 'chat') {
      const changed = !S.chat || S.chat.sessionId !== d.data.sessionId;
      // 建议写好后简历才加载出来（且你还没处理）：带上简历重新生成
      const lateResume = !changed && d.data.profile && !S.chat.profile && chatSig(d.data) === S.lastSuggestSig
        && d.data.messages.length && d.data.messages[d.data.messages.length - 1].dir === 'in';
      S.chat = d.data;
      const phoneSig = `${d.data.sessionId}:${(d.data.phones || []).join(',')}`;
      if ((d.data.phones || []).length && S.phoneSig !== phoneSig) {
        S.phoneSig = phoneSig;
        api('/ext/chat/phones', { platform: PLATFORM, sessionId: d.data.sessionId, uid: d.data.uid, name: d.data.name, job: d.data.job, phones: d.data.phones });
      }
      if (changed) { S.draft = null; S.candidateId = null; S.screen = null; S.copied = ''; }
      if (lateResume) { log(`${d.data.name || ''}：读到简历了，按简历重新生成建议`); suggest(true); }
      else suggest(false);
    }
    if (d.type === 'actionResult') log(d.data.msg);
    if (d.type === 'risk' && !S.risk) { S.risk = true; log('页面出现平台风控提示'); draw(); }
    if (d.type === 'error') console.debug('[hra]', d.data.msg);
  });

  // 页面重新渲染时补画卡片结论；切换页面时清空
  setInterval(() => { if (isRec()) paintLines(); }, 2000);
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; S.draft = null; S.chat = null; draw(); toMain('reread'); } }, 1000);

  // 心跳：只上报版本，让后台知道插件在线；不再自动更新、不再保持消息页常开
  const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  const ping = () => api('/ext/ping', { id: INSTANCE, frame: false, page: location.pathname, version: VERSION, platform: PLATFORM, kind: isIm() ? 'im' : isRec() ? 'rec' : '' }).then(r => {
    if (r.data?.extVersion && r.data.extVersion !== VERSION && !newer(r.data.extVersion, VERSION)) S.outdated = r.data.extVersion;
    S.err = r.error || (S.err.startsWith('连不上') || S.err.startsWith('插件') ? '' : S.err);
    draw();
  });
  ping(); setInterval(ping, 60000);
  draw();
})();
