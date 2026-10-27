// BOSS直聘 侧边栏：显示 AI 初筛结论、分数和回复建议。
// BOSS 页面里不放任何东西（防平台检测插件）；页面上的文字由 boss-reader.js 只读读取后发到这里。
// 回复建议只能「复制」，由你自己粘贴到 BOSS 输入框、自己点发送。
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const PLATFORM = 'boss';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (path, body) => new Promise(res => chrome.runtime.sendMessage({ type: 'api', path, body }, r => res(r || { error: chrome.runtime.lastError?.message || '插件后台无响应' })));
  const app = document.getElementById('app');

  // 每个标签页一份状态；只显示当前标签页的
  const tabs = new Map();
  const T = id => { if (!tabs.has(id)) tabs.set(id, { results: {}, order: [], job: '', roleSel: '', roleName: '', roles: null, resume: null, chat: null, draft: null, candidateId: null, screen: null, busy: false, lastSuggestSig: '', copied: '', path: '' }); return tabs.get(id); };
  let activeTab = null, err = '', logs = [];
  const log = m => { logs.unshift(`${new Date().toTimeString().slice(0, 8)} ${m}`); logs = logs.slice(0, 40); draw(); };

  async function refreshActive() {
    try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); activeTab = t ? t.id : null; } catch { activeTab = null; }
    // 侧边栏后打开 / 切回来：向页面要一份已有的初筛结果和当前内容
    if (activeTab != null) { chrome.tabs.sendMessage(activeTab, { type: 'bossSync' }).catch(() => {}); }
    draw();
  }
  chrome.tabs.onActivated.addListener(refreshActive);
  chrome.tabs.onRemoved.addListener(id => tabs.delete(id));
  refreshActive();

  const vcls = v => v === '推荐' ? 'ok' : v === '待确认' ? 'warn' : 'no';
  const verdictHtml = r => `<span class="tag ${vcls(r.verdict)}">AI ${esc(r.verdict)}</span>${r.verdict !== '不推荐' && r.score != null ? `<span class="score">${esc(r.score)}<small>分</small></span>` : ''}`;

  // ---------- 绘制 ----------
  function draw() {
    const s = activeTab != null && tabs.get(activeTab);
    let h = `<div class="head"><div><h1>AI 招聘副驾</h1><div class="mut">BOSS直聘 · 只读 · v${esc(VERSION)}</div></div><button data-a="options">设置</button></div>`;
    if (err) h += `<div class="err">${esc(err)}</div>`;
    if (!s) {
      h += '<div class="box">在这个窗口打开 BOSS直聘 的「推荐牛人」、简历详情或「沟通」页面，结论和回复建议会显示在这里。<br><span class="mut">如果页面已经打开，请刷新一下页面。插件不会在 BOSS 页面上加任何东西。</span></div>';
    } else {
      if (s.resume) h += drawResume(s);
      if (s.chat) h += drawChat(s);
      if (s.order.length) h += drawList(s);
      if (!s.resume && !s.chat && !s.order.length) h += '<div class="box mut">已连上 BOSS 页面，还没读到简历或聊天。打开推荐列表、点开一份简历，或打开一个会话。<br>一直没有反应的话，点下面「复制诊断信息」发给技术支持。</div>';
    }
    h += `<div class="row"><button data-a="marks">网页上显示结论：${marksOn ? '开' : '关'}</button><button data-a="reread">重新读取</button><button data-a="diag">复制诊断信息</button></div>`;
    h += `<details class="log"><summary>记录</summary>${logs.map(l => `<div>${esc(l)}</div>`).join('') || '<div>无</div>'}</details>`;
    const open = app.querySelector('details')?.open;
    app.innerHTML = h;
    if (open) app.querySelector('details').open = true;
    app.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a));
    const sel = app.querySelector('#role'); if (sel) sel.onchange = () => setRole(sel.value);
  }
  function roleSelect(s) {
    const RO = s.roles || [['teacher', '教师'], ['xueguan', '学管师'], ['zixun', '课程顾问']];
    return `<div class="mut">职位：<b>${esc(s.job || '未识别')}</b>　按 <select id="role">${[['', `自动${s.roleName && !s.roleSel ? `（${esc(s.roleName)}）` : ''}`], ...RO].map(([k, t]) => `<option value="${k}" ${(s.roleSel || '') === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select> 岗规则初筛</div>`;
  }
  function drawResume(s) {
    const c = s.resume, r = s.results[c.resumeNumber];
    let b = `<div class="sub">当前打开的简历：${esc(c.userName || '')}</div><div class="box">`;
    b += `<div class="mut">${esc([c.age ? c.age + '岁' : '', c.educationLevel, c.workYearsLabel, c.educationExperiences[0]?.schoolName].filter(Boolean).join(' · '))}</div>`;
    b += r ? `<div class="verdict" style="margin-top:6px">${verdictHtml(r)}</div><div class="why">${esc(r.reason || '')}</div>` : '<div class="mut">AI 初筛中…</div>';
    return b + '</div>';
  }
  function drawList(s) {
    const all = s.order.map(u => ({ uid: u, ...s.results[u] })).filter(r => r.verdict);
    const n = v => all.filter(r => r.verdict === v).length;
    let b = `<div class="sub">推荐列表初筛</div>${roleSelect(s)}<div class="stats"><div><b>${all.length}</b>已初筛</div><div><b>${n('推荐')}</b>推荐</div><div><b>${n('待确认')}</b>待确认</div><div><b>${n('不推荐')}</b>不推荐</div></div>`;
    const sorted = [...all].sort((a, c) => (a.verdict === c.verdict ? (c.score || 0) - (a.score || 0) : ['推荐', '待确认', '不推荐'].indexOf(a.verdict) - ['推荐', '待确认', '不推荐'].indexOf(c.verdict)));
    b += `<div class="box">${sorted.map(r => `<div class="item"><span class="nm">${esc(r.name || '未识别姓名')}</span>${verdictHtml(r)}<div class="mut">${esc(r.reason || '')}</div></div>`).join('') || '<span class="mut">暂无</span>'}</div>`;
    return b + '<p class="mut">插件只给出筛选结论，不会替你打招呼。往下滚动加载更多卡片后会自动读取。</p>';
  }
  function drawChat(s) {
    const c = s.chat;
    let b = `<div class="sub">会话：${esc(c.name)}${c.job ? ' · ' + esc(c.job) : ''}</div><div class="box">`;
    const sc = s.screen;
    if (sc && s.candidateId) b += `<div class="verdict">${verdictHtml(sc)}</div><div class="why">${sc.role ? `<b>${esc(sc.role)}岗</b> · ` : ''}${esc(sc.reason || '')}${sc.hasResume ? '' : '<br><span class="mut">没读到简历（在会话里打开对方的在线简历后会更准）</span>'}</div>`;
    const d = s.draft, last = c.messages[c.messages.length - 1];
    if (s.busy) return b + '<p class="mut">AI 正在写回复建议…</p></div>';
    if (!d) return b + `<p class="mut">${last && last.dir === 'in' ? '' : '最后一条是我方消息，等对方回复。'}</p><button data-a="suggest">生成回复建议</button></div>`;
    const ck = (ok, t) => `<div class="ck ${ok ? 'ok' : 'bad'}">${ok ? '通过' : '命中'} · ${esc(t)}</div>`;
    b += `<div class="mut" style="margin-top:8px">对方意图：<b>${esc(d.intent)}</b>${d.topic && d.topic !== '其他' ? ` · ${esc(d.topic)}` : ''}${d.asked > 1 ? ` · <b style="color:var(--err)">第 ${d.asked} 遍问</b>` : ''}</div>`;
    if ((d.sources || []).length) b += `<div class="mut">参考资料：${[...new Set(d.sources.map(x => x.title))].map(esc).join('、')}</div>`;
    const parts = d.parts && d.parts.length ? d.parts : [d.reply];
    b += `<div class="draft ${d.blocked ? 'bad' : ''}">${parts.map(esc).join('<hr>')}</div>`;
    b += ck(!d.checks.guard.length, '我方护栏' + (d.checks.guard.length ? '：' + d.checks.guard.join('、') : '')) + ck(!d.checks.platform.length, '平台拦截规则' + (d.checks.platform.length ? '：' + d.checks.platform.join('、') : ''));
    if (d.handoff) b += `<div class="err">建议你亲自回复：${esc(d.handoffWhy || '')}</div>`;
    if (d.action) b += `<div class="act">建议你在 BOSS 上点「${esc(d.action)}」${d.slot ? `：${esc(d.slot.date)} ${esc(d.slot.slot)}` : ''}</div>`;
    if (d.resumeAsk) b += '<div class="act">这条回复提到了附件简历，需要的话请你在 BOSS 上点「求简历」</div>';
    if (d.blocked) b += '<p class="mut">这条建议没通过检查，不建议直接使用，请参考后自己改写。</p>';
    b += `<div class="row"><button class="pri" data-a="copy">${s.copied === d.reply ? '已复制 ✓' : '复制'}</button><button data-a="suggest">换一条</button></div>
      <p class="mut">复制后自己粘贴到 BOSS 输入框，检查无误再点「发送」。</p>
      <div class="row"><button data-a="applied">我已发送</button><button data-a="skip">不回复</button></div>`;
    return b + '</div>';
  }

  // ---------- 操作 ----------
  const toTab = msg => { if (activeTab != null) chrome.tabs.sendMessage(activeTab, msg).catch(() => {}); };
  async function act(a) {
    const s = activeTab != null && tabs.get(activeTab);
    if (a === 'options') return chrome.runtime.openOptionsPage();
    if (a === 'marks') {
      marksOn = !marksOn;
      try { await chrome.storage.local.set({ bossMarks: marksOn }); } catch { /* not kept */ }
      log(marksOn ? '网页上显示结论标签：开' : '网页上显示结论标签：关（只在侧边栏看）');
      return draw();
    }
    if (a === 'reread') { if (s) { s.results = {}; s.order = []; s.resume = null; } toTab({ type: 'bossReread' }); return log('已请求页面重新读取'); }
    if (a === 'diag') { diagWait = []; toTab({ type: 'bossDiagnose' }); setTimeout(finishDiag, 1500); return log('正在收集诊断信息…'); }
    if (!s) return;
    if (a === 'suggest') return suggest(activeTab, true);
    const d = s.draft;
    if (a === 'copy' && d) {
      try { await navigator.clipboard.writeText(d.reply); s.copied = d.reply; log('回复建议已复制，请粘贴到 BOSS 输入框后自己点发送'); }
      catch { log('复制失败，请手动选中上面的建议复制'); }
      return draw();
    }
    if (a === 'skip') { s.draft = null; log('本条不回复'); return draw(); }
    if (a === 'applied' && d && s.candidateId) {
      const r = await api('/ext/chat/applied', { candidateId: s.candidateId, draft: d });
      log(r.error ? '写入失败：' + r.error : `已记入人才池：${r.data.candidate.attend}`);
      s.draft = null; return draw();
    }
  }
  // 诊断：每个 frame 各回一份，汇总后复制
  let diagWait = null;
  async function finishDiag() {
    const text = JSON.stringify({ version: VERSION, frames: diagWait || [] }, null, 1);
    diagWait = null;
    api('/ext/diag', { kind: 'boss', data: JSON.parse(text) });
    try { await navigator.clipboard.writeText(text); log('诊断信息已复制并上传到后台，可以直接粘贴给技术支持'); } catch { log('诊断信息已上传到后台（复制到剪贴板失败）'); }
  }

  // ---------- 初筛：由页面读取器（boss-reader.js）做，结果发到这里显示 ----------
  const roleKey = job => `roleSel_boss_${job || ''}`;
  async function setRole(v) {
    const s = tabs.get(activeTab); if (!s) return;
    s.roleSel = v || '';
    try { await (v ? chrome.storage.local.set({ [roleKey(s.job)]: v }) : chrome.storage.local.remove(roleKey(s.job))); } catch { /* this session only */ }
    s.results = {}; s.order = [];
    log(v ? `「${s.job || '当前职位'}」改为按指定岗位规则初筛` : `「${s.job || '当前职位'}」改为按职位名自动识别岗位`);
    toTab({ type: 'bossReread' });
  }
  async function onScreened(tabId, d) {
    const s = T(tabId);
    if (d.job !== undefined && d.job !== s.job) {
      s.job = d.job; s.results = {}; s.order = [];
      try { s.roleSel = (await chrome.storage.local.get(roleKey(d.job)))[roleKey(d.job)] || ''; } catch { s.roleSel = ''; }
    }
    if (d.role) s.roleName = d.role.name;
    if (d.roles) s.roles = d.roles;
    for (const x of d.results || []) { s.results[x.uid] = { ...(s.results[x.uid] || {}), ...x }; if (!s.order.includes(x.uid)) s.order.push(x.uid); }
    err = '';
  }
  // 网页上的结论标签开关（默认开）
  let marksOn = true;
  try { chrome.storage.local.get('bossMarks').then(v => { marksOn = v.bossMarks !== false; draw(); }); } catch { /* default on */ }

  // ---------- 回复建议：只为你当前打开的会话 ----------
  const chatSig = c => c ? c.sessionId + ':' + (c.messages.length ? c.messages[c.messages.length - 1].id : '') : '';
  async function suggest(tabId, force) {
    const s = T(tabId), c = s.chat;
    if (!c || s.busy) return;
    const last = c.messages[c.messages.length - 1], sig = chatSig(c);
    if (!force && (sig === s.lastSuggestSig || !last || last.dir !== 'in')) return draw();
    s.lastSuggestSig = sig; s.busy = true; s.draft = null; s.copied = ''; draw();
    const r = await api('/ext/chat/suggest', { platform: PLATFORM, sessionId: c.sessionId, uid: c.uid, name: c.name, job: c.job, origin: c.origin, profile: c.profile, phones: c.phones || [], messages: c.messages });
    s.busy = false;
    if (chatSig(s.chat) !== sig) return suggest(tabId, false); // 等待期间来了新消息
    if (r.error) { err = r.error; return draw(); }
    // 后台的「全自动 / 半自动」在这里一律忽略：只展示建议，不发送
    err = ''; s.draft = r.data.draft; s.candidateId = r.data.candidateId; s.screen = r.data.screen;
    log(`${c.name}：${s.draft.intent} → 已生成回复建议${s.draft.byAi === false ? '（AI 暂不可用，用的是规则回复）' : ''}`);
    draw();
  }

  // ---------- 来自 BOSS 页面的只读数据 ----------
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'boss' || !sender.tab) return;
    const tabId = sender.tab.id, s = T(tabId);
    s.path = msg.path;
    if (msg.kind === 'diag') { if (diagWait && tabId === activeTab) diagWait.push(msg.data); return; }
    if (msg.kind === 'screened') onScreened(tabId, msg.data).then(() => { if (tabId === activeTab) draw(); });
    if (msg.kind === 'screenError') err = msg.data.msg;
    if (msg.kind === 'resume') {
      s.resume = msg.data.card;
      if (s.resume) log(`读到简历：${s.resume.userName || '未识别姓名'}`);
    }
    if (msg.kind === 'chat') {
      const changed = !s.chat || s.chat.sessionId !== msg.data.sessionId;
      const lateResume = !changed && msg.data.profile && !s.chat.profile && chatSig(msg.data) === s.lastSuggestSig;
      s.chat = msg.data;
      const phones = msg.data.phones || [];
      if (phones.length && s.phoneSig !== `${msg.data.sessionId}:${phones.join(',')}`) {
        s.phoneSig = `${msg.data.sessionId}:${phones.join(',')}`;
        api('/ext/chat/phones', { platform: PLATFORM, sessionId: msg.data.sessionId, uid: msg.data.uid, name: msg.data.name, job: msg.data.job, phones });
      }
      if (changed) { s.draft = null; s.candidateId = null; s.screen = null; s.copied = ''; s.lastSuggestSig = ''; }
      if (lateResume) { log(`${msg.data.name}：读到简历了，按简历重新生成建议`); suggest(tabId, true); }
      else suggest(tabId, false);
    }
    if (tabId === activeTab) draw();
  });

  // 心跳：让后台知道插件在线，也顺便检查服务器地址和令牌
  const INSTANCE = `sp-${Date.now()}-${Math.random()}`;
  const ping = () => api('/ext/ping', { id: INSTANCE, frame: false, page: 'sidepanel', version: VERSION, platform: PLATFORM, kind: '' }).then(r => {
    if (r.error) err = r.error; else if (err.startsWith('连不上') || err.startsWith('插件未配置')) err = '';
    draw();
  });
  ping(); setInterval(ping, 60000);
  draw();
})();
