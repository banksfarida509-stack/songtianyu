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

async function loadKb() {
  const r = await call('/ext/kb', null, 'GET');
  if (r.error) return show('kbst', false, `读取失败：${r.error}`);
  $('kbdoc').value = r.data.kbDoc || '';
  show('kbst', true, `已读取（${$('kbdoc').value.length} 字）`);
}
$('kbload').onclick = loadKb;
$('kbdoc').oninput = () => { $('kbst').textContent = `${$('kbdoc').value.length} / 20000 字（未保存）`; $('kbst').style.color = '#7A808A'; };
$('kbsave').onclick = async () => {
  $('kbst').textContent = '保存中…';
  const r = await call('/ext/kb', { kbDoc: $('kbdoc').value }, 'PUT');
  show('kbst', !!r.data, r.data ? `已保存（${r.data.length} 字），AI 下一条回复起生效` : `保存失败：${r.error}`);
};
$('openadmin').onclick = () => {
  const s = $('server').value.trim().replace(/\/+$/, '');
  if (s) chrome.tabs.create({ url: `${s}/#settings` });
};
