/* LCS 筛选巡航 · popup 逻辑
 * popup 是纯控制台:所有判定与接口调用都在页面里完成,这里只做收发与展示。
 */

const $ = (id) => document.getElementById(id);

const ui = {
  pageState: $('pageState'),
  filterCount: $('filterCount'),
  chips: $('chips'),
  saved: $('saved'),
  apiState: $('apiState'),
  stTotal: $('stTotal'),
  stOut: $('stOut'),
  stFilter: $('stFilter'),
  log: $('log'),
  toast: $('toast'),
  cfgHighlight: $('cfgHighlight'),
  cfgLoose: $('cfgLoose'),
  cfgAuto: $('cfgAuto'),
};

const DEFAULT_CONFIG = {
  enabled: true,
  autoApply: true,
  highlight: true,
  looseMatch: false,
  markColor: '#e5484d',
  authHook: true,
};

let currentTab = null;

function toast(msg, isErr = false) {
  ui.toast.textContent = msg;
  ui.toast.className = 'on' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (ui.toast.className = ''), 2600);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// content script 只在 zhipin.com 上注入,其它页面发消息会抛错,需要兜住
function send(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(resp || { ok: false, error: '空响应' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

/* ------------------------------------------------------------ 筛选条件展示 */

// 把参数名翻译成人话,并在可能时把编码翻译成中文名
function prettyKey(k) {
  return (
    {
      city: '城市',
      query: '关键词',
      experience: '经验',
      degree: '学历',
      salary: '薪资',
      industry: '行业',
      scale: '规模',
      stage: '融资',
      jobType: '类型',
      payType: '结算',
      partTime: '兼职时段',
      position: '职位',
      multiBusinessDistrict: '商圈',
      multiSubway: '地铁',
      district: '区域',
      businessDistrict: '商圈',
      scene: '场景',
    }[k] || k
  );
}

function renderChips(params, container, removable = false, onRemove = null) {
  container.innerHTML = '';
  const entries = Object.entries(params || {}).filter(([, v]) => v !== '' && v !== undefined && v !== null);
  if (!entries.length) {
    container.innerHTML = '<div class="empty">等待页面发起一次搜索请求…</div>';
    return;
  }
  for (const [k, v] of entries) {
    const el = document.createElement('span');
    el.className = 'chip';
    el.innerHTML = `<b>${escapeHtml(prettyKey(k))}</b><i>${escapeHtml(String(v))}</i>`;
    if (removable && onRemove) {
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = '移除该项';
      x.addEventListener('click', () => onRemove(k));
      el.appendChild(x);
    }
    container.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ------------------------------------------------------------------ 刷新 */

async function refresh() {
  currentTab = await activeTab();

  const onZhipin = currentTab && /^https:\/\/([\w-]+\.)?zhipin\.com\//.test(currentTab.url || '');
  if (!onZhipin) {
    ui.pageState.textContent = '非 BOSS 直聘页面';
    ui.pageState.style.color = 'var(--warn)';
    ui.chips.innerHTML = '<div class="empty">请打开 zhipin.com 的职位搜索页</div>';
    ui.apiState.textContent = '未检测';
    await renderSaved();
    return;
  }

  const st = await send(currentTab.id, { type: 'LCS_GET_STATUS' });
  if (!st.ok) {
    ui.pageState.textContent = '脚本未就绪，请刷新页面';
    ui.pageState.style.color = 'var(--warn)';
    ui.apiState.textContent = '无响应';
    await renderSaved();
    return;
  }

  ui.pageState.textContent = st.isJobsPage ? '职位搜索页 ✓' : 'BOSS 直聘（非搜索页）';
  ui.pageState.style.color = st.isJobsPage ? 'var(--ok)' : 'var(--txt-dim)';

  const params = { ...((st.filters && st.filters.params) || {}) };
  const countParams = (p) => Object.values(p || {}).filter((v) => v !== '' && v != null).length;
  ui.filterCount.textContent = countParams(params) + ' 项';

  // 支持在 popup 内逐项剔除。剔除结果回写页面,供“保存/应用”使用。
  const drawChips = () =>
    renderChips(params, ui.chips, true, async (k) => {
      delete params[k];
      await send(currentTab.id, { type: 'LCS_SET_FILTER_PARAMS', params });
      ui.filterCount.textContent = countParams(params) + ' 项';
      drawChips();
    });
  drawChips();

  ui.stTotal.textContent = st.jobsCount || 0;
  ui.stOut.textContent = st.outsourcingCount || 0;
  ui.stFilter.textContent = countParams(params);

  applyConfigToUi(st.config || DEFAULT_CONFIG);

  await renderSaved();
  await renderLog();
}

/* ------------------------------------------------------------ 已保存条件 */

async function renderSaved() {
  const { savedFilters } = await chrome.storage.local.get(['savedFilters']);
  if (!savedFilters || !savedFilters.params) {
    ui.saved.className = 'saved';
    ui.saved.textContent = '尚未保存';
    return;
  }
  const entries = Object.entries(savedFilters.params).filter(([, v]) => v !== '' && v != null);
  if (!entries.length) {
    ui.saved.className = 'saved';
    ui.saved.textContent = '尚未保存';
    return;
  }
  ui.saved.className = 'saved has';
  ui.saved.textContent =
    new Date(savedFilters.savedAt || Date.now()).toLocaleString('zh-CN') +
    '\n' +
    entries.map(([k, v]) => `${prettyKey(k)}=${v}`).join('  ');
}

/* -------------------------------------------------------------- 接口日志 */

async function renderLog() {
  if (!currentTab) return;
  const r = await send(currentTab.id, { type: 'LCS_GET_API_LOG' });
  if (!r.ok) return;

  const items = r.apilog || [];
  ui.log.innerHTML =
    items
      .slice(0, 40)
      .map((it) => {
        const codeCls = it.code === 0 ? 'code0' : it.code === 37 ? 'code37' : '';
        // 区分「页面自己发的」与「扩展主动发的」,排查时这决定看谁的行为
        const via = it.via === 'extension' ? '[扩展]' : '[页面]';
        return `<div class="row"><span class="${codeCls}">${it.code}</span><span class="url">${via} ${escapeHtml(it.url || '')}</span></div>`;
      })
      .join('') || '<div class="row"><span>暂无接口调用</span></div>';

  // 通过最近一次 joblist 调用的状态码判断风控是否触发
  const lastList = items.find((i) => i.kind === 'joblist');
  if (!lastList) ui.apiState.textContent = '未捕获';
  else if (lastList.code === 0) ui.apiState.textContent = '正常 (code 0)';
  else if (lastList.code === 37) ui.apiState.textContent = '风控拦截 (code 37)';
  else ui.apiState.textContent = '异常 (code ' + lastList.code + ')';
}

function applyConfigToUi(cfg) {
  ui.cfgHighlight.checked = !!cfg.highlight;
  ui.cfgLoose.checked = !!cfg.looseMatch;
  ui.cfgAuto.checked = !!cfg.autoApply;
}

/* ------------------------------------------------------------------ 交互 */

$('btnSave').addEventListener('click', async () => {
  if (!currentTab) return;
  const r = await send(currentTab.id, { type: 'LCS_SAVE_FILTER' });
  if (!r.ok) return toast('保存失败:' + (r.error || ''), true);
  const n = Object.values(r.saved || {}).filter((v) => v !== '' && v != null).length;
  if (!n) return toast('当前没有可保存的筛选条件', true);
  // 城市不入库:它跟随你当前所在位置,不该被长期沿用
  toast(r.cityOmitted ? `已保存 ${n} 项(城市不保存,跟随当前位置)` : `已保存 ${n} 项筛选条件`);
  await renderSaved();
});

$('btnApply').addEventListener('click', async () => {
  if (!currentTab) return;
  const r = await send(currentTab.id, { type: 'LCS_APPLY_FILTER' });
  if (!r.ok) return toast('应用失败:' + (r.error || ''), true);

  // 按返回码给出可执行的下一步,而不是只报一个数字
  if (r.apiCode === 0) {
    toast('已应用并触发查询');
  } else if (r.apiCode === 37) {
    toast('已应用,但接口触发风控(code 37):请确认页面已登录并正常浏览', true);
  } else if (r.apiCode === 7) {
    toast('已应用,但登录状态已失效(code 7):请先登录', true);
  } else {
    toast('已应用,接口返回 code ' + r.apiCode, true);
  }
  setTimeout(refresh, 1400);
});

$('btnRescan').addEventListener('click', async () => {
  if (!currentTab) return;
  await send(currentTab.id, { type: 'LCS_RESCAN' });
  toast('已重新扫描');
  setTimeout(refresh, 900);
});

$('btnLog').addEventListener('click', () => {
  ui.log.hidden = !ui.log.hidden;
  $('btnLog').textContent = ui.log.hidden ? '展开' : '收起';
  if (!ui.log.hidden) renderLog();
});

[
  ['cfgHighlight', 'highlight'],
  ['cfgLoose', 'looseMatch'],
  ['cfgAuto', 'autoApply'],
].forEach(([id, key]) => {
  $(id).addEventListener('change', async () => {
    const { config } = await chrome.storage.local.get(['config']);
    const next = { ...DEFAULT_CONFIG, ...(config || {}), [key]: $(id).checked };
    await chrome.storage.local.set({ config: next });
    if (currentTab) await send(currentTab.id, { type: 'LCS_SET_CONFIG', config: next });
    toast('已更新设置');
  });
});

refresh();
setInterval(refresh, 3000);
