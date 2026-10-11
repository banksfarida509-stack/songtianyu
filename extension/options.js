const $ = id => document.getElementById(id);
const call = (path, body, method) => new Promise(res => chrome.runtime.sendMessage({ type: 'api', path, body, method }, r => res(r || { error: '无响应' })));
const show = (el, ok, text) => { $(el).textContent = text; $(el).style.color = ok ? '#0E8A5F' : '#C4313B'; };

chrome.storage.sync.get(['server', 'token']).then(st => {
  $('server').value = st.server || self.HR_CONFIG.server || '';
  $('token').value = st.token || self.HR_CONFIG.token || '';
  loadKb();
});
$('save').onclick = async () => {
  const server = $('server').value.trim().replace(/\/+$/, ''), token = $('token').value.trim();
  await chrome.storage.sync.set({ server, token });
  $('st').textContent = '测试中…';
  const r = await call('/ext/ping', { page: 'options', version: chrome.runtime.getManifest().version });
  show('st', !!r.data, r.data ? `连接正常（服务器日期 ${r.data.today}）` : `连接失败：${r.error}`);
  if (r.data) loadKb();
};

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function loadKb() {
  const r = await call('/ext/kb', null, 'GET');
  if (r.error) return show('kbst', false, `读取失败：${r.error}`);
  const { docs, stats } = r.data;
  show('kbst', true, `共 ${stats.docs} 份文档（启用 ${stats.enabled}），${stats.chars.toLocaleString()} 字`);
  $('kblist').innerHTML = docs.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:12.5px">${docs.map(d => `<tr style="border-bottom:1px solid #EEF0F3"><td style="padding:4px 0">${d.enabled ? '' : '<span style="color:#B25E09">[停用] </span>'}${esc(d.title)}</td><td style="color:#7A808A">${esc(d.source || '')}</td><td style="text-align:right;color:#7A808A">${d.chars.toLocaleString()} 字</td></tr>`).join('')}</table>`
    : '<p>还没有文档。</p>';
}
async function addDoc(title, content, el) {
  const r = await call('/ext/kb/docs', { title, content });
  show(el, !!r.data, r.data ? `已保存「${title}」，AI 下一条回复起生效` : `保存失败：${r.error}`);
  if (r.data) loadKb();
  return !!r.data;
}
$('kbload').onclick = loadKb;
$('kbsave').onclick = async () => {
  const title = $('kbtitle').value.trim() || '未命名文档', content = $('kbdoc').value;
  if (!content.trim()) return show('kbst2', false, '内容不能为空');
  $('kbst2').textContent = '保存中…';
  if (await addDoc(title, content, 'kbst2')) { $('kbtitle').value = ''; $('kbdoc').value = ''; }
};
$('kbfilebtn').onclick = () => $('kbfile').click();
$('kbfile').onchange = async e => {
  for (const f of e.target.files) await addDoc(f.name.replace(/\.[^.]+$/, ''), await f.text(), 'kbst2');
  e.target.value = '';
};
const admin = hash => { const s = $('server').value.trim().replace(/\/+$/, ''); if (s) chrome.tabs.create({ url: `${s}/#${hash}` }); };
$('openadmin').onclick = () => admin('settings');
$('openkb').onclick = () => admin('kb');
