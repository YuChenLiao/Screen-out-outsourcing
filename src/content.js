/* BOSS 直聘 · 筛选巡航助手 —— 隔离世界 content script
 *
 * 职责:
 *   1. document_start 注入主世界钩子(接口嗅探必须在页面 JS 上下文里跑)
 *   2. 扫描职位卡片 DOM,把标明「派遣/外包」的岗位标红
 *   3. 按需把卡片 jobId 抛给主世界补全详情
 *   4. 进入页面时把保存的筛选条件回填到 URL / 触发一次查询
 *
 * 为什么高亮要放在这一层:
 *   主世界脚本无法使用 chrome.* API,也无法安全操作扩展状态;
 *   DOM 渲染放在隔离世界可以避免污染页面自身的 Vue 运行时。
 */
(() => {
  'use strict';

  const TAG = '[LCS]';
  const SITE = location.origin;
  const isJobsPage = /\/web\/geek\/(jobs|joblist)/.test(location.pathname) || location.pathname === '/';

  let config = {
    enabled: true,
    autoApply: true, // 进页面自动应用保存的筛选
    highlight: true, // 标红派遣/外包岗位
    looseMatch: false, // 宽松匹配:额外扫描福利/技能标签
    markColor: '#e5484d', // 标红颜色
    authHook: true, // 复用页面登录凭证,失效时自动刷新并重试
  };

  const state = {
    jobs: {},
    filters: {},
    requested: new Set(),
    stats: { total: 0, outsourcing: 0 },
  };

  /* ----------------------------------------------------------- 注入主世界 */

  function injectMainWorld() {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('src/injected.js');
      s.async = false;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn(TAG, '注入失败', e);
    }
  }

  if (document.readyState === 'loading') {
    injectMainWorld();
  } else {
    injectMainWorld();
  }

  /* --------------------------------------------------------------- 状态桥 */

  function syncSnapshot() {
    // 主世界的状态落在 localStorage,隔离世界同源可读
    try {
      const raw = localStorage.getItem('lcs:jobs');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.jobs) state.jobs = parsed.jobs;
      }
      const rf = localStorage.getItem('lcs:filters');
      if (rf) state.filters = JSON.parse(rf);
    } catch {}
  }

  window.addEventListener('lcs:update', () => {
    syncSnapshot();
    // 数据到了先立刻重绘面板:计数直接从 state.jobs 算,
    // 不必等 400ms 的 DOM 扫描 —— 这正是"标识已更新但计数没跟上"的成因。
    scheduleRenderPanel(0);
    scheduleScan();
  });

  // 主世界完成凭证刷新后,重绘面板即可(计数来自内存状态,不必等 DOM)
  window.addEventListener('lcs:auth', () => {
    scheduleRenderPanel(0);
  });

  /* ------------------------------------------------------------ 卡片扫描 */

  const CARD_SELECTORS = [
    'li.job-card-wrapper',
    'li.job-card-box',
    '.job-card-wrapper',
    '.job-list-box li',
    '[class*="job-card"]',
  ];

  function collectCards() {
    const out = [];
    const seen = new Set();
    for (const sel of CARD_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      nodes.forEach((n) => {
        if (seen.has(n)) return;
        // 过滤掉非岗位卡片的容器(例如包含多张卡片的父级)
        if (n.querySelector(CARD_SELECTORS[0]) || n.querySelector('.job-name')) {
          if (!n.querySelector('.job-name') && n.querySelector('li')) return;
        }
        seen.add(n);
        out.push(n);
      });
      if (out.length) break;
    }
    return out;
  }

  function jobIdFromCard(card) {
    const a = card.querySelector('a.job-name, a[href*="/job_detail/"]');
    if (!a) return null;
    const m = /\/job_detail\/([^/.]+)\.html/.exec(a.getAttribute('href') || '');
    return m ? m[1] : null;
  }

  function cardText(card, sel) {
    const el = card.querySelector(sel);
    return el ? (el.textContent || '').trim() : '';
  }

  // 岗位名与公司名的 DOM 选择器。zhipin 改版频繁,同时尝试多个。
  const TITLE_SELECTORS = ['.job-name', 'a[href*="/job_detail/"]', '.job-title .job-name', '[class*="job-name"]'];
  const COMPANY_SELECTORS = ['.boss-name', '.company-name', '.job-card-footer .boss-name', '[class*="company-name"]'];

  function readFirstText(card, selectors) {
    for (const sel of selectors) {
      const el = card.querySelector(sel);
      const t = el ? (el.textContent || '').trim() : '';
      if (t) return t;
    }
    return '';
  }

  // 判定函数来自 src/shared/judge.js(在 manifest 中先于本文件加载)
  const judge = window.__LCS_JUDGE__ || {
    judgeJob: () => ({ isOutsourcing: false, word: null, field: null }),
    judgeJobLoose: () => ({ isOutsourcing: false, word: null, field: null }),
  };

  // DOM 兜底判定:接口数据还没到时,先用卡片上的岗位名/公司名判一次。
  // 这也让"接口被风控挡住"时标记依然可用。
  function judgeFromDom(card) {
    const job = {
      title: readFirstText(card, TITLE_SELECTORS),
      company: readFirstText(card, COMPANY_SELECTORS),
    };
    return config.looseMatch ? judge.judgeJobLoose(job) : judge.judgeJob(job);
  }

  /* -------------------------------------------------------------- 高亮渲染 */

  const STYLE_ID = 'lcs-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      const el = document.getElementById(STYLE_ID);
      el.textContent = buildCss();
      return;
    }
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = buildCss();
    (document.head || document.documentElement).appendChild(st);
  }

  function buildCss() {
    const c = config.markColor || '#e5484d'; // 红色:派遣/外包警示色
    return `
    .lcs-card { position: relative !important; transition: box-shadow .18s ease, transform .18s ease; }
    /* 派遣/外包标记:整条红色外框 + 左侧粗红条,视觉上一眼可辨 */
    .lcs-outsourcing {
      box-shadow: inset 4px 0 0 0 ${c}, 0 0 0 1px ${c}55 !important;
      border-radius: 8px;
      background: ${c}0d !important;
    }
    .lcs-outsourcing .job-name, .lcs-outsourcing .job-title { color:${c} !important; }
    .lcs-badge {
      display:inline-flex; align-items:center; gap:4px;
      margin-left:8px; padding:1px 7px; border-radius:999px;
      font-size:11px; line-height:16px; font-weight:600; vertical-align:middle;
      background:${c}; color:#fff; white-space:nowrap;
    }
    /* 标记徽章固定在卡片右上角,避免与页面自身布局互相挤压 */
    .lcs-badge-fixed {
      position:absolute; top:6px; right:8px; margin-left:0; z-index:2;
      box-shadow:0 1px 4px rgba(0,0,0,.18);
    }
    .lcs-panel {
      position:fixed; right:18px; bottom:18px; z-index:2147483000;
      width:296px; max-height:60vh; overflow:auto;
      background:#0f172a; color:#e2e8f0; border-radius:12px;
      font:12px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
      box-shadow:0 18px 48px #0f172a55; border:1px solid #1e293b;
    }
    .lcs-panel h4 { margin:0; padding:10px 12px; font-size:12px; font-weight:600;
      background:#1e293b; border-radius:12px 12px 0 0; display:flex; justify-content:space-between; align-items:center;
      cursor:move; touch-action:none; user-select:none; }
    .lcs-panel .lcs-title { flex:1; }
    .lcs-dragging { opacity:.92; }
    .lcs-dragging h4 { cursor:grabbing; }
    .lcs-dragging, .lcs-dragging * { user-select:none !important; }
    .lcs-panel .lcs-body { padding:10px 12px; }
    .lcs-row { display:flex; justify-content:space-between; gap:8px; padding:3px 0; }
    .lcs-row span:first-child { color:#94a3b8; }
    .lcs-close { cursor:pointer; color:#94a3b8; padding:0 4px; }
    .lcs-close:hover { color:#fff; }
    .lcs-tag { display:inline-block; margin:2px 3px 0 0; padding:0 6px; border-radius:4px;
      background:#1e293b; color:#7dd3fc; font-size:11px; }
    .lcs-detail { margin:6px 0 2px; padding:6px 8px; background:#1e293b66; border-radius:6px; }
    .lcs-empty { color:#94a3b8; text-align:center; padding:14px 0; }
    `;
  }

  // 把「判定 + 样式 + 计数」绑在一起。这个约束来自一个真实 bug:
  // 判定在渲染时实时计算,而计数只在 DOM 扫描时重算,导致接口数据到达后
  // (卡片已变样式,但 DOM 没变)计数停在上一次的值。
  // 计数器改为由判定结果直接驱动,只要卡片重绘就必然更新。
  function applyOutsourcingVerdict(card, verdict) {
    const jobId = jobIdFromCard(card);

    const badge = card.querySelector(':scope > .lcs-badge');
    if (badge) badge.remove();

    const hit = verdict && verdict.isOutsourcing === true;

    if (hit) {
      card.classList.add('lcs-outsourcing');
      // 徽章显示命中的具体词,让判定理由可追溯,而不是一个无从验证的红块
      const label = verdict.word ? '派遣/外包 · ' + verdict.word : '派遣/外包';
      const tip = `LCS:命中「${verdict.word || '外包/派遣'}」(${verdict.field === 'company' ? '公司名' : '岗位名'})`;
      card.appendChild(makeBadge(label, 'lcs-badge lcs-badge-fixed', jobId, tip));
    } else {
      card.classList.remove('lcs-outsourcing');
    }

    // 注:曾有一个「只看派遣/外包」开关,会在这里隐藏非外包卡片,现已按需求移除。
    // 隐藏岗位会让人误以为页面数据不全,标记本身已经足够表达。
    // 旧版本可能给卡片加过 lcs-hidden 类,这里顺手清掉 ——
    // 插件升级但用户未刷新页面时,该残留类会让卡片一直不可见。
    card.classList.remove('lcs-hidden');

    state.stats.total++;
    if (hit) state.stats.outsourcing++;

    return jobId;
  }

  function renderCard(card) {
    const jobId = jobIdFromCard(card);
    if (!jobId) return null;

    card.classList.add('lcs-card');
    const job = state.jobs[jobId];

    // 双源判定,任一命中即标红:
    //   接口侧 —— 已归集的岗位名/公司名(最可靠,数据来自响应)
    //   DOM 侧 —— 卡片上直接读到的文字(接口被风控挡住时仍可用)
    const domVerdict = judgeFromDom(card);
    let verdict = domVerdict;

    if (job && job.isOutsourcing) {
      verdict = { isOutsourcing: true, word: job.outsourcingWord, field: job.outsourcingField };
    } else if (job && job.company && !domVerdict.company) {
      // 接口有更完整的公司名时,用它再判一次(卡片上公司名可能被截断)
      const fromApi = config.looseMatch
        ? judge.judgeJobLoose({ title: job.title, company: job.company, welfare: job.welfare, tags: job.tags })
        : judge.judgeJob({ title: job.title, company: job.company });
      if (fromApi.isOutsourcing) verdict = fromApi;
    }

    applyOutsourcingVerdict(card, verdict);
    return { jobId, verdict };
  }

  // 面板计数:从已归集的岗位数据算,与卡片判定同一数据源
  function countOutsourcing() {
    const all = Object.values(state.jobs);
    return {
      jobs: all.length,
      outsourcing: all.filter((j) => j.isOutsourcing === true).length,
    };
  }

  function makeBadge(text, cls, jobId, title) {
    const b = document.createElement('span');
    b.className = cls;
    b.textContent = text;
    b.dataset.lcsJob = jobId;
    b.title = title || 'LCS:该岗位标明派遣/外包';
    return b;
  }

  /* ------------------------------------------------------------ 扫描调度 */

  let scanTimer = null;
  let panelTimer = null;

  // DOM 扫描:负责卡片判定与样式,较重,去抖久一些
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 400);
  }

  // 面板重绘:只读内存状态,很轻,可立即执行。
  // 计数不依赖 DOM,所以接口数据到达时可以马上更新,不必等 DOM 变化。
  function scheduleRenderPanel(delay = 0) {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => {
      // 不再重置 state.stats:面板计数统一由 countOutsourcing() 从 state.jobs 计算,
      // 重置这个对象只会让 popup 侧的统计与面板不一致。
      renderPanel(lastCardCount);
    }, delay);
  }

  let lastCardCount = 0;

  function scan() {
    if (!config.enabled) return;
    ensureStyle();

    const cards = collectCards();
    if (!cards.length) {
      // 页面暂无卡片(切换筛选/城市后可能短暂为空),仍需刷新面板以免计数残留
      scheduleRenderPanel(0);
      return;
    }

    state.stats = { total: 0, outsourcing: 0 };

    for (const card of cards) {
      renderCard(card);
    }

    lastCardCount = cards.length;
    renderPanel(cards.length);
  }

  /* --------------------------------------------------------------- 悬浮面板 */

  let panel = null;

  // 面板位置持久化:刷新后仍在原处
  const PANEL_POS_KEY = 'lcs:panelpos';

  function loadPanelPos() {
    try {
      const raw = localStorage.getItem(PANEL_POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.left === 'number' && typeof p.top === 'number') return p;
    } catch {}
    return null;
  }

  function savePanelPos(left, top) {
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left, top }));
    } catch {}
  }

  function clampPanelPos(left, top) {
    const w = panel.offsetWidth || 296;
    const h = panel.offsetHeight || 200;
    // 留 24px 可见,避免拖出屏幕后找不回来
    const maxLeft = Math.max(0, window.innerWidth - 24);
    const maxTop = Math.max(0, window.innerHeight - 24);
    return {
      left: Math.min(Math.max(left, -(w - 24)), maxLeft),
      top: Math.min(Math.max(top, 0), maxTop),
    };
  }

  function applyPanelPos(left, top) {
    const { left: l, top: t } = clampPanelPos(left, top);
    panel.style.left = l + 'px';
    panel.style.top = t + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    return { left: l, top: t };
  }

  // 拖动:整个标题栏作为把手。用 Pointer Events 统一鼠标/触屏。
  function makePanelDraggable() {
    const handle = panel.querySelector('h4');
    if (!handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      // 别和关闭按钮抢事件
      if (e.target.closest('.lcs-close')) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
      panel.classList.add('lcs-dragging');
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = startLeft + (e.clientX - startX);
      const top = startTop + (e.clientY - startY);
      applyPanelPos(left, top);
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('lcs-dragging');
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
      const rect = panel.getBoundingClientRect();
      const p = applyPanelPos(rect.left, rect.top);
      savePanelPos(p.left, p.top);
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    // 窗口尺寸变化时把面板拉回可视区域
    window.addEventListener('resize', () => {
      const rect = panel.getBoundingClientRect();
      const p = applyPanelPos(rect.left, rect.top);
      savePanelPos(p.left, p.top);
    });
  }

  function renderPanel(cardCount) {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'lcs-panel';
      panel.innerHTML = `
        <h4 title="按住拖动"><span class="lcs-title">LCS 筛选巡航</span><span class="lcs-close" title="收起">×</span></h4>
        <div class="lcs-body"></div>`;
      panel.querySelector('.lcs-close').addEventListener('click', () => {
        panel.style.display = 'none';
        chrome.storage?.local?.set({ panelHidden: true });
      });

      // 恢复上次位置,否则用默认的右下角
      const saved = loadPanelPos();
      if (saved) applyPanelPos(saved.left, saved.top);

      makePanelDraggable();
      document.body.appendChild(panel);
    }
    if (panel.style.display === 'none') return;

    // 每次重绘前用 URL 兜底同步一次,确保面板反映真实筛选
    syncFiltersFromUrl();

    const f = state.filters && state.filters.params ? state.filters.params : {};
    const paramLines = Object.entries(f)
      .filter(([, v]) => v !== '' && v !== undefined && v !== null)
      .map(([k, v]) => `<span class="lcs-tag">${escapeHtml(k)}=${escapeHtml(String(v))}</span>`)
      .join('') || '<div class="lcs-empty">尚未捕获筛选条件</div>';

    // 计数统一从这里取,确保面板与卡片判定同源
    const c = countOutsourcing();
    const shown = cardCount === undefined ? c.jobs : cardCount;

    panel.querySelector('.lcs-body').innerHTML = `
      <div class="lcs-detail">
        <div class="lcs-row"><span>已捕获筛选</span><span>${Object.keys(f).length} 项</span></div>
        <div>${paramLines}</div>
      </div>
      <div class="lcs-row"><span>本页岗位</span><span>${shown}</span></div>
      <div class="lcs-row"><span>派遣/外包</span><span style="color:#e5484d;font-weight:600">${c.outsourcing}</span></div>
      <div class="lcs-row"><span>已入库岗位</span><span>${c.jobs}</span></div>
      <div class="lcs-row"><span>标红开关</span><span>${config.highlight ? '开' : '关'}</span></div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /* ------------------------------------------------------- 自动应用筛选条件 */

  // 参与「当前筛选条件」的 URL 参数。
  // 必须与主世界的 FILTER_PARAM_KEYS 完全一致 —— 两边读同一个 URL,
  // 键集不同就会算出不同的筛选项(曾经漏掉 city,导致面板与 popup 各显示一套)。
  // 注意:保存默认条件时会单独剔除 city(城市跟随当前位置,见 LCS_SAVE_FILTER)。
  const USER_INTENT_KEYS = ['city', 'query', 'experience', 'degree', 'salary', 'industry', 'scale', 'stage', 'jobType', 'payType', 'partTime', 'position', 'multiBusinessDistrict', 'multiSubway', 'district', 'businessDistrict', 'barrierFreeType'];

  function currentUrlParams() {
    const sp = new URLSearchParams(location.search);
    const out = {};
    for (const k of USER_INTENT_KEYS) if (sp.has(k)) out[k] = sp.get(k);
    return out;
  }

  function hasMeaningfulFilters(p) {
    return Object.entries(p || {}).some(([, v]) => v !== '' && v !== undefined && v !== null);
  }

  // 用 URL 上的筛选参数兜底更新面板显示。
  // 这一步不触发请求,只保证面板与 popup 都反映当前真实筛选。
  //
  // 关键:必须把结果写回 localStorage。隔离世界读不到主世界的 window,
  // localStorage 是两个世界唯一共享的通道;只改内存会导致 popup 读到旧值
  // (表现为「面板有 3 项、popup 显示 0 项」)。
  function syncFiltersFromUrl() {
    const fromUrl = currentUrlParams();
    const meaningful = {};
    for (const [k, v] of Object.entries(fromUrl)) {
      if (v !== '' && v !== undefined && v !== null) meaningful[k] = v;
    }
    if (!hasMeaningfulFilters(meaningful)) return false;

    const prev = state.filters && state.filters.params ? state.filters.params : {};
    if (JSON.stringify(prev) === JSON.stringify(meaningful)) return false;

    state.filters = { ...state.filters, params: meaningful, updatedAt: Date.now(), source: 'url' };
    try {
      localStorage.setItem('lcs:filters', JSON.stringify(state.filters));
    } catch {}
    return true;
  }

  // 清掉历史遗留的非筛选参数(例如 scene),避免面板显示接口内部字段、
  // 或被保存进“默认筛选”里写回 URL。两处来源都要清:运行态与已保存条件。
  function sanitizeStoredFilters() {
    const pick = (params) => {
      const cleaned = {};
      for (const k of USER_INTENT_KEYS) {
        if (params && params[k] !== undefined) cleaned[k] = params[k];
      }
      return cleaned;
    };

    try {
      const raw = localStorage.getItem('lcs:filters');
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.params) {
          const cleaned = pick(d.params);
          if (JSON.stringify(cleaned) !== JSON.stringify(d.params)) {
            localStorage.setItem('lcs:filters', JSON.stringify({ ...d, params: cleaned }));
            state.filters = { ...state.filters, params: cleaned };
            console.info(TAG, '已清理运行态筛选中的非筛选参数');
          }
        }
      }
    } catch {}

    try {
      chrome.storage?.local?.get(['savedFilters'], (r) => {
        const saved = r && r.savedFilters;
        if (!saved || !saved.params) return;
        const cleaned = pick(saved.params);
        if (JSON.stringify(cleaned) !== JSON.stringify(saved.params)) {
          chrome.storage.local.set({ savedFilters: { ...saved, params: cleaned } });
          console.info(TAG, '已清理已保存筛选中的非筛选参数');
        }
      });
    } catch {}
  }

  async function applySavedFilters() {
    if (!config.autoApply || !isJobsPage) return false;

    const stored = await getStored();
    const saved = stored.savedFilters;
    if (!saved || !saved.params || !hasMeaningfulFilters(saved.params)) return false;

    // 用户此刻 URL 里已有筛选 => 尊重用户当前意图,不覆盖。
    // 仅带 city 不算用户筛选过(城市是站点自动带的),此时仍应回填保存的条件。
    const cur = currentUrlParams();
    const curSansCity = { ...cur };
    delete curSansCity.city;
    if (hasMeaningfulFilters(curSansCity)) {
      console.info(TAG, '当前 URL 已有筛选条件,跳过自动回填');
      return false;
    }

    // 已在本次会话回填过 => 不重复(避免与 SPA 路由打架)
    const sig = JSON.stringify(saved.params);
    if (sessionStorage.getItem('lcs:applied') === sig) return false;

    console.info(TAG, '应用保存的筛选条件', saved.params);
    sessionStorage.setItem('lcs:applied', sig);

    applyFiltersToUrl(saved.params);
    // 经 DOM 事件请主世界发起一次真实查询(隔离世界调不到主世界的函数)。
    // URL 改写会让 SPA 自己重查;这里的主动请求是兜底,确保条件确实生效。
    requestListFetch(saved.params, 1);
    return true;
  }

  /* ---------------------------------------- 隔离世界 -> 主世界的事件通道
   *
   * Chrome 的隔离世界机制下,content script 访问不到页面主世界的 window:
   * 实测 window.__LCS_FETCH_LIST__ / __LCS_SET_FILTERS__ / __LCS_SNAPSHOT__
   * 在隔离世界全部为 undefined(只有扩展注入的 __LCS_JUDGE__ 可见)。
   * 因此反向指令必须走 DOM 事件 —— 事件是两个世界都能观察到的。
   */
  function requestListFetch(params, page) {
    document.dispatchEvent(new CustomEvent('lcs:req-fetch', { detail: { params: params || {}, page: page || 1 } }));
  }

  function requestResetCache() {
    document.dispatchEvent(new CustomEvent('lcs:req-reset'));
  }

  // 接收主世界的查询结果(用于诊断与提示)
  document.addEventListener('lcs:req-fetch-done', (e) => {
    const d = (e && e.detail) || {};
    state.lastFetch = d;
    if (d.code !== undefined && d.code !== 0) {
      console.info(TAG, '主动查询返回 code', d.code, d.error || '');
    }
  });

  // 把筛选参数写进 URL 并让 SPA 感知。
  // 注意:只设置/删除「明确出现在 params 里」的键,不碰 city —— 避免把用户
  // 当前所在城市改掉。旧版本保存过 city 的条件也由此被隔离。
  function applyFiltersToUrl(params) {
    const url = new URL(location.href);
    for (const k of USER_INTENT_KEYS) {
      if (k === 'city') continue; // 城市跟随当前位置,不由保存条件决定
      if (!(k in (params || {}))) continue;
      const v = params[k];
      if (v === '' || v === undefined || v === null) url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    if (url.toString() !== location.href) {
      history.replaceState(history.state, '', url.toString());
      // SPA 监听 popstate / 自定义事件,派发一次以触发其内部重算
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }
  }

  /* ------------------------------------------------------------- 消息通道 */

  function getStored() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['savedFilters', 'config'], (r) => resolve(r || {}));
      } catch {
        resolve({});
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'LCS_GET_STATUS': {
          // 筛选状态从 localStorage 读:主世界写入(URL 变化时同步),
          // 隔离世界读不到主世界的 window,localStorage 是两者唯一共享的通道。
          syncSnapshot();
          const all = Object.values(state.jobs);
          sendResponse({
            ok: true,
            url: location.href,
            isJobsPage,
            filters: state.filters,
            jobsCount: all.length,
            outsourcingCount: all.filter((j) => j.isOutsourcing === true).length,
            stats: state.stats,
            config,
          });
          break;
        }
        case 'LCS_SET_FILTER_PARAMS': {
          // popup 侧增删筛选项:直接落到 URL 上,让 URL 保持唯一权威。
          // 只在内存里改状态会造成“面板显示 X、页面实际按 Y 查询”的脱节。
          const cleaned = {};
          for (const [k, v] of Object.entries(msg.params || {})) {
            if (k === 'city') continue;
            if (v === '' || v === undefined || v === null) continue;
            cleaned[k] = v;
          }
          // 先清掉 URL 上已有的用户意图参数,再按新集合写回 —— 这样被删掉的项
          // 会真正从 URL 消失,而不是留在那里继续生效。
          const url = new URL(location.href);
          for (const k of USER_INTENT_KEYS) {
            if (k === 'city') continue;
            if (!(k in cleaned)) url.searchParams.delete(k);
          }
          for (const [k, v] of Object.entries(cleaned)) url.searchParams.set(k, String(v));
          if (url.toString() !== location.href) {
            history.replaceState(history.state, '', url.toString());
            window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
          }

          state.filters = { ...state.filters, params: cleaned, updatedAt: Date.now(), source: 'manual' };
          try {
            localStorage.setItem('lcs:filters', JSON.stringify(state.filters));
          } catch {}
          renderPanel(collectCards().length);
          sendResponse({ ok: true, filters: state.filters, url: location.href });
          break;
        }
        case 'LCS_SAVE_FILTER': {
          // 保存“当前页面的筛选条件”;若页面 URL 没有则回落到已捕获的接口参数
          const cur = currentUrlParams();
          const picked = hasMeaningfulFilters(cur) ? cur : (state.filters.params || {});
          // 刻意剔除 city:城市是你此刻所在位置,不是要看长期沿用的条件。
          // 若把城市一起保存,下次进入任何城市都会被强行改成保存的那个。
          const params = {};
          for (const [k, v] of Object.entries(picked)) {
            if (k === 'city') continue;
            if (v === '' || v === undefined || v === null) continue;
            params[k] = v;
          }
          await new Promise((r) => chrome.storage.local.set({ savedFilters: { params, savedAt: Date.now() } }, r));
          sendResponse({ ok: true, saved: params, cityOmitted: !!picked.city });
          break;
        }
        case 'LCS_APPLY_FILTER': {
          const stored = await getStored();
          const saved = msg.params ? { params: msg.params } : stored.savedFilters;
          if (!saved) return sendResponse({ ok: false, error: '没有已保存的筛选条件' });
          sessionStorage.removeItem('lcs:applied');
          applyFiltersToUrl(saved.params);
          // 事件是异步的,结果稍后经 lcs:req-fetch-done 回来。
          // 这里同步返回"已应用",不等查询结果,避免 popup 卡住。
          requestListFetch(saved.params, 1);
          syncSnapshot();
          scheduleScan();
          sendResponse({ ok: true, applied: saved.params, apiCode: null, pending: true });
          break;
        }
        case 'LCS_SET_CONFIG': {
          config = { ...config, ...(msg.config || {}) };
          await new Promise((r) => chrome.storage.local.set({ config }, r));
          // 主世界读不到 chrome.storage,配置镜像经 localStorage 下发
          try {
            localStorage.setItem(
              'lcs:config',
              JSON.stringify({ authHook: config.authHook, markColor: config.markColor, looseMatch: config.looseMatch }),
            );
          } catch {}
          if (config.panelHidden === false && panel) panel.style.display = '';
          if (config.panelHidden === true && panel) panel.style.display = 'none';
          syncSnapshot();
          scheduleScan();
          sendResponse({ ok: true, config });
          break;
        }
        case 'LCS_RESCAN': {
          syncSnapshot();
          state.requested = new Set();
          requestResetCache(); // 经 DOM 事件通知主世界(隔离世界调不到它的函数)
          setTimeout(scan, 300);
          sendResponse({ ok: true });
          break;
        }
        case 'LCS_GET_API_LOG': {
          let log = { items: [] };
          try {
            log = JSON.parse(localStorage.getItem('lcs:apilog') || '{"items":[]}');
          } catch {}
          let filters = null;
          try {
            filters = JSON.parse(localStorage.getItem('lcs:filters') || 'null');
          } catch {}
          sendResponse({ ok: true, apilog: log.items, filters });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
      }
    })();
    return true; // 异步响应
  });

  /* ---------------------------------------------------------- 启动与监听 */

  // 启动流程。
  // 注意:不再等待主世界的函数就绪 —— 隔离世界访问不到它们(实测均为 undefined),
  // 两个世界的协作只经由 localStorage 与 DOM 事件,无需等待。
  (async () => {
    const stored = await getStored();
    if (stored.config) config = { ...config, ...stored.config };
    if (stored.panelHidden) config.panelHidden = true;

    // 启动时先把配置下发给主世界(它读不到 chrome.storage)
    try {
      localStorage.setItem(
        'lcs:config',
        JSON.stringify({ authHook: config.authHook, markColor: config.markColor, looseMatch: config.looseMatch }),
      );
    } catch {}

    // 先读主世界写下的快照,再用 URL 校正一次
    syncSnapshot();
    sanitizeStoredFilters();
    syncFiltersFromUrl();
    await applySavedFilters();
    scheduleScan();
  })();

  // 懒加载 / 路由切换 / 筛选面板变化都通过 DOM 变更驱动
  const mo = new MutationObserver(() => scheduleScan());
  function startObserver() {
    if (!document.body) return setTimeout(startObserver, 200);
    mo.observe(document.body, { childList: true, subtree: true });
  }
  startObserver();

  // SPA 路由变化。content script 只在真实页面加载时注入一次,
  // 若用户在站内跳到搜索页(未刷新),必须靠路由钩子重新触发一次回填。
  ['pushState', 'replaceState'].forEach((k) => {
    const orig = history[k];
    history[k] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(onRouteChange, 200);
      return r;
    };
  });
  window.addEventListener('popstate', () => setTimeout(onRouteChange, 300));

  let lastHref = location.href;
  let lastSearch = location.search;

  function onRouteChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;

    const onJobsNow = /\/web\/geek\/(jobs|joblist)/.test(location.pathname) || location.pathname === '/';
    if (!onJobsNow) return;

    // 筛选条件(含城市)会编码在 query 上。用户点筛选/切城市后若 SPA 只改 query,
    // 必须让面板里的条件与计数立刻跟着变,不能等 400ms 的 DOM 扫描。
    if (location.search !== lastSearch) {
      lastSearch = location.search;
      const fromUrl = currentUrlParams(); // 仅取用户意图键,排除 page/lid 等
      if (Object.keys(fromUrl).length) {
        state.filters = { ...state.filters, params: fromUrl, updatedAt: Date.now(), source: 'url' };
        try {
          localStorage.setItem('lcs:filters', JSON.stringify(state.filters));
        } catch {}
      }
      state.requested = new Set();
      // 本页卡片整体换了一批,先清计数等扫描重建,避免短暂显示旧数字
      scheduleRenderPanel(0);
    }

    // applySavedFilters 内部会判断“URL 已有筛选则尊重用户操作”,不会覆盖新城市
    applySavedFilters().then(() => scheduleScan());
  }
})();
