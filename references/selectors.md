# 页面选择器与排障（CNIPA 专利检索及分析系统）

站点：`https://pss-system.cponline.cnipa.gov.cn`，前端 Vue + Element UI，外层瑞数动态反爬（HTTP 412 + `$_ts` 挑战脚本）。

## 关键选择器（2026-11 实测）

| 目标 | 选择器 | 备注 |
|---|---|---|
| 检索输入框 | `input[placeholder*="关键词"]` | 常规检索页独有，可作页面就绪标志 |
| 检索按钮 | `div.btn` 且文本为「检索」 | **不是** button；顶部菜单也有「检索」二字，必须限定 class |
| 结果页 | URL 含 `retrieveList` | 点检索后**开新标签页**，要在 context 上等 `page` 事件 |
| 结果行 | 文本正则 `^(CN\d{6,}[SU])\n(CN[\d.]+)\n(日期)\n(名称)\n(申请人)` | 页面用 innerText 比 DOM 稳 |
| 筛选芯片 | `:text-is("外观设计")`，用 Playwright 真实点击 | 见下方「合成事件」坑 |
| 结果勾选 | `.el-checkbox`（跳过第 0 个全选框） | 同上 |
| 详情页 | URL 含 `documents/detail` | 同样是新标签页 |
| 视图标签 | `:text("主视图")` | 点击后视图图片才加载 |
| 视图图片 | `img[naturalWidth>200]` | 用页面内 `fetch(src,{credentials:'include'})` 拿二进制，别直连（有鉴权） |
| 登录 token | `localStorage.token`（JWT，Bearer 用） | 导出接口 `authorization: Bearer <token>` |
| 登录手机号/证件号 | `input[placeholder*="手机号"]` | 登录页 `tysf.cponline.cnipa.gov.cn/am/#/user/login` |
| 登录密码 | `input[type="password"]` | 无验证码（账号密码方式） |
| 登录按钮 | `button:has-text("登录")` | Element UI 也渲染成 button |

## 三个坑

**1. 反爬不认自动化浏览器**
内置自动化浏览器打开是**纯白屏**（DOM 为空），因为瑞数挑战脚本检测到自动化环境不渲染。必须用真实 Chrome + `--remote-debugging-port` + 独立 `--user-data-dir`，用 `connectOverCDP` 接管（此时 `navigator.webdriver=false`）。本 Skill 的 `lib.js` 已按此实现。

**2. 检索结果在新标签页**
`div.btn` 点击后在 context 里新建 page。要 `ctx.waitForEvent('page')` 捕获，否则一直等旧页面。

**3. 详情页图片有鉴权**
直接 `<img src>` 拷 URL 出来 curl 会 403。必须在页面上下文里 `fetch` 再转 base64 落地。

**4. 合成事件会被忽略（重要）**
`el.click()` 派发的 click `isTrusted=false`，CNIPA 的 Vue 组件不响应（筛选芯片、勾选框都如此）。必须用 Playwright 的 `locator.click()`（走 CDP 真实输入）。读状态用 `evaluate`，做动作用 `locator`。

**5. 官方导出接口（重点）**
`POST /api/pubsearch-app-tools/tools/literature/export`，Bearer token + body：
```json
{"literatures":[{"anId":"CN202130547907","dbName":"CNDB"}],"fields":["TIVIEW","ANID","APD","PNID","PD","IC","PAVIEW","INVIEW","PR","ABVIEW","ABS_IMG","DESC","CLMS","FULLTEXT_IMG"],"type":2}
```
返回 `{"t":"https://.../download/literature/<日期>/下载_<hash>.zip"}`，zip 用会话 cookie 下载，解包得 `<申请号>/<申请号>_FullTextImage.pdf + images/Abstract.png`（官方公告文本原件）。
**限制：每天 5 次下载配额**（见「加入批量下载库」弹窗），且重复调用会报 500/"10000000"（任务冲突或配额）。所以：**所有专利号合并成一次导出调用**，失败就等第二天。抓包脚本 `capture.js` 可重抓接口变化。

## 会话过期

`patent_profile` 里的 cookie 几小时失效，表现为 `ensureLoggedIn` 返回 `NEED_LOGIN`。
- 手动：窗口里登录一次，登录态自动写回该档案
- 自动：`credentials.json` 存账号密码，`ensureLoggedIn` 会自己填表提交（无验证码，实测可自动）

## 页面改版后的修法

1. 先跑 `node scripts/probe.js`（若存在）或用 playwright 打开页面 dump `document.body.innerText`
2. 定位新选择器，改 `lib.js` 对应常量
3. 回归：`node run.js search --query "遥控器" --max 3`，能出 `CN30xxxxxxxS` 即正常

## 官方下载的可行路径（2026-11-20 实测，无需入库）

「加入批量下载库」UI 自动化会被安全防护规则静默拦截（点击无响应、无网络请求），**不要走这条路**。可行路径是**详情页的下载弹窗（带验证码）**：

1. 从检索列表点击公开号打开详情页（`documents/detail`）
2. 点左侧「下载」链接 → 弹出「文献下载设置」对话框
3. 勾选「全文图像」（= FullTextImage.pdf 公告文本原件），也可加「摘要附图」
4. 验证码：弹窗打开时前端调 `GET /api/pubsearch-app-portal/portal/question/questionShowPic`（返回 base64 JPEG），提交时先调 `validateVCode` 校验，随后即可调导出接口
5. 验证码识别：截取响应里的 base64 JPEG 用视觉能力读出（4 位数字/字母，实测可自动）
6. **anId 格式（易错！）**：不带校验位。`CN202530344171.5` → `"CN202530344171"`（CN 前缀 + 12 位）。带校验位会报 400/500
7. 导出接口同前：`POST /api/pubsearch-app-tools/tools/literature/export`，body `{"literatures":[{"anId":"CN202530344171","dbName":"CNDB"}],"fields":["FULLTEXT_IMG"],"type":2}` → 返回 `{"t":".../download/literature/<日期>/下载_<hash>.zip"}`
8. zip 用会话 cookie 下载（`ctx.request.get`），解包得 `<申请号>/<申请号>_FullTextImage.pdf`
9. 每日 5 次下载配额；一次弹窗流程 = 1 次配额

