const $ = id => document.getElementById(id);
chrome.storage.sync.get(['server', 'token']).then(st => {
  $('server').value = st.server || self.HR_CONFIG.server || '';
  $('token').value = st.token || self.HR_CONFIG.token || '';
});
$('save').onclick = async () => {
  const server = $('server').value.trim().replace(/\/+$/, ''), token = $('token').value.trim();
  await chrome.storage.sync.set({ server, token });
  $('st').textContent = '测试中…';
  chrome.runtime.sendMessage({ type: 'api', path: '/ext/ping', body: { page: 'options', version: chrome.runtime.getManifest().version } }, r => {
    $('st').textContent = r && r.data ? `连接正常（服务器日期 ${r.data.today}）` : `连接失败：${r ? r.error : '无响应'}`;
    $('st').style.color = r && r.data ? '#0E8A5F' : '#C4313B';
  });
};
