/* BOSS 直聘 · 筛选巡航助手 —— 页面主世界(main world)注入脚本
 *
 * 存在的理由:
 *   zhipin 的 /wapi/ 接口依赖真实浏览器会话 cookie,且对非浏览器环境返回
 *   {"code":37,"message":"您的环境存在异常."}。因此所有接口取证必须发生在
 *   页面自身的 JS 上下文里,由页面自己发出请求。
 *
 * 该文件做三件事:
 *   1. 被动嗅探 joblist / recommend-job-list 的【请求参数】与【响应数据】
 *      —— 请求参数即“当前真实筛选条件”,这是同步筛选的唯一可信来源。
 *   2. 主动发起岗位详情请求,读取福利标签,用于判定“双休”。
 *   3. 把结果落到 localStorage 并派发 DOM 事件,交给隔离世界的 content.js。
 *
 * 与 content.js 的桥接见 window.__LCS_BRIDGE_KEY__。
 */
(() => {
  'use strict';

  const TAG = '[LCS]';
  const BRIDGE_KEY = '__LCS_BRIDGE__';
  if (window[BRIDGE_KEY]) return;
  window[BRIDGE_KEY] = true;

  const LS_JOBS = 'lcs:jobs';
  const LS_FILTERS = 'lcs:filters';
  const LS_API_LOG = 'lcs:apilog';
  const LS_CONFIG = 'lcs:config';
  const EVT = 'lcs:update';

  // 主世界侧的配置镜像。隔离世界通过 localStorage 下发,
  // 因为主世界读不到 chrome.storage。
  let config = { authHook: true };
  function loadConfig() {
    try {
      const raw = localStorage.getItem(LS_CONFIG);
      if (raw) config = { ...config, ...JSON.parse(raw) };
    } catch {}
  }
  loadConfig();

  /* ---------------------------------------------------------------- 工具 */

  const now = () => Date.now();

  // localStorage 写入做防抖,避免列表懒加载时高频 IO
  // 写入 localStorage。
  // 曾经这里做了 700ms 防抖,导致一个隐蔽 bug:
  // emit('joblist') 是立刻发出的,而数据 700ms 后才落盘,
  // 于是隔离世界收到事件时读到的仍是旧数据;等真正写入时又没有任何事件通知它,
  // 计数就永久停在旧值(卡片标识靠后续 DOM 扫描补上了,计数没有)。
  // 一次写入最多几十条岗位,直接同步写,代价远小于这个 bug。
  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn(TAG, 'localStorage 写入失败', e);
    }
  }

  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function emit(reason) {
    try {
      window.dispatchEvent(new CustomEvent(EVT, { detail: { reason, ts: now() } }));
    } catch {}
  }

  /* ============================================================== 认证层
   *
   * 依据页面自身的实现(实测解构,非推测):
   *
   * 1) 请求头认证 —— 页面 axios 拦截器对每个 /wapi/ 请求注入:
   *      headers['X-Requested-With'] = 'XMLHttpRequest'
   *      headers.traceId              = <追踪 id>
   *      headers.token                = window._PAGE.token.split('|')[0]
   *      headers.zp_token             = cookie 'bst'
   *
   * 2) 登录态 —— window._PAGE(服务端注入,见 /wapi/zpgeek/common/data/header.json)
   *      未登录: { isLogin: false, identity: -1 }
   *      字段: userId / uid / token / identity
   *
   * 3) 登录失效码 —— 7=登录状态已失效  200404=需弹登录  120/121/122=zp_token 失效
   *      收到 122 时页面会调 /wapi/zppassport/set/zpToken 刷新后重试
   *
   * 4) 双 token 并存 —— 'bst' cookie(zp_token,反爬凭证)
   *                    + _PAGE.token(登录会话)
   *
   * 边界:插件的职责是“读准登录态 + 复用/刷新页面已有的凭证”。
   * 不伪造凭证,也不试图绕过 __zp_stoken__(由页面风控 SDK 依据 seed/name/ts 生成)。
   */

  const AUTH = {
    codes: { INVALID_SESSION: 7, NEED_LOGIN: 200404, ZP_EXPIRE: [120, 121, 122] },
    snapshot: null,
    snapshotAt: 0,
    lastRefreshAt: 0,
    refreshResult: null,
  };

  function readCookieRaw(name) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch {
      return '';
    }
  }

  function cookieKeys() {
    try {
      return document.cookie
        .split(';')
        .map((s) => s.split('=')[0].trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // 抽取页面注入的 _PAGE。它由服务端下发,是登录态的权威来源之一。
  function readPageObject() {
    try {
      const p = window._PAGE;
      if (!p || typeof p !== 'object') return null;
      return {
        isLogin: typeof p.isLogin === 'boolean' ? p.isLogin : undefined,
        identity: p.identity,
        userId: p.userId || p.uid || null,
        // token 取 '|' 前的部分,与页面拦截器一致
        tokenHead: p.token ? String(p.token).split('|')[0] : null,
        tokenRaw: p.token ? String(p.token) : null,
      };
    } catch {
      return null;
    }
  }

  function authSnapshot(force) {
    if (!force && AUTH.snapshot && now() - AUTH.snapshotAt < 1000) return AUTH.snapshot;
    const page = readPageObject();
    AUTH.snapshot = {
      ts: now(),
      page,
      isLogin: page ? page.isLogin : undefined,
      identity: page ? page.identity : undefined,
      userId: page ? page.userId : null,
      hasSessionToken: !!(page && page.tokenHead),
      zpToken: readCookieRaw('bst'),
      zpStoken: readCookieRaw('__zp_stoken__'),
      cookies: cookieKeys(),
      url: location.pathname,
    };
    AUTH.snapshotAt = now();
    return AUTH.snapshot;
  }

  // 刷新 zp_token:凭服务端下发的风控凭证,与页面自身失效重试走同一路径
  async function refreshToken(reason) {
    // 30s 内不重复刷新,避免把风控刷出频控
    if (now() - AUTH.lastRefreshAt < 30000 && AUTH.refreshResult) return AUTH.refreshResult;
    AUTH.lastRefreshAt = now();
    try {
      const res = await nativeFetch(location.origin + '/wapi/zppassport/set/zpToken', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
        credentials: 'include',
      });
      const d = await res.json();
      logApi({ url: '/wapi/zppassport/set/zpToken', code: d.code, kind: 'auth', via: 'extension' });
      AUTH.refreshResult = { ok: d.code === 0, code: d.code, message: d.message, reason, ts: now() };
    } catch (e) {
      AUTH.refreshResult = { ok: false, code: -1, message: String(e && e.message), reason, ts: now() };
    }
    authSnapshot(true);
    try {
      window.dispatchEvent(new CustomEvent('lcs:auth', { detail: { type: 'refresh', ...AUTH.refreshResult } }));
    } catch {}
    return AUTH.refreshResult;
  }

  /* ------------------------------------------- 带登录态处理的请求包装器 */

  // 取 zp_token。页面自带 window.Cookie 工具(实测存在:{get,getObj,set,del},
  // 且 window.Cookie.get('bst') 与 document.cookie 解析结果一致)。
  //
  // 但它是页面注入的:实测在页面导航瞬间会变成 undefined。
  // 因此必须保留 document.cookie 解析作为降级路径,否则导航期间会静默取不到 token。
  function getZpToken() {
    try {
      if (window.Cookie && typeof window.Cookie.get === 'function') {
        const v = window.Cookie.get('bst');
        if (v) return v;
      }
    } catch {}
    return readCookieRaw('bst');
  }

  // 复用页面自身的认证头组合。实测有效的形式:
  //   Zp_token: <bst>            (来自 window.Cookie)
  //   X-Requested-With: XMLHttpRequest
  // 这里同时给出 token / Zp_token / zp_token 三种拼写,以兼容改名。
  function authHeaders(extra) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...(extra || {}),
    };
    // authHook 关闭时不注入任何凭证头,退化为匿名请求
    if (!config.authHook) return headers;
    const snap = authSnapshot();
    const zp = getZpToken();
    if (zp) {
      headers.zp_token = zp;
      headers.Zp_token = zp;
    }
    if (snap && snap.page && snap.page.tokenHead) headers.token = snap.page.tokenHead;
    return headers;
  }

  async function authedFetch(url, init, retryLeft = 1) {
    const opts = {
      credentials: 'include',
      ...(init || {}),
      headers: authHeaders(init && init.headers),
    };
    const res = await nativeFetch(url, opts);
    let data = null;
    try {
      data = await res.clone().json();
    } catch {
      return { res, data: null };
    }

    // 主动发起的请求也要进日志,否则凭证刷新与失效重试无法排查
    logApi({
      url: String(url).replace(/^https?:\/\/[^/]+/, ''),
      code: data && data.code,
      kind: /joblist|recommend\/job\/list/.test(url) ? 'joblist' : /detail\.json/.test(url) ? 'detail' : 'other',
      via: 'extension',
      retryLeft,
    });

    const code = data && data.code;
    const needsRefresh = config.authHook !== false && AUTH.codes.ZP_EXPIRE.includes(code);

    if (needsRefresh && retryLeft > 0) {
      console.info(TAG, '凭证失效(code ' + code + '),刷新后重试');
      await refreshToken('code ' + code);
      return authedFetch(url, init, retryLeft - 1);
    }
    return { res, data };
  }

  /* ------------------------------------------------- 状态:岗位与筛选条件 */

  // jobId -> { jobId, title, company, salary, tags[], welfare[], isOutsourcing, outsourcingWord }
  const jobs = new Map(Object.entries(readStore(LS_JOBS, {}).jobs || {}));
  const filters = readStore(LS_FILTERS, { params: {}, updatedAt: 0 });

  // 筛选状态统一由主世界持有并持久化,隔离世界只读不写。
  // 曾经隔离世界自行更新内存副本而不落盘,导致 popup 从 localStorage 重读时
  // 把正确值覆盖回旧值(面板显示 3 项、popup 显示 0 项)。
  function setFilterParams(params, source) {
    filters.params = params || {};
    filters.updatedAt = now();
    filters.source = source || 'set';
    persistFilters();
    return filters;
  }

  function getFilterParams() {
    return filters.params || {};
  }

  // URL 上的这些参数构成「当前筛选条件」。
  // 不含 scene(page 等内部参数),它们是接口噪音而非用户筛选。
  const FILTER_PARAM_KEYS = [
    'city',
    'query',
    'experience',
    'degree',
    'salary',
    'industry',
    'scale',
    'stage',
    'jobType',
    'payType',
    'partTime',
    'position',
    'multiBusinessDistrict',
    'multiSubway',
    'district',
    'businessDistrict',
    'barrierFreeType',
  ];

  // 从 URL query 同步筛选状态。这是筛选状态的唯一权威来源。
  function syncFiltersFromUrl() {
    const sp = new URLSearchParams(location.search);
    const next = {};
    for (const k of FILTER_PARAM_KEYS) {
      if (!sp.has(k)) continue;
      const v = sp.get(k);
      if (v !== '' && v != null) next[k] = v;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(getFilterParams());
    setFilterParams(next, 'url');
    if (changed) emit('filters');
    return changed;
  }

  // 记录「由扩展自己发起」的请求 URL。
  // 用于区分筛选状态的可信来源:页面的请求反映用户操作,扩展的请求不是。
  const selfRequests = new Set();

  function persistJobs() {
    // 同步写入,保证隔离世界收到 emit 事件时数据已经落盘
    const snapshot = { updatedAt: now(), jobs: Object.fromEntries(jobs) };
    try {
      localStorage.setItem(LS_JOBS, JSON.stringify(snapshot));
    } catch (e) {
      // 写失败(多为配额超限)时必须降级:裁掉一半旧记录后重试一次,
      // 否则隔离世界会一直读到旧快照,计数永远不更新。
      console.warn(TAG, 'localStorage 写入失败,裁剪后重试', e && e.name);
      pruneJobs(Math.floor(jobs.size / 2));
      try {
        localStorage.setItem(LS_JOBS, JSON.stringify({ updatedAt: now(), jobs: Object.fromEntries(jobs) }));
      } catch (e2) {
        console.warn(TAG, '裁剪后仍写入失败', e2 && e2.name);
      }
    }
  }

  // 删除最早入库的记录(Map 保持插入顺序)
  function pruneJobs(count) {
    if (count <= 0) return;
    let removed = 0;
    for (const k of jobs.keys()) {
      if (removed >= count) break;
      jobs.delete(k);
      removed++;
    }
  }

  function persistFilters() {
    writeStore(LS_FILTERS, filters);
  }

  function logApi(entry) {
    const log = readStore(LS_API_LOG, { items: [] });
    log.items.unshift({ ...entry, ts: now() });
    // 只保留最近 80 条,避免膨胀
    log.items = log.items.slice(0, 80);
    try {
      localStorage.setItem(LS_API_LOG, JSON.stringify(log));
    } catch {}
  }

  /* ------------------------------------------------------ 过滤参数的关键字 */

  // 这些 query 参数构成“当前筛选条件”。
  // 注意:scene/city 之外的分页与埋点参数不在此列。
  // scene 刻意排除 —— 它是接口内部场景标识(1=搜索),恒等于 1,
  // 既不是用户选的筛选条件,写回 URL 也只会制造噪音。
  const FILTER_KEYS = [
    'city',
    'query',
    'experience',
    'degree',
    'salary',
    'industry',
    'scale',
    'stage',
    'jobType',
    'payType',
    'partTime',
    'position',
    'multiBusinessDistrict',
    'multiSubway',
    'district',
    'businessDistrict',
    'barrierFreeType',
    'encryptExpectId',
    'mixExpectType',
    'expectInfo',
  ];

  // 明确排除:翻页与埋点类参数
  const IGNORE_KEYS = ['page', 'pageSize', 'ka', 'lid', 'securityId', '_t', 'ts', 'source', 'scene'];

  function isFilterKey(k) {
    return FILTER_KEYS.includes(k);
  }

  function normalizeParams(search) {
    const out = {};
    const sp = new URLSearchParams(search || '');
    for (const [k, v] of sp.entries()) {
      if (IGNORE_KEYS.includes(k)) continue;
      if (!isFilterKey(k)) continue;
      out[k] = v;
    }
    return out;
  }

  /* ------------------------------------------------------------ 福利收集 */

  // 福利标签仅作为展示与宽松判定来源保留,不再参与任何三态判定。
  const collectWelfare = (list) =>
    Array.isArray(list)
      ? list
          .map((x) => (typeof x === 'string' ? x : (x && (x.name || x.content || x.label)) || ''))
          .filter(Boolean)
      : [];

  /* -------------------------------------------------------- 外包判定的副本
   *
   * 主世界读不到扩展模块,故此处为 src/shared/judge.js 的自包含副本。
   * 两侧逻辑必须一致,由 test/judge.test.js 的同一批用例保证。
   */

  const OS_EXCLUDE = [
    /非\s*外包/,
    /不\s*是\s*外包/,
    /无\s*外包/,
    /不做\s*外包/,
    /非\s*派遣/,
    /不\s*是\s*派遣/,
    /无\s*派遣/,
    /甲方\s*直招/,
    /甲方\s*直聘/,
    /正式\s*编制/,
    /自有\s*员工/,
    /内\s*包/,
  ];

  const OS_WORDS = [
    '劳务派遣',
    '人力派遣',
    '人才派遣',
    '服务外包',
    '项目外包',
    '人力外包',
    '软件外包',
    '业务外包',
    '技术外包',
    '研发外包',
    '岗位外包',
    '外包服务',
    '人力资源服务',
    '灵活用工',
    '派遣',
    '外包',
    '外派',
    '驻场',
    '乙方',
    '劳务',
  ];

  function judgeOneText(text) {
    const s = String(text == null ? '' : text)
      .replace(/\s+/g, '')
      .toLowerCase();
    if (!s) return { hit: false, word: null, excluded: false };
    if (OS_EXCLUDE.some((re) => re.test(s))) return { hit: false, word: null, excluded: true };
    for (const w of OS_WORDS) {
      if (s.includes(w.toLowerCase())) return { hit: true, word: w, excluded: false };
    }
    return { hit: false, word: null, excluded: false };
  }

  // 只看岗位名与公司名:这两处才是招聘方的主动标识。
  // 排除表述全局优先 —— 曾因"命中即返回"漏检公司名里的"甲方直招"。
  function judgeJobLocal(job) {
    const fields = [
      ['jobName', job && job.title],
      ['company', job && job.company],
    ];
    for (const [, val] of fields) {
      if (judgeOneText(val).excluded) return { isOutsourcing: false, word: null, field: null };
    }
    for (const [name, val] of fields) {
      const r = judgeOneText(val);
      if (r.hit) return { isOutsourcing: true, word: r.word, field: name };
    }
    return { isOutsourcing: false, word: null, field: null };
  }

  /* ------------------------------------------------ 岗位提取:列表接口响应 */

  function pickJobId(job) {
    return (
      job.encryptJobId ||
      job.jobId ||
      job.encryptId ||
      job.securityId ||
      (job.jobUrl && /\/([^/]+)\.html/.exec(job.jobUrl)?.[1]) ||
      null
    );
  }

  function ingestJobList(zpData) {
    const list = (zpData && (zpData.jobList || zpData.jobCardList || zpData.list)) || [];
    if (!Array.isArray(list) || !list.length) return 0;

    let added = 0;
    for (const raw of list) {
      const jobId = pickJobId(raw);
      if (!jobId) continue;

      const prev = jobs.get(jobId) || {};
      const welfare = collectWelfare(raw.welfareList || raw.welfareListStr);
      const tags = [].concat(raw.jobLabels || [], raw.skills || []).filter(Boolean);

      // 外包/派遣判定:只看岗位名与公司名 —— 招聘方主动写在那里的标识。
      // 主世界为自包含副本(读不到扩展模块),两侧一致性由 test/judge.test.js 覆盖。
      const title = raw.jobName || raw.jobTitle || prev.title || '';
      const company = raw.brandName || raw.company || prev.company || '';
      const verdict = judgeJobLocal({ title, company });

      jobs.set(jobId, {
        jobId,
        securityId: raw.securityId || prev.securityId || '',
        lid: raw.lid || prev.lid || '',
        title,
        company,
        companyScale: raw.brandScaleName || prev.companyScale || '',
        companyStage: raw.brandStageName || prev.companyStage || '',
        salary: raw.salaryDesc || prev.salary || '',
        tags,
        welfare: welfare.length ? welfare : prev.welfare || [],
        isOutsourcing: verdict.isOutsourcing,
        outsourcingWord: verdict.word,
        outsourcingField: verdict.field,
        source: 'list',
      });
      added++;
    }

    persistJobs();
    return added;
  }

  // 重置缓存:清空已归集岗位,由 popup 的「重新扫描」触发
  document.addEventListener('lcs:reset-cache', () => {
    jobs.clear();
    persistJobs();
    emit('reset');
  });

  /* ------------------------------------------------------------- fetch 嗅探 */

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const p = nativeFetch.apply(this, arguments);
      if (url && /\/wapi\//.test(url)) {
        observeFetch(url, p);
      }
      return p;
    };
    window.fetch.toString = nativeFetch.toString.bind(nativeFetch);
  }

  function observeFetch(url, promise) {
    promise
      .then((res) => {
        // 需要读 body,必须 clone,否则会消费掉页面自己的响应
        try {
          const clone = res.clone();
          clone
            .json()
            .then((data) => handleApiResponse(url, data))
            .catch(() => {});
        } catch {}
        return res;
      })
      .catch(() => {});
  }

  function handleApiResponse(url, data) {
    if (!data || typeof data !== 'object') return;

    const isJobList = /\/(search\/joblist|pc\/recommend\/job\/list|pc\/special\/zone\/joblist|history\/joblist)\.json/.test(url);
    const isCondition = /\/(pc\/all\/filter\/conditions|search\/job\/condition|search\/barrier\/free\/job\/condition)\.json/.test(url);

    logApi({
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      code: data.code,
      kind: isJobList ? 'joblist' : isCondition ? 'condition' : 'other',
    });

    if (isJobList && data.code === 0 && data.zpData) {
      // 1) 同步“当前筛选条件”。
      //
      // 筛选状态以【页面 URL 上的 query】为唯一权威,而不是请求参数。
      // 原因:插件自己发起的回填请求会带默认城市(city=101010100),
      // 若拿请求参数当状态,就会把用户当前所在城市改写成北京(实测过的真实 bug)。
      // URL 则始终反映用户此刻的筛选 —— SPA 改 query 即代表筛选变化。
      try {
        syncFiltersFromUrl();
        // self-tuning: 极少数情况下 SPA 未同步 query(例如程序化请求),
        // 此时用请求参数补一次初始化,但只在当前没有任何筛选时。
        if (!Object.keys(getFilterParams()).length) {
          const u = new URL(url, location.origin);
          const params = normalizeParams(u.search);
          if (Object.keys(params).length) setFilterParams(params, 'intercept-init');
        }
      } catch {}

      // 2) 归集岗位
      const n = ingestJobList(data.zpData);
      if (n) emit('joblist');

      // 3) 记录分页信息,供 UI 判断是否还有下一页
      try {
        const u = new URL(url, location.origin);
        filters.lastPage = Number(u.searchParams.get('page') || 1);
        filters.hasMore = !!data.zpData.hasMore || (data.zpData.jobList || []).length >= 15;
      } catch {}
    }
  }

  /* -------------------------------------------------------------- XHR 嗅探 */

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__lcsUrl = url;
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      const url = this.__lcsUrl;
      if (url && /\/wapi\//.test(String(url))) {
        this.addEventListener('load', () => {
          try {
            const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
            if (!text) return;
            handleApiResponse(String(url), JSON.parse(text));
          } catch {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  /* --------------------------------------- 供 content.js 调用的主动查询接口 */

  // 直接用保存的筛选条件发起一次列表查询(用于“回填后立即生效”)
  window.__LCS_FETCH_LIST__ = async function (params, page = 1) {
    const qs = new URLSearchParams();

    // 城市默认跟随页面当前所在城市,而不是写死北京。
    // 写死会把深圳的搜索变成北京的结果,属实测到的真实问题。
    const pageCity =
      new URLSearchParams(location.search).get('city') ||
      (window._PAGE && window._PAGE.citySiteCode) ||
      '101010100';

    const merged = {
      scene: 1,
      query: '',
      experience: '',
      payType: '',
      partTime: '',
      degree: '',
      industry: '',
      scale: '',
      stage: '',
      position: '',
      jobType: '',
      salary: '',
      multiBusinessDistrict: '',
      multiSubway: '',
      page: String(page),
      pageSize: '30',
      ...params,
      city: (params && params.city) || pageCity, // 显式传入优先,否则跟随页面
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    // 页面自身的列表请求带 lid(会话追踪)与 _ 时间戳,一并向其看齐
    const pageLid = new URLSearchParams(location.search).get('lid');
    if (pageLid) qs.set('lid', pageLid);
    qs.set('_', String(now()));

    const url = location.origin + '/wapi/zpgeek/search/joblist.json?' + qs.toString();
    // 打标:这是扩展发的请求,不构成“用户筛选状态”的来源
    selfRequests.add(url);
    setTimeout(() => selfRequests.delete(url), 15000);
    const { data } = await authedFetch(url, {});
    handleApiResponse(url, data);
    return data;
  };

  // 登录态检测 UI 已下线:不再对外暴露 auth/probe 接口。
  // 凭证读取与失效重试仍在内部生效(见 authHeaders / authedFetch),
  // 这是 /wapi/ 请求能拿到数据的前提,与界面无关。

  // 读取当前 localStorage 快照(供 content 首次同步)
  window.__LCS_SNAPSHOT__ = function () {
    return {
      jobs: Object.fromEntries(jobs),
      filters,
      apilog: readStore(LS_API_LOG, { items: [] }),
    };
  };

  // 由隔离世界写入筛选状态(唯一的写入入口)。
  // 走这里而不是让隔离世界自己写 localStorage,是为了避免两处状态各自演化。
  window.__LCS_SET_FILTERS__ = function (params, source) {
    const next = setFilterParams(params, source || 'bridge');
    emit('filters');
    return next;
  };

  // 只读查询,供 LCS_GET_STATUS 使用
  window.__LCS_GET_FILTERS__ = function () {
    return { params: getFilterParams(), updatedAt: filters.updatedAt, source: filters.source };
  };

  // 主世界也要感知 URL 变化:SPA 改 query 时(切城市、点筛选)立即同步筛选状态。
  // 这样不依赖隔离世界的主动写入,两条路径都能保证状态是最新的。
  (() => {
    let lastSearch = location.search;

    function onUrlChange() {
      if (location.search === lastSearch) return;
      lastSearch = location.search;
      syncFiltersFromUrl();
    }

    ['pushState', 'replaceState'].forEach((k) => {
      const orig = history[k];
      history[k] = function () {
        const r = orig.apply(this, arguments);
        setTimeout(onUrlChange, 50);
        return r;
      };
    });
    window.addEventListener('popstate', () => setTimeout(onUrlChange, 50));
    // 有些 SPA 走 hash 或轮询式路由,补一个兜底轮询(低频,代价可忽略)
    setInterval(onUrlChange, 1500);
  })();

  /* ------------------------------------------ 隔离世界 -> 主世界的指令通道
   *
   * 隔离世界无法访问主世界的 window(Chrome 隔离世界机制,已实测确认:
   * __LCS_SET_FILTERS__ / __LCS_SNAPSHOT__ 在隔离世界均为 undefined)。
   * 因此反向指令不能靠函数调用,只能走 DOM 事件 —— 事件是两个世界都能看到的。
   */

  // 隔离世界请求发起一次列表查询
  document.addEventListener('lcs:req-fetch', async (e) => {
    const params = (e && e.detail && e.detail.params) || {};
    const page = (e && e.detail && e.detail.page) || 1;
    try {
      const r = await window.__LCS_FETCH_LIST__(params, page);
      // 把结果回传给隔离世界(经 DOM 事件,附在 detail 上)
      document.dispatchEvent(
        new CustomEvent('lcs:req-fetch-done', { detail: { code: r && r.code, count: ((r && r.zpData && r.zpData.jobList) || []).length } }),
      );
    } catch (err) {
      document.dispatchEvent(new CustomEvent('lcs:req-fetch-done', { detail: { code: -1, error: String(err && err.message) } }));
    }
  });

  // 隔离世界请求重置缓存
  document.addEventListener('lcs:req-reset', () => {
    jobs.clear();
    persistJobs();
    emit('reset');
  });

  emit('ready');

  // 启动即从 URL 同步一次筛选状态。
  // 这一步是主世界自己的初始化,不依赖隔离世界的任何调用 ——
  // 两个世界互不可见,原先指望隔离世界来写入状态的做法不可靠。
  try {
    const changed = syncFiltersFromUrl();
    console.info(TAG, '启动同步筛选状态:', changed, JSON.stringify(getFilterParams()));
  } catch (e) {
    console.warn(TAG, '启动同步筛选状态失败', e && e.message);
  }
})();
