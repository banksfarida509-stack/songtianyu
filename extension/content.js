// Isolated-world content script: talks to the backend (through background.js),
// draws the AI line under each recommend card and the copilot panel.
// Chat page: every candidate message is classified by the backend, which then
// decides 全自动 / 半自动 / 转人工 (see decideMode in server/src/ai.js).
(() => {
  if (window.__hraIso) return;
  window.__hraIso = true;
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
  const isRec = () => location.pathname.includes('/app/recommend');
  const isIm = () => location.pathname.includes('/app/im');

  function rank() {
    return Object.entries(S.results).map(([uid, r]) => ({ uid, ...r })).filter(r => r.verdict === '推荐').sort((a, b) => b.score - a.score);
  }
  function draw() {
    if (!isRec() && !isIm()) { panel.hidden = true; return; }
    panel.hidden = false;
    const head = `<div class="hra-head"><b>AI 招聘副驾</b><span>${isRec() ? '推荐页 · 初筛' : '聊天页 · 约聊'}</span><button class="hra-x" data-a="toggle">${S.collapsed ? '展开' : '收起'}</button></div>`;
    if (S.collapsed) { panel.innerHTML = head; bind(); return; }
    let body = '';
    if (S.err) body += `<div class="hra-err">${esc(S.err)}</div>`;
    if (S.risk) body += `<div class="hra-err">检测到平台风控提示（验证 / 操作频繁），已停止所有自动动作，请人工处理。</div>`;
    if (isRec()) body += drawRec();
    if (isIm()) body += drawIm();
    body += `<details class="hra-log"><summary>动作日志</summary>${S.log.map(l => `<div>${esc(l)}</div>`).join('') || '<div>无</div>'}</details>`;
    const open = panel.querySelector('.hra-log')?.open;
    panel.innerHTML = head + `<div class="hra-body">${body}</div>`;
    if (open) panel.querySelector('.hra-log').open = true;
    bind();
  }
  function drawRec() {
    const all = Object.values(S.results);
    const n = v => all.filter(r => r.verdict === v).length;
    const rk = rank();
    let b = `<div class="hra-stats"><div><b>${all.length}</b>已初筛</div><div><b>${n('推荐')}</b>推荐</div><div><b>${n('待确认')}</b>待确认</div><div><b>${n('不推荐')}</b>不推荐</div></div>`;
    b += `<div class="hra-sub">推荐顺序（${esc(S.job || '当前岗位')}）</div><div class="hra-rank">${rk.length ? rk.slice(0, 12).map(r => `<div class="hra-ri" data-uid="${esc(r.uid)}"><b>${r.score}</b><span>${esc(r.name || '')}<i>${esc(r.reason || '')}</i></span><em>${r.greeted ? '已打招呼' : ''}</em></div>`).join('') : '<p class="hra-muted">暂无推荐的人。滚动页面加载更多，插件会自动读取。</p>'}</div>`;
    b += S.greeting
      ? `<p class="hra-muted">正在打招呼：已完成 ${S.done} / ${S.target}${S.phase ? ' · ' + esc(S.phase) : ''}</p><button class="hra-btn" data-a="stop">停止打招呼</button>`
      : S.confirmGreet
        ? `<p class="hra-muted">按 AI 推荐顺序打招呼，当前页推荐 ${rk.filter(r => !r.greeted).length} 位未打招呼；不够时自动往下加载更多。会消耗平台打招呼次数。</p>
           <div class="hra-row"><label class="hra-muted">本次打 <input id="hra-n" type="number" min="1" max="100" value="${S.target || 10}" style="width:56px"> 位</label></div>
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
      <i>${A ? `本小时自动发送 ${A.sentLastHour || 0}/${A.maxPerHour || 0}` : ''}${A && !A.enabled ? ' · 在后台“设置 → 约聊回复方式”里打开' : ''} · <a href="#" data-a="kb">编辑知识库</a></i></div>`;
    const c = S.chat;
    if (!c) b += '<p class="hra-muted">打开一个会话，插件会读取最新消息，分类后按设置自动回复或给出建议。</p>';
    else {
      b += `<div class="hra-sub">${esc(c.name)} · ${esc(c.job || '')}</div>`;
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
    if (a === 'greet') { S.confirmGreet = true; return draw(); }
    if (a === 'greet-cancel') { S.confirmGreet = false; return draw(); }
    if (a.startsWith('gap:')) {
      S.gap = Math.max(0, Math.min(GAPS.length - 1, +a.slice(4)));
      try { chrome.storage.local.set({ greetGap: S.gap }); } catch { /* remembered for this page only */ }
      return draw();
    }
    if (a === 'greet-go') {
      const n = parseInt(panel.querySelector('#hra-n')?.value, 10);
      S.target = Math.max(1, Math.min(100, n || 10));
      S.confirmGreet = false; return greetLoop();
    }
    if (a === 'stop') { S.stop = true; return; }
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
    const r = await api('/ext/screen', { platform: 'zhaopin', job: S.job, cards: fresh });
    if (r.error) { S.err = r.error; return draw(); }
    S.err = '';
    const names = Object.fromEntries(cards.map(c => [c.resumeNumber, c.userName]));
    for (const x of r.data.results) S.results[x.uid] = { ...x, name: names[x.uid] };
    log(`读取 ${fresh.length} 张卡片并初筛`);
    paintLines(); draw();
    const need = r.data.results.filter(x => x.reasonBy !== 'ai').map(x => x.uid);
    if (need.length) {
      const rr = await api('/ext/reasons', { platform: 'zhaopin', uids: need });
      if (rr.data?.reasons) { for (const [k, v] of Object.entries(rr.data.reasons)) if (S.results[k]) { S.results[k].reason = v; S.results[k].reasonBy = 'ai'; } paintLines(); draw(); }
    }
  }
  function paintLines() {
    for (const [uid, r] of Object.entries(S.results)) {
      const el = document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
      if (!el) continue;
      let line = el.querySelector(':scope > .hra-line');
      if (!line) { line = document.createElement('div'); line.className = 'hra-line'; el.appendChild(line); }
      const cls = r.verdict === '推荐' ? 'ok' : r.verdict === '待确认' ? 'warn' : 'no';
      const html = `<span class="hra-tag ${cls}">AI ${esc(r.verdict)}</span>${r.verdict !== '不推荐' ? `<b>${r.score} 分</b>` : ''}<span class="hra-why">${esc(r.reason)}</span>${r.reasonBy === 'ai' ? '<span class="hra-src">AI</span>' : ''}${r.greeted ? '<span class="hra-tag no">已打招呼</span>' : ''}`;
      if (line.innerHTML !== html) line.innerHTML = html;
      el.classList.toggle('hra-v-ok', cls === 'ok'); el.classList.toggle('hra-v-warn', cls === 'warn'); el.classList.toggle('hra-v-no', cls === 'no');
    }
  }
  // Greets up to S.target recommended candidates; when the loaded list runs
  // out it asks the page to load more (up to 4 tries without new 推荐).
  async function greetLoop() {
    S.greeting = true; S.stop = false; S.done = 0; S.phase = ''; draw();
    const skip = new Set();
    let dry = 0, why = '', fails = 0;
    const onPage = uid => !!document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
    while (S.done < S.target && !S.stop && !S.risk) {
      const r = rank().find(x => !x.greeted && !skip.has(x.uid) && onPage(x.uid));
      if (!r) {
        if (++dry > 4) { why = '当前岗位已没有更多 AI 推荐的候选人'; break; }
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
      if (res.ok) { S.results[r.uid].greeted = true; if (!/已沟通过/.test(res.msg)) { S.done++; fails = 0; } paintLines(); draw(); }
      else skip.add(r.uid);
      if (res.dialog) { S.stop = true; why = '平台弹出窗口，需要人工处理（见上一条日志）'; break; }
      if (res.unverified && ++fails >= 3) { S.stop = true; why = '连续 3 位未确认成功，请看页面是否有提示'; break; }
      if (S.done >= S.target) break;
      // nothing was sent (already contacted / card gone): move on without the pause
      if (/已沟通过/.test(res.msg) || (!res.ok && !res.unverified)) continue;
      const [lo, hi] = GAPS[S.gap] || GAPS[3];
      const wait = (lo + Math.random() * (hi - lo)) * 1000;
      S.phase = `等待 ${Math.round(wait / 1000)} 秒后继续`; draw();
      for (let t = 0; t < wait && !S.stop && !S.risk; t += 500) await sleep(500);
    }
    S.greeting = false; S.phase = '';
    log(S.risk ? '因平台风控提示停止' : why ? `停止：${why}（本次成功 ${S.done} 位）` : S.stop ? `已手动停止（本次成功 ${S.done} 位）` : `完成：本次成功打招呼 ${S.done} 位`);
    draw();
  }

  // ---------- chat: classify → 全自动 / 半自动 / 转人工 ----------
  const chatSig = c => c ? c.sessionId + ':' + (c.messages.length ? c.messages[c.messages.length - 1].id : '') : '';
  function addTodo(mode, why) {
    const c = S.chat; if (!c) return;
    S.todo = [{ sessionId: c.sessionId, name: c.name, mode, why, at: new Date().toTimeString().slice(0, 5) }, ...S.todo.filter(t => t.sessionId !== c.sessionId)].slice(0, 30);
  }
  function doneTodo() { if (S.chat) S.todo = S.todo.filter(t => t.sessionId !== S.chat.sessionId); }
  function cancelPending(msg) { if (S.pending) { S.pending = null; if (msg) log(msg); } draw(); }

  async function suggest(force = false) {
    const c = S.chat;
    if (!c) return;
    const last = c.messages[c.messages.length - 1];
    const sig = chatSig(c);
    if (!force && (sig === S.lastSuggestSig || !last || last.dir !== 'in')) return draw();
    S.lastSuggestSig = sig; S.busy = true; S.draft = null; S.decision = null; S.pending = null; draw();
    const r = await api('/ext/chat/suggest', { platform: 'zhaopin', sessionId: c.sessionId, uid: c.uid, name: c.name, job: c.job, origin: c.origin, profile: c.profile, messages: c.messages });
    S.busy = false;
    if (chatSig(S.chat) !== sig) return; // conversation moved on while waiting
    if (r.error) { S.err = r.error; return draw(); }
    S.err = ''; S.draft = r.data.draft; S.decision = r.data.decision; S.chatMode = r.data.chatMode; S.candidateId = r.data.candidateId;
    S.handledAt = Date.now();
    const dc = S.decision || { mode: 'semi', why: '' };
    log(`${c.name}：${S.draft.intent} → ${MODE_TXT[dc.mode]}（${dc.why}）`);
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
    const d = S.draft, sig = S.lastSuggestSig;
    if (!d || d.blocked || S.sending) return;
    if (auto && (chatSig(S.chat) !== sig || S.autoPaused || S.risk)) return log('会话有变化，取消自动发送');
    S.sending = true; draw();
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
      const up = await api('/ext/chat/history', { platform: 'zhaopin', sessions: r.sessions.slice(i, i + 10) });
      if (up.error) { log(`上传失败：${up.error}`); break; }
      conv += up.data.conversations; msgs += up.data.newMessages;
    }
    log(`采集完成：${conv} 个会话，新增 ${msgs} 条消息${r.skipped ? `，跳过 ${r.skipped} 个（有未读或未找到）` : ''}。到后台“知识库 → 从历史约聊学习”生成常见问题`);
    draw();
  }

  // full-auto patrol: open the next conversation with unread messages when idle
  async function patrol() {
    const A = S.auto;
    if (!isIm() || !A?.enabled || A.scanUnread === false || S.autoPaused || S.risk || S.busy || S.pending || S.sending || S.collecting) return;
    if (Date.now() - S.userAt < 45000) return;                 // the recruiter is using the page
    const waitingOnYou = S.draft && !S.draft.sentAuto && S.decision?.mode !== 'auto';
    if (Date.now() - S.handledAt < (waitingOnYou ? 180000 : 8000)) return; // give a semi draft 3 min before moving on
    const r = await callMain('nextUnread', { skip: S.scanSkip }, 'openResult');
    if (r.ok) log(r.msg);
    else if (!r.none && /没找到/.test(r.msg)) log(r.msg);
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
      if (S.pending && chatSig(d.data) !== S.pending.sig) {
        if (changed) addTodo('semi', '自动回复被打断（切换了会话）');
        S.pending = null;
      }
      S.chat = d.data;
      if (changed) { S.draft = null; S.decision = null; S.chatMode = null; S.candidateId = null; }
      suggest(false);
    }
    if (d.type === 'actionResult') log(d.data.msg);
    if (d.type === 'risk' && !S.risk) { S.risk = true; S.stop = true; S.pending = null; log('检测到平台风控提示，已停止'); draw(); }
    if (d.type === 'error') console.debug('[hra]', d.data.msg);
  });

  // keep lines alive when the page re-renders; countdown; heartbeat
  setInterval(() => { if (isRec()) paintLines(); }, 2000);
  setInterval(() => { const el = panel.querySelector('#hra-cd'); if (el && S.pending) el.textContent = Math.max(0, Math.ceil((S.pending.due - Date.now()) / 1000)); }, 1000);
  setInterval(patrol, 15000);
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; S.draft = null; S.chat = null; S.pending = null; draw(); toMain('reread'); } }, 1000);
  const ping = () => api('/ext/ping', { page: location.pathname, version: VERSION }).then(r => {
    S.err = r.error || (S.err.startsWith('连不上') || S.err.startsWith('插件') ? '' : S.err);
    if (r.data?.auto) { const was = S.auto?.enabled; S.auto = r.data.auto; if (was === false && S.auto.enabled) log('后台已开启全自动回复'); }
    draw();
  });
  ping(); setInterval(ping, 60000);
  draw();
})();
