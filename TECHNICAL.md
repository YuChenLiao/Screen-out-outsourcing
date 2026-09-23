# 技术文档

面向查阅与维护。功能说明与使用方法见 [README.md](./README.md)。

- [一、页面结构与接口分析](#一页面结构与接口分析)
- [二、登录流程与认证机制](#二登录流程与认证机制)
- [三、架构](#三架构)
- [四、派遣/外包判定](#四派遣外包判定)
- [五、验证与自测](#五验证与自测)
- [六、已知限制](#六已知限制)
- [七、侦察产物](#七侦察产物)

---

## 一、页面结构与接口分析

目标页 `https://www.zhipin.com/web/geek/jobs` 是 Vue SPA，初始 HTML 仅约 9KB，**没有任何数据内联**（无 `__INITIAL_STATE__` / `__NEXT_DATA__`），全部数据靠 XHR/fetch 拉 `/wapi/` 接口。

因此唯一可靠的筛选状态来源是**请求参数本身**，以及**页面 URL 的 query**。

### 接口清单

| 接口 | 方法 | 登录 | 用途 | 实测结论 |
|---|---|---|---|---|
| `/wapi/zpgeek/search/joblist.json` | GET | 需会话 | 职位列表（搜索页主数据源） | 带 cookie 才通；裸 HTTP 返回 `code:37 您的环境存在异常` |
| `/wapi/zpgeek/pc/recommend/job/list.json` | GET | 需会话 | 推荐列表（懒加载分页） | 参数与上者同构 |
| `/wapi/zpgeek/job/detail.json` | GET | 需会话 | 职位详情 | 参数 `securityId`，与列表的 `encryptJobId` **不同**；实测不返回福利字段，本扩展不使用 |
| `/wapi/zpgeek/pc/all/filter/conditions.json` | GET | **不需** | 全部筛选码表 | 实测 200，返回 8 组码表 |
| `/wapi/zpgeek/search/job/condition.json` | GET | **不需** | 筛选码表（搜索侧） | 字段与上者一致 |
| `/wapi/zpgeek/businessDistrict.json?cityCode=` | GET | **不需** | 地区树（市→区→商圈） | 实测 28KB，三级树 |
| `/wapi/zpgeek/search/job/sidebar.json` | GET | **不需** | 侧栏状态（含 `geekLogin`） | 可用于判断登录态 |

两个免登录接口很有价值：筛选**选项**可以离线同步，不依赖用户会话。

### 筛选码表（实测抓取，已存 `data/`）

| 维度 | 参数名 | 码值 |
|---|---|---|
| 薪资 | `salary` | 402 `3K以下` / 403 `3-5K` / 404 `5-10K` / 405 `10-20K` / 406 `20-50K` / 407 `50K以上` |
| 经验 | `experience` | 108 在校生 / 102 应届生 / 101 经验不限 / 103 1年以内 / 104 1-3年 / 105 3-5年 / 106 5-10年 / 107 10年以上 |
| 学历 | `degree` | 209 初中及以下 / 208 中专技校 / 206 高中 / 202 大专 / 203 本科 / 204 硕士 / 205 博士 |
| 规模 | `scale` | 301 `0-20人` / 302 `20-99人` / 303 `100-499人` / 304 `500-999人` / 305 `1000-9999人` / 306 `10000人以上` |
| 融资 | `stage` | 801 未融资 / 802 天使轮 / 803 A轮 / 804 B轮 / 805 C轮 / 806 D轮及以上 / 807 已上市 / 808 不需要融资 |
| 类型 | `jobType` | 1901 全职 / 1903 兼职 |
| 结算 | `payType` | 2501 日结 / 2502 周结 / 2503 月结 / 2504 完工结 |
| 兼职时段 | `partTime` | 2701 周末节假日 / 2702 寒暑假 / 2703 短期 / 2704 长期 / 2705 工作日 / 2706 夜班 |

`0` 统一表示「不限」。

### 关键结论：筛选状态存在 URL query 上

SPA 接受任意 query 并解析：`/web/geek/jobs?city=101010100&salary=405&experience=104,105&degree=203` 都会正常渲染。

这个结论决定了整套设计：

- **同步条件** = 读请求参数 / 读 URL
- **保存条件** = 存参数集
- **回填** = 写回 URL

不需要逆向任何内部状态。

### 关键结论：双休不是筛选项（附带一次失败的尝试）

`condition.json` 的 8 组码表里**没有"双休"** —— 它不是平台的筛选维度，而是招聘方在岗位侧自由填写的福利项。

这条结论支撑过一次功能尝试：既然筛不了，就取回岗位逐个判定。**该功能已删除**，因为实测数据不支持它：双休的唯一承载字段是 `welfareList`，而 90 条样本里仅 1 条含"双休"，26 条有福利数据的岗位中命中 0 条。判定结果恒为"未知"，保留它只会给出一堆无法兑现的 0。

同类字段也一并被实测否决，记在这里以免重蹈：

- `daysPerWeekDesc`（每周天数）与 `leastMonthDesc`（最少在职月数）在 90/90 个岗位中都存在，名字极具诱惑力，但取值 **30/30 全为空串**
- 详情接口 `job/detail.json` 的 `jobInfo` 里**没有 `welfareList`**，拿它补全判定是无效开销

真正能标红的是**派遣/外包** —— 招聘方会主动写出来（见第四节）。这两件事的差别不在实现难度，而在数据是否存在。

---

## 二、登录流程与认证机制

### 认证是双 token 并存

请求头里带的是**两个不同的东西**，这点最容易搞错：

| 凭证 | 存放位置 | 取值方式 | 作用 |
|---|---|---|---|
| `zp_token` | cookie `bst` | `window.Cookie.get('bst')` 或 `document.cookie` | 反爬/风控凭证 |
| 会话 token | `window._PAGE.token` | `token.split('|')[0]` | 登录会话 |

页面自身的 axios 请求拦截器对**每个** `/wapi/` 请求注入：

```js
headers['X-Requested-With'] = 'XMLHttpRequest'
headers.traceId              = <追踪 id>
headers.token                = window._PAGE.token.split('|')[0]   // 会话
headers.zp_token             = cookie('bst')                      // 反爬
params._                     = Date.now()                         // 防缓存
```

扩展复用同一套组合（`authHeaders()`），因为这是唯一被验证能通过服务端校验的形式。

### `_PAGE` 是登录态的权威来源

它由**服务端注入**。未登录时从 `/wapi/zpgeek/common/data/header.json` 拿到的原文是：

```js
_PAGE = {
  checkMobileUrl: "/registe/sendSms.json",
  regMobileUrl: "/registe/save.json",
  loginMobileUrl: "/login/phone.json",
  loginAccountUrl: "/login/account.json",
  getRandomKeyUrl: "/captcha/randkey.json",
  verifyImgUrl: "/captcha/?randomKey={randomKey}",
  getPositionUrl: "/user/position.json",
  citySiteName: "北京站", citySiteCode: "101010100",
  isLogin: false,
  identity: -1          // -1 = 未登录
}
```

登录后同一对象会多出 `userId` / `uid` / `token`。SPA 的路由守卫直接读它：

```js
(window._PAGE || {}).token ? next() : dispatch('getUserInfo').then(...)
```

即 **`_PAGE.token` 不存在就等于没登录**，页面自己就是靠这个判断的。

### `_PAGE` 的完整字段

实测已登录状态下 `_PAGE` 的完整键集：

```
isGeekChat, userId, identity, encryptUserId, name, showName,
tinyAvatar, largeAvatar, token, isHunter, clientIP, email,
phone, brandName, doubleIdentity, recruit, agentRecruit,
industryCostTag, gender, trueMan, studentFlag,
completeDayStatus, complete, multiExpect, encryptComId, uid
```

用户标识应取 `encryptUserId`；昵称 `showName`；头像 `largeAvatar`。

### 失效码与自动刷新链路

响应拦截器定义了整套失效语义：

| 码 | 含义 | 页面自身行为 |
|---|---|---|
| `7` | 登录状态已失效 | toast + 1s 后跳 `/web/user/` |
| `120` `121` `122` | `zp_token` 失效 | 调 `set/zpToken` 刷新 → **重试原请求一次** |
| `200404` | 需要登录 | 弹 `ShowLoginDialog` |
| `5012` | 需安全验证 | 跳 `/web/geek/safe-validate` |
| `37` | 环境异常（风控） | 无处理，直接失败 |

扩展的 `authedFetch()` 复刻了 122 分支：**刷新凭证 → 重试一次**，与页面行为一致（重试上限 1 次，刷新有 30s 频控，两处独立抑制死循环）。

### 凭证刷新接口

```
POST /wapi/zppassport/set/zpToken
```

实测：未登录也返回 `code:0`，并通过 `Set-Cookie` 下发新凭证（无会话时 `bst` 被置空）。

### 扩展怎么获取凭证

三个来源，按可信度排序：

1. **接口侧探测**（最可信）：`GET /wapi/zpgeek/search/job/sidebar.json` → `zpData.geekLogin`。实测免登录可达。
2. **页面注入对象**：`window._PAGE` 的 `isLogin` / `identity` / `userId` / `token`。
3. **cookie 存在性**：`bst`、`__zp_stoken__`。

`window.Cookie` 是**页面自带的工具对象**（实测形如 `{get, getObj, set, del}`），不是 `document.cookie` 的解析。`window.Cookie.get('bst')` 与手工解析结果一致。但它是页面注入的 —— 实测**页面导航瞬间会变成 `undefined`**，所以必须保留 `document.cookie` 解析作为降级路径。

### 关于登录态功能（已下线）

登录态检测 UI 曾实现过（面板提示 + popup 三态指示 + 刷新凭证 / 检查登录态 / 打开登录页三个按钮），**已按需求移除**：登录需要短信验证码，无法自动化，保留一个只能显示"未登录"的指示区没有实际价值。

保留的是**底层凭证机制**，因为它是 `/wapi/` 请求能拿到数据的前提，与界面无关。`authHook` 仍是内部开关（影响主世界的凭证注入），只是不再暴露 UI。

### 一个必须说清的上限

`__zp_stoken__` 由页面的风控 SDK 依据服务端下发的 `seed` / `name` / `ts` 计算生成（bundle 中的错误码自述：`生成__zp_stoken__值失败`、`seed/name/ts中有存在值为空`）。

扩展**不伪造这些值**，也不试图绕过风控。它的定位是：把已有凭证用对、在失效时走服务端给的刷新路径。裸请求遇到 `code 37` 是环境风控的正常结果 —— 这也正是所有接口调用必须发生在页面上下文里的原因。

### 请求头比对与参考实现

认证头组合经过与开源实现的比对（[Ocyss/boss-helper](https://github.com/Ocyss/boss-helper)，MIT）。它的做法是：

```ts
const token = window?.Cookie.get('bst')
fetch(url, { headers: { Zp_token: token } })
```

两点值得注意：

**`Zp_token` 首字母大写**。HTTP 头本应大小写不敏感，但既然有实测有效的参考实现，就与它对齐。扩展同时给出 `token` / `Zp_token` / `zp_token` 三种拼写以兼容改名。

**参考实现还印证了 `lid` 的必要性** —— 它的详情请求签名就是 `getJobDetail({ securityId, lid })`，并带 `_` 时间戳。

用该组合实测：

```
{ "tokenPrefix": "V2RNwnEuD0", "code": 0, "msg": "Success", "jobs": 15 }
```

### 参考实现的边界：哪些没有采纳

`boss-helper` 的定位是自动化投递工具，其中若干功能属于高风险自动化行为，**本次只参考认证机制，不采纳以下部分**：

- `sendPublishReq`（批量投递）：带 `retries = 3` 自动重试，并在命中"您今天已与 120 位 BOSS 沟通"限额弹窗后，**主动调用 `chatremind.json` 发送 `action=addf-limit-popup-c` 确认请求，再以 `cid=1` 参数重投**。这是在规避平台的沟通限额。
- `getBossData`：遇到"非好友关系"错误时自动重试。
- 批量投递、GPT 自动打招呼、多账号 Cookie 切换等产品级功能。

本扩展的定位是**只读的筛选与判定**：拉列表、标红派遣/外包、回填筛选条件。不投递、不打招呼、不重试越限。

---

## 三、架构

```
页面(main world)                         隔离世界              扩展
┌──────────────────────────┐  localStorage  ┌──────────────┐  ┌────────────┐
│ injected.js              │ ──────────────▶│ content.js   │◀▶│ popup      │
│ · 劫持 fetch/XHR          │  + DOM Event   │ · DOM 扫描    │  │ 控制台      │
│ · 捕获筛选参数            │◀───────────────│ · 标红/隐藏    │  └────────────┘
│ · 标红派遣/外包判定        │                │ · URL 回填     │  ┌────────────┐
│ · 认证层:读 _PAGE/cookie  │                │ · 实时监测     │◀▶│ background │
│   失效自动刷新并重试       │                │              │  └────────────┘
└──────────────────────────┘                └──────────────┘
```

**为什么必须分两个世界**：`/wapi/` 接口会校验会话与环境指纹，外部请求直接被判 `code:37`。所以接口调用只能在**页面自身的 JS 上下文**里由页面发出 —— 包括认证凭证的读取与刷新。而 `chrome.*` API 与 DOM 渲染放在隔离世界，避免污染页面的 Vue 运行时。

### 两个世界的通信约束（实测踩过）

**隔离世界访问不到主世界的 `window`。** 这一点必须写死在设计里，因为它的失败方式是静默的 —— `typeof window.__LCS_XXX__` 返回 `undefined`，而可选链 `?.()` 会让整行代码无声跳过。

实测证据（在隔离世界内探测）：

```
__LCS_SET_FILTERS__ -> undefined
__LCS_FETCH_LIST__  -> undefined
__LCS_SNAPSHOT__    -> undefined
__LCS_JUDGE__       -> object      ← 只有扩展自己注入的才可见
```

因此两个世界之间只有两条可用通道：

| 通道 | 方向 | 用途 |
|---|---|---|
| `localStorage` | 双向 | 岗位数据、筛选状态、配置镜像 |
| DOM 自定义事件 | 双向 | `lcs:update` / `lcs:filters`（主→隔离）、`lcs:req-fetch` / `lcs:req-reset`（隔离→主） |

**踩坑记录**：早期版本里 `content.js` 直接调用 `window.__LCS_FETCH_LIST__()` 发起查询、调用 `__LCS_SET_FILTERS__()` 同步状态 —— **这些调用从未执行过**。后果是"回填后主动查询"整条路径形同虚设，筛选状态也只在单边演化。现在改为事件桥接，并在 `verify.js` 里加了断言，禁止这类跨世界直接调用回归。

**另一处相关缺陷**：两侧各自从 URL 解析筛选参数，但键列表不同（隔离世界漏了 `city`）。结果是面板显示 3 项、popup 显示 0 项 —— 两边读同一个 URL 却算出不同结果。现在两侧键列表由自检强制一致。

**筛选状态的权威来源是页面 URL 的 query。** 主世界启动时自行从 URL 同步（不依赖隔离世界写入），并在 `pushState` / `replaceState` / `popstate` 以及一个 1.5s 低频轮询上保持同步 —— 城市切换、筛选点击都会即时反映。

### 文件

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 声明。`document_start` 注入保证尽早挂上钩子 |
| `src/injected.js` | 主世界。劫持 `fetch`/`XHR`、捕获筛选参数与列表数据、**认证层（凭证复用 + 失效重试）**、派遣/外包判定 |
| `src/content.js` | 隔离世界。扫描卡片 DOM、渲染标红、自动回填、实时监测筛选变化、承载消息契约 |
| `src/shared/judge.js` | 派遣/外包判定单一事实来源（两世界共用同一套规则） |
| `src/background.js` | 默认配置初始化、角标统计 |
| `src/popup/*` | 控制台 UI：筛选条件芯片、保存/应用、开关、接口日志 |
| `data/*.json` | 实测抓取的筛选码表（离线资产） |
| `test/*` | 判定回归测试与交付自检 |

### 消息契约

popup 与 content script 之间：

| 消息 | 用途 |
|---|---|
| `LCS_GET_STATUS` | 取页面状态、筛选条件、统计值、配置 |
| `LCS_SAVE_FILTER` | 保存当前筛选为默认（自动剔除 city） |
| `LCS_APPLY_FILTER` | 立即应用已保存条件 |
| `LCS_SET_FILTER_PARAMS` | popup 内逐项剔除筛选项（直接落到 URL） |
| `LCS_SET_CONFIG` | 更新开关，并下发配置镜像到主世界 |
| `LCS_RESCAN` | 清空已归集数据并重新扫描 |
| `LCS_GET_API_LOG` | 取接口日志 |

### 面板内的交互：必须用事件委托

面板内容每次重绘都是整体重建 `innerHTML`。若在重建时逐个 `addEventListener`，旧节点上的监听器会随节点一起丢弃，新节点上没有监听器 —— 表现为**点击没反应**，且不报错。

因此面板内交互统一用**事件委托**：监听挂在 `document` 上，通过 `closest('[data-lcs-action="..."]')` 匹配目标。

已保存条件由 `refreshSavedFilters()` 缓存到 `state.savedFilters`，并通过 `chrome.storage.onChanged` 监听 —— 在 popup 里保存后，面板会立即同步，不需要刷新页面。

---

## 四、派遣/外包判定

### 需求与前置事实

标记「直接表明是派遣或外包」的岗位。注意这里的前提与已下线的双休功能完全不同：

**双休功能之所以删除，是因为数据侧根本不支持。** 详见第一节。

**外包标识则相反：它是招聘方主动写出来的。** 岗位名里的"(外包)"、公司名里的"人力资源服务""劳务派遣"，都是 HR 为了如实说明而填的。所以判定命中即确定，不需要三态。

### 字段与判定依据

标记只看**两个主动标识字段**：

| 字段 | 来源 | 说明 |
|---|---|---|
| 岗位名 | `jobList[].jobName` | 如 `Java开发工程师(外包)` |
| 公司名 | `jobList[].brandName` | 如 `某某人力资源服务有限公司` |

刻意不看职位描述。描述里出现"外包给客户""项目外包经验"属正常叙述，拿来判定会造成大量误报 —— 这条边界是从用户体验倒推出来的。

### 词表与判定顺序

顺序本身是正确性的一部分：

```
1. 排除表述优先  非外包 / 不是外包 / 无外包 / 甲方直招 / 甲方直聘 /
                 正式编制 / 自有员工 / 内包        → 判定为「不是外包」
2. 强标识词      劳务派遣 / 人力派遣 / 人才派遣 / 服务外包 / 项目外包 /
                 人力外包 / 软件外包 / 业务外包 / 技术外包 / 研发外包 /
                 岗位外包 / 外包服务 / 人力资源服务 / 灵活用工 /
                 派遣 / 外包 / 外派 / 驻场 / 乙方 / 劳务
3. 都不命中      → 未标明,不标红
```

**排除必须全局优先，这里踩过一次真实的坑。** 初版写成"命中即 return"，导致岗位名含"外包"时直接返回结果，公司名里的"甲方直招"根本没被检查。回归测试里 `{title:'外包岗位', company:'甲方直招'}` 这一条就是为它设的。

词表按词长降序排列，因此 `includes` 命中的是最具体的词 —— 徽章会显示 `派遣/外包 · 劳务派遣` 而不是笼统的 `派遣`，判定理由可追溯。

### 行为

命中后卡片整体标红（`#e5484d`）：左侧 4px 红条 + 浅红底 + 岗位名变红，右上角挂一个徽章。徽章文案带出**命中的具体词**，悬停显示是命中岗位名还是公司名。

两个开关：`标红派遣/外包岗位`(默认开)、`宽松匹配`(额外扫描福利与技能标签，默认关)。

宽松模式默认关闭是有意的：福利标签属于自由文本，"外包"作为子串出现的场景远比岗位名里多，开了会明显增多误报。

「只看派遣/外包」曾被实现后按需求移除 —— 隐藏非外包卡片会让人误以为页面数据不全。升级到该版本时，若页面未刷新，旧的 `lcs-hidden` 类可能残留在卡片上，代码里保留了清理动作。

### 双源判定

标记不依赖接口调用的成败：

1. **接口侧** —— 已归集岗位的 `jobName` / `brandName`（数据来自响应，最可靠）
2. **DOM 侧** —— 卡片上直接读到的岗位名与公司名

任一命中即标红。这样即使列表接口被风控挡住（`code 37`），标记功能依然可用。

### 判定验证

用注入模拟卡片的方式在真实页面上验证过（纯 DOM，不发请求）：

```
✓ Java开发工程师(外包) | 某某科技有限公司          -> 标红 [外包]
✓ 前端开发-派遣岗位 | 某某科技                    -> 标红 [派遣]
✓ 后端开发工程师 | 某某人力资源服务有限公司        -> 标红 [人力资源服务]
✓ 开发工程师(非外包) | 某某公司                   -> 不标红
✓ 高级Java开发 | 中软国际信息技术有限公司          -> 不标红
✓ 测试工程师 | 正常科技有限公司                    -> 不标红
✓ Java开发 | 某某公司                            -> 不标红
```

7/7 通过。可复跑：`node _cdp/verify-outsourcing.js`。

### 词表的能力边界

`WEAK_WORDS`（`乙方` / `劳务` / `驻场` / `外派`）语义比"外包"宽：驻场可能是技术支援，劳务可能只是描述劳务关系。收紧的第一刀应切这里。

更大的局限是**名字里不含关键词的外包公司判不出来**（如"中软国际"）。这不是缺陷，是字符串匹配的天花板 —— 突破它需要外部数据（已知外包公司名单），属于另一个量级的工作。

---

## 五、验证与自测

```bash
cd extension
node test/judge.test.js   # 派遣/外包判定回归(35 例,含"非外包"排除与公司名命中)
node test/verify.js       # 静态自检
```

`verify.js` 会拦截几类容易悄悄退化的错误：

- JS 语法错误（全部源文件解析一遍）
- manifest / popup.html 引用的文件不存在
- 关键接口与消息契约被改名或删掉
- 认证层的接口、对外 API、请求头组合、失效码处理缺失
- **声明了却没人读的配置开关**（死配置），以及界面控件是否存在
- **隔离世界直接调用主世界函数**（不可见，必定静默失败）
- 两侧筛选参数键列表不一致
- **关键函数定义缺失**（见下）

### 一个值得记下的教训

「保存为默认」按钮曾经完全无反应。原因不是逻辑错误：批量删除「登录态 UI」的代码块时，正则误删了 `renderSaved` 和 `renderLog` 的函数体，**调用点却留着**。于是 `popup.js` 在初始化阶段抛 `ReferenceError`，脚本**整体中断**，后面所有按钮的事件绑定都没执行 —— 而语法检查完全看不出问题。

这类缺陷的判定成本很高（要打开 popup 看控制台），所以加了第 8 项检查：把关键函数名列成清单，确认它们的定义存在。**同类事故已发生两次**（另一次是 `applyConfigToUi` 被删），因此值得用断言锁住而不是靠人工留意。

### 真机验证

`verify.js` 只能做静态检查。**真机验证另有脚本**，因为这类问题只有跑起来才暴露：

```bash
node _cdp/inspect-popup.js       # 打开 popup,检查运行时异常与元素完整性
node _cdp/verify-save-button.js  # 端到端点击「保存为默认」,核对 chrome.storage
node _cdp/verify-outsourcing.js  # 标红判定的真机验证
node _cdp/cdp.js probe           # 登录态与凭证就绪情况
```

注意：**重载扩展后必须刷新页面**再做真机验证，否则已打开标签页里的 content script 已失效，消息会报 `Receiving end does not exist`。

---

## 六、已知限制

- **选择器易碎**：卡片与岗位名/公司名选择器按多套备选链尝试，但 zhipin 改版频繁。若标红失效，优先检查 DOM 是否改版（当前实测 v6740 构建）。
- **列表接口风控**：`code 37` 是环境异常，触发后列表接口一并被拒，冷却约 2 分钟起。实测要点：**页面自己的请求正常，而扩展 JS 直发的 `fetch` 会被识别**（页面请求带 `lid`、`_` 时间戳等特征）。扩展因此只做必要请求，不做任何按需补全的额外调用。
- **URL 回填是单向往 SPA**：扩展写回 URL 后由 SPA 自己决定是否响应。若某次 SPA 不响应，第 2 条路径（直接请求接口）仍会执行。
- **不做反向同步**：扩展不会替你去点页面上的筛选按钮，避免与 SPA 状态打架。
- **端到端已实测**：在真实登录会话中确认插件自动回填生效 —— 页面 URL 被写成 `.../geek/jobs?ka=header-jobs&...&experience=104,105&jobType=1901&salary=406` 且正确渲染出对应岗位。字段判定与风控阈值同为该会话实测结果。

---

## 七、侦察产物

`_recon/` 与 `_cdp/` 保留取证过程，便于后续改版时重新定位：

- `_recon/js/` — 下载的 SPA bundle（v6740），接口定义在 `app~2` 中
- `_recon/ref/harness-job-search.md` — 第三方实测笔记
- `_recon/probe-*.js`、`_recon/get-conditions.js` — 可复跑的接口探测脚本
- `_recon/out-*.json` — 抓取到的筛选码表原始响应
- `_cdp/cdp.js` — 零依赖 CDP 客户端（Node 24 自带 WebSocket，无需 puppeteer）
- `_cdp/probe-dual-field.js` — 字段溯源探针（保留：它正是否决双休判定的那份证据）
- `_cdp/verify-outsourcing.js` — 派遣/外包标红的真机验证（注入模拟卡片，纯 DOM 不发请求）
- `_cdp/out-dual-report.txt` — 90 个岗位的字段清单与取值分布

### 复现本轮实测

```powershell
# 1) 关闭 Chrome 后以调试模式启动
#    必须给独立 user-data-dir —— 这是 Chrome 136+ 的硬要求
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-port=9222 --remote-allow-origins=* `
    --user-data-dir="D:\job-query\_cdp\profile"

# 2) 在窗口里登录 zhipin(短信验证码必须本人完成)
#    该脚本会自动侦测登录成功
node _cdp/wait-login.js

# 3) 字段溯源与验证
#    dual  = 低频模式,输出岗位对象的字段清单与取值分布
#    probe = 登录态与凭证就绪情况
node _cdp/cdp.js dual
node _cdp/cdp.js probe
```

**注意**：复制 profile 无法复用登录态。实测原 cookie 库中存在 `bst` / `__zp_stoken__`，但复制到独立实例后凭据全空 —— Chrome 127+ 的 App-Bound Encryption 把 cookie 密钥绑定到原浏览器环境。所以必须在新实例里重新登录一次。
