/* BOSS 直聘 · 筛选巡航助手 —— Service Worker (MV3)
 *
 * 只做轻量协调:默认配置初始化、图标角标统计。
 * 真正的接口取证与判定放在页面上下文(injected.js),
 * 因为 /wapi/ 需要页面自身的会话与风控指纹。
 */
const DEFAULT_CONFIG = {
  enabled: true,
  autoApply: true,
  highlight: true,
  looseMatch: false,
  markColor: '#e5484d',
  authHook: true,
  panelHidden: false,
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.local.get(['config']);
  if (!cur.config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  } else {
    // 补齐后续版本新增的字段
    await chrome.storage.local.set({ config: { ...DEFAULT_CONFIG, ...cur.config } });
  }
  if (details.reason === 'install') {
    console.info('[LCS] 已安装。请打开 BOSS 直聘职位搜索页完成一次筛选，然后点扩展图标保存。');
  }
});

// 角标:显示当前页判定出的双休岗位数量
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'LCS_BADGE') {
    const n = Number(msg.count || 0);
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#00bebd' });
    sendResponse({ ok: true });
  }
  return true;
});
