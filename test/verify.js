/* 交付前自检:
 *   1. 所有 JS 能被解析(用 new Function 做语法解析,不执行,避免 MV3 API 报错)
 *   2. manifest.json 合法,且其中引用的每个文件真实存在
 *   3. popup.html 引用的资源存在
 *   4. 关键接口路径与判定逻辑未被误改
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let errors = [];
let checked = 0;

/* ---------------------------------------------------- 1. JS 语法解析 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const all = walk(ROOT);
for (const f of all.filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(f, 'utf8');
  checked++;
  try {
    // 解析为函数体:能捕获语法错误,同时不会真的执行
    new Function(src);
  } catch (e) {
    errors.push(`语法错误 ${path.relative(ROOT, f)}: ${e.message}`);
  }
}

/* ------------------------------------------------- 2. manifest 引用可达 */
const mfPath = path.join(ROOT, 'manifest.json');
let mf;
try {
  mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
} catch (e) {
  errors.push('manifest.json 解析失败: ' + e.message);
}

if (mf) {
  const refs = [];
  if (mf.background && mf.background.service_worker) refs.push(mf.background.service_worker);
  if (mf.action && mf.action.default_popup) refs.push(mf.action.default_popup);
  for (const cs of mf.content_scripts || []) {
    for (const j of cs.js || []) refs.push(j);
    for (const c of cs.css || []) refs.push(c);
  }
  for (const war of mf.web_accessible_resources || []) for (const r of war.resources || []) refs.push(r);

  for (const r of refs) {
    const p = path.join(ROOT, r);
    if (!fs.existsSync(p)) errors.push(`manifest 引用缺失: ${r}`);
  }
  console.log(`manifest 引用检查: ${refs.length} 个资源`);
  for (const r of refs) console.log('  - ' + r);

  if (mf.manifest_version !== 3) errors.push('manifest_version 应为 3');
}

/* ---------------------------------------------------- 3. popup 资源可达 */
const popupHtml = path.join(ROOT, 'src/popup/popup.html');
if (fs.existsSync(popupHtml)) {
  const html = fs.readFileSync(popupHtml, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^https?:/.test(ref)) continue;
    const p = path.join(path.dirname(popupHtml), ref);
    if (!fs.existsSync(p)) errors.push(`popup.html 引用缺失: ${ref}`);
  }
} else {
  errors.push('popup.html 不存在');
}

/* ------------------------------------------------------ 4. 关键契约不变 */
const injected = fs.readFileSync(path.join(ROOT, 'src/injected.js'), 'utf8');
// 接口可能写在字符串里,也可能写在嗅探正则里(带 \/ 转义),先归一化再匹配
const injectedNorm = injected.replace(/\\\//g, '/');
const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(ROOT, 'src/popup/popup.js'), 'utf8');
const popupHtmlSrc = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
// 详情接口已随双休功能一并移除(实测该接口不返回福利信息,判定无增益),
// 因此这里不再要求它存在;列表接口与筛选码表仍是核心。
const requiredEndpoints = [
  '/wapi/zpgeek/search/joblist.json',
  'pc/recommend/job/list',
  'pc/all/filter/conditions',
];
for (const ep of requiredEndpoints) {
  if (!injectedNorm.includes(ep)) errors.push(`injected.js 缺少接口: ${ep}`);
}

for (const api of ['LCS_GET_STATUS', 'LCS_SAVE_FILTER', 'LCS_APPLY_FILTER', 'LCS_SET_CONFIG', 'LCS_RESCAN', 'LCS_GET_API_LOG']) {
  if (!content.includes(api) && !popupJs.includes(api)) {
    errors.push(`消息契约缺失: ${api}`);
  }
}

// 主世界钩子必须存在 fetch 与 XHR 两条嗅探路径
for (const k of ['window.fetch = function', 'XHR.prototype.open', 'XHR.prototype.send']) {
  if (!injected.includes(k)) errors.push(`injected.js 缺少嗅探钩子: ${k}`);
}

/* ------------------------------------------------------ 5. 认证层契约 */
// 登录态检测 UI 已按需求下线,但底层的「凭证复用 + 失效重试」必须保留,
// 否则 /wapi/ 请求会失去 token 而全部失败。这里只校验这一层。
const authEndpoints = [
  ['set/zpToken', '凭证刷新接口'],
];
for (const [ep, note] of authEndpoints) {
  if (!injectedNorm.includes(ep)) errors.push(`injected.js 缺少认证接口(${note}): ${ep}`);
}
if (!injected.includes('window.Cookie')) errors.push('未使用页面自带的 window.Cookie 取凭证');
if (!injected.includes('document.cookie')) errors.push('缺少 document.cookie 降级路径(导航期间 window.Cookie 会失效)');
// 页面自身的认证头组合方式必须被复用,否则容易写出与页面不一致的请求
for (const h of ['X-Requested-With', 'Zp_token']) {
  if (!injected.includes(h)) errors.push(`认证请求头缺失: ${h}`);
}
// 失效码处理
for (const c of ['ZP_EXPIRE', 'authedFetch']) {
  if (!injected.includes(c)) errors.push(`认证失效处理缺失: ${c}`);
}

/* ------------------------------------------------ 6. 配置开关必须接线 */
// 声明了却没人读的开关等于死配置。逐项确认三处都接上:
// 主世界读取(若该开关影响主世界) / 隔离世界读取 / 界面可改。
// 注意:authHook 是内部开关 —— 它影响主世界的凭证注入,但不对外开放 UI。
const CONFIG_UI = {
  highlight: 'cfgHighlight',
  looseMatch: 'cfgLoose',
  autoApply: 'cfgAuto',
};
for (const [key, uiId] of Object.entries(CONFIG_UI)) {
  if (!popupJs.includes("'" + key + "'")) errors.push(`配置项未在 popup 逻辑接线: ${key}`);
  if (!popupHtmlSrc.includes('id="' + uiId + '"')) errors.push(`配置项未在 popup 界面提供控件: ${key} (${uiId})`);
  if (!content.includes(key)) errors.push(`配置项未在隔离世界接线: ${key}`);
}
// authHook 直接影响主世界发出的请求,必须被主世界真正读取
if (!injected.includes('config.authHook')) errors.push('authHook 未被主世界读取,开关将无效');
// 配置镜像通道必须存在(主世界读不到 chrome.storage)
if (!injected.includes('lcs:config')) errors.push('主世界配置镜像通道缺失');
if (!content.includes("localStorage.setItem(\n        'lcs:config'") && !content.includes("'lcs:config'")) {
  errors.push('配置未下发到主世界');
}

/* ------------------------------------------- 7. 双世界通信契约 */
// 隔离世界读不到主世界的 window(Chrome 隔离世界机制,实测:
// __LCS_FETCH_LIST__ / __LCS_SET_FILTERS__ / __LCS_SNAPSHOT__ 在隔离世界均为 undefined)。
// 因此 content.js 不得直接调用这些函数 —— 那是空转,会静默失败。
const crossWorldCalls = ['__LCS_FETCH_LIST__', '__LCS_SET_FILTERS__', '__LCS_GET_FILTERS__', '__LCS_SNAPSHOT__', '__LCS_PREFETCH__'];
for (const name of crossWorldCalls) {
  // 允许出现在注释里说明该限制,但不允许出现在可执行代码里
  const lines = content.split('\n');
  const bad = lines.filter((l) => {
    const t = l.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false;
    return l.includes(name);
  });
  if (bad.length) {
    errors.push(`隔离世界直接调用了主世界函数 ${name}(不可见,应改用 DOM 事件): ${bad[0].trim().slice(0, 70)}`);
  }
}
// 反向指令必须走 DOM 事件
for (const evt of ['lcs:req-fetch', 'lcs:req-reset']) {
  if (!content.includes(evt)) errors.push(`隔离世界缺少事件通道: ${evt}`);
  if (!injected.includes(evt)) errors.push(`主世界未监听事件通道: ${evt}`);
}
// 两侧的 URL 参数键集必须一致,否则会算出不同的筛选项(曾漏 city 导致面板/popup 不一致)
const mContent = content.match(/const USER_INTENT_KEYS = \[([^\]]+)\]/);
const mInjected = injected.match(/const FILTER_PARAM_KEYS = \[([^\]]+)\]/);
if (!mContent || !mInjected) {
  errors.push('未能定位两侧的筛选参数键列表');
} else {
  const norm = (s) =>
    s
      .split(',')
      .map((x) => x.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort()
      .join(',');
  if (norm(mContent[1]) !== norm(mInjected[1])) {
    errors.push('两侧筛选参数键集不一致:\n      隔离世界=' + norm(mContent[1]) + '\n      主世界=' + norm(mInjected[1]));
  }
}
// 主世界必须自己从 URL 初始化筛选状态(不能依赖隔离世界写入)
if (!/syncFiltersFromUrl\(\)/.test(injected)) errors.push('主世界缺少启动时的 URL 筛选同步');

/* ------------------------------------------------ 8. 关键函数的定义完整性 */
// 事故复盘:批量删除代码块时删掉了函数体,调用点却留着,
// 于是脚本在初始化阶段抛 ReferenceError 并【整体中断】—— 后面的按钮绑定
// 全部不执行,表现为「按钮点了没反应」,而语法检查完全看不出问题。
// 已发生两次(删登录 UI 时删掉了 applyConfigToUi 与 renderSaved/renderLog)。
// 这里用最朴素的办法守住:确认关键函数有定义。
function collectDefined(text) {
  const names = new Set();
  for (const m of text.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)) names.add(m[1]);
  return names;
}

const REQUIRED = {
  'popup.js': [
    'refresh', 'renderSaved', 'renderLog', 'renderChips', 'applyConfigToUi',
    'toast', 'send', 'activeTab', 'prettyKey', 'escapeHtml',
  ],
  'content.js': [
    'scan', 'renderCard', 'renderPanel', 'applyOutsourcingVerdict', 'countOutsourcing',
    'syncFiltersFromUrl', 'applySavedFilters', 'currentUrlParams', 'applyFiltersToUrl',
    'requestListFetch', 'requestResetCache', 'getStored', 'sanitizeStoredFilters',
    'judgeFromDom', 'collectCards', 'jobIdFromCard', 'makePanelDraggable', 'scheduleScan',
  ],
};

const SOURCES = { 'popup.js': popupJs, 'content.js': content };
for (const label of Object.keys(REQUIRED)) {
  const defined = collectDefined(SOURCES[label]);
  const missing = REQUIRED[label].filter((n) => !defined.has(n));
  if (missing.length) {
    errors.push(label + " 缺少关键函数定义(可能被误删): " + missing.join(", "));
  }
}

console.log(`\n已解析 JS 文件: ${checked} 个`);
if (errors.length) {
  console.log('\n发现问题:');
  for (const e of errors) console.log('  ✗ ' + e);
  process.exit(1);
}
console.log('\n自检通过:无语法错误,引用完整,接口与消息契约齐备。');
