# 页面选择器与排障（CNIPA 专利检索及分析系统）

站点：`https://pss-system.cponline.cnipa.gov.cn`，前端 Vue + Element UI，外层瑞数动态反爬（HTTP 412 + `$_ts` 挑战脚本）。

> 2026-11-22 重写。之前踩过的坑按「现象 → 真因 → 正确做法」记录，别再重复试错。

## 一、一条命令的入口（首选）

```bash
node scripts/hunt.js search --name 耳机 --applicant 苹果公司 --kw 耳机,盒 --out <目录>
node scripts/hunt.js verify CN309792845S --out <目录>          # 主视图目视（不耗配额）
node scripts/hunt.js dl     CN309792845S --out <目录>          # 打开下载弹窗，落验证码图
node scripts/hunt.js dlsub  CN309792845S 5575 --out <目录>     # 提交 → 解包 → 出白底视图
```

`search` 走**高级检索 `/seniorSearch`**，服务端直接筛外观设计；`verify/dl/dlsub` 才碰详情页。
stdout 只有一行紧凑 JSON，日志写 `<目录>/_hunt.log`。

## 二、关键选择器（2026-11-22 实测）

| 目标 | 选择器 | 备注 |
|---|---|---|
| 高级检索页 | `/seniorSearch` | **首选检索入口**，见第三节 |
| 检索范围芯片 | `.searchLiLabel span`，文本「外观设计」 | 点击后该 span 获得 `hover` class 表示已选 |
| 检索式编辑框 | `textarea.el-textarea__inner` | 普通 textarea，可 `fill()`；但**必须先点字段名注册**，见下 |
| 检索项字段名 | `:text-is("发明名称")` / `:text-is("申请（专利权）人")` | 点击后 textarea 插入 `<字段>=()` 模板 |
| 检索按钮 | `div.btn,button,.el-button` 且文本为「检索」 | 实际是 `.el-button--primary`（Element 按钮） |
| 结果页 | URL 含 `retrieveList`（`?prevPageTit=gaoji`） | 点检索**开新标签页** |
| 结果行 | 叶节点文本 `/^CN\d{6,}[SU]$/` 向上爬 8 层到行容器 | **不要用 innerText 全局正则**，见第四节 |
| 每页条数 | `.el-select` 含「条/页」→ `.el-select-dropdown__item` | 可选 5/10/20/30/40，默认 10 |
| 翻页 | `.el-pager li.number`、`.el-pager li.btn-next` | **不是裸 `li`**，旧代码用 `li` 永远点不到 |
| 当前页码 | `.el-pager li.number.active` | |
| 总数文案 | `/(\d+)\s*条数据/` | 就绪标志 |
| 详情页 | URL 含 `documents/detail` | 从列表点公开号进入，直连 URL 会空白 |
| 视图标签 | `:text("主视图")` | 点击后 `img[src*=service-image-url]` 才加载 |
| 视图取图 | `canvas.drawImage(img)` + `toDataURL` | 直接 fetch 该 URL 会 400（有鉴权） |
| 下载入口 | 详情页文本为「下载」的叶子节点 | 标记 `data-dl` 再点，避免误点 |
| 下载弹窗 | `.el-dialog` 含「文献下载设置」 | 勾「全文图像」、填验证码、点「确定」 |
| 验证码图 | 响应 `questionShowPic` 的 `t`（base64 JPEG） | 4 位数字，用视觉读 |
| 登录 token | localStorage 里的 JWT（`eyJ...`） | 导出接口 `authorization: Bearer <token>` |
| 会话 cookie | `sessionId`（**40 分钟**有效期） | 登录守卫就靠它，见第五节 |

## 三、检索：为什么改用高级检索

结果页左侧那个「外观设计」是 `dl > dd > div` 的**假芯片**（没有 checkbox class）：
- 点击后经常不生效，或在翻页/重载后状态丢失，表现是「暂无检索数据」或总数不变；
- 会话一抖就白做，是之前 20 分钟白工的主因。

高级检索页 `/seniorSearch` 是正规表单，服务端筛选：

```
1. 打开 /seniorSearch，等 body 有内容（412 挑战，见第六节）
2. 点 .searchLiLabel span「外观设计」          → docTypeScope=['D']
3. 点「发明名称」，再点「申请（专利权）人」    ← 必须点！否则表单模型里没有检索项
4. fill textarea = 发明名称=(耳机) AND 申请（专利权）人=(苹果公司)
5. 点「检索」→ 新标签 retrieveList
```

前端在 `app.385a7132.js` 里定义的枚举：`docTypeScope: 发明=I / 实用新型=U / 外观设计=D`。
请求体形如 `{searchExp:"AES(...)", genSearchType:"AI", docTypeScope:["D"], countryScope:[], dbName:"CNDB,WPDB", interfaceId:"1982630"}`。

**`searchExp` 的 `AES(...)` 是一次性 nonce，重放会返回 `{"status":500,"message":"00030006"}`。**
所以不要想着自己拼请求体 —— 让前端生成，只从它的响应里取数据。

实战效果：`耳机 + 苹果公司` 常规检索 553 条 → 高级检索加外观设计直接 **118 条**，且全是 `CN30*S`。

## 四、列表解析：为什么必须换写法（Beats 误配的根因）

旧写法用一条全局正则吃 `document.body.innerText`：

```js
/^(CN\d{6,}[SU])\s*\n\s*(CN[\d.]+)\s*\n\s*([\d.]+)\s*\n\s*(.+?)\s*\n\s*(.+)$/gm
```

问题：`(.+)` 会跨行、跨记录吞内容，把**下一行的标题/申请号错配到本行公开号上**。
AirPods 那次因此把 CN308654958S 当成 AirPods（实际是 Powerbeats Pro 2），白白用掉 2 次下载配额。

正确做法（`lib.readPage`）：
1. 找所有叶子节点，文本匹配 `/^CN\d{6,}[SU]$/` → 这就是公开号锚点
2. 从锚点向上爬 ≤8 层，直到行容器文本同时含公开号与 `CN\d{11,13}` 且长度 <900
3. 按行内换行取 `[公开号, 申请号, 申请日, 名称, 申请人]`
4. **断言**：申请号里的年份（`CN2025...`）必须等于申请日年份；不等就是错行，`auditRows` 会告警

## 五、会话与登录

- `sessionId` cookie **只有 40 分钟**（实测），过期后页面还在、但所有操作静默失效。
- **不要用「有没有关键词输入框」判断登录态**（旧实现这么干，误判 loggedIn=true，然后拿失效会话空转 12 分钟）。
- 正确判定：`ctx.cookies()` 里找 `sessionId`，剩余时间 >6 分钟才算有效；快过期就重登。
- 登录页 `https://tysf.cponline.cnipa.gov.cn/am/#/user/login`，字段 `input[placeholder*="手机号"]` + `input[type="password"]`，按钮 `button:has-text("登录")`。
- 登录可能弹**滑块验证**；自动化拖动不可靠，首选 `credentials.json` 自动填表，失败时提示用户手动划一次。

## 六、412 挑战：白屏 / 空白结果页的真因（最容易误判）

现象：`page.goto()` 成功，但 `document.documentElement.outerHTML` 只有 **39 个字符**（`<html><head></head><body></body></html>`），`document.body.innerText === ""`，等多久都不变。

真因：瑞数先返回 **HTTP 412 挑战页**，DOM 全空；挑战脚本跑完才会渲染真实页面（约 3-8 秒）。`goto(waitUntil:'domcontentloaded')` 返回的是挑战页那一刻。

正确做法：
```js
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.body && document.body.innerText.trim().length > 150, { timeout: 40000 });
// 之后再 waitForSelector / evaluate 才可靠
```
`waitForSelector` 直接等会因执行上下文被替换而失败（报 context destroyed），一定先等 body。

**结果页新标签更顽固**：点检索开的新标签偶发卡在 412 永远不渲染，重载也救不回来。
处理：表单状态还在原页面，**直接再点一次「检索」重开标签**（`hunt.js` 内已做最多 3 次重试）。

频繁自动检索会触发更长时间的封禁。出现连续 412 就停手，隔 10-30 分钟再来。

## 七、官方下载（详情页下载弹窗，无需入库）

「加入批量下载库」UI 自动化会被安全规则静默拦截（点击无响应、无网络请求），**不要走这条路**。

可行路径：
1. 列表点公开号 → 详情页 `documents/detail`
2. 点左侧「下载」→ 弹「文献下载设置」
3. 勾「全文图像」（= FullTextImage.pdf 公告文本原件）
4. 验证码：弹窗打开时前端调 `GET /api/pubsearch-app-portal/portal/question/questionShowPic`（base64 JPEG），提交时先 `validateVCode`
5. **anId 不带校验位**：`CN202530084109.5` → `"CN202530084109"`（带校验位会 400/500）
6. 导出接口 `POST /api/pubsearch-app-tools/tools/literature/export`，body
   `{"literatures":[{"anId":"CN202530084109","dbName":"CNDB"}],"fields":["FULLTEXT_IMG"],"type":2}`
   → `{"t":".../download/literature/<日期>/下载_<hash>.zip"}`
7. 用会话 cookie 下载解包 → `<申请号>/<申请号>_FullTextImage.pdf`
8. **每天 5 次配额**，一次弹窗流程 = 1 次。所以：先目视主视图确认，再花配额。

## 八、其它已知坑

- **详情页不能直连 URL**（`documents/detail?an=...` 打开是空白），必须从列表点公开号。
- **合成事件被忽略**：`el.click()` 派发的 `isTrusted=false`，Vue 组件不响应。读状态用 `evaluate`，做动作用 `locator.click()`。
- **内外网/自动化浏览器白屏**：必须用真实 Chrome + `--remote-debugging-port` + 独立 `--user-data-dir`，`connectOverCDP` 接管（`navigator.webdriver=false`）。
- **标签页堆积会拖慢**：连续调试后 `ctx.pages()` 可能十几个，逐个关闭只留一个再跑。
- **结果页 URL 完全相同**：新旧 `retrieveList?prevPageTit=gaoji` 无法用 URL 区分，取标签要取最后一个，且跑前先关掉旧的。

## 九、页面改版后的修法

1. `node scripts/probe.js`（或写个 10 行 probe）dump `document.body.innerText` / 关键节点 outerHTML
2. 改 `lib.js` 里对应常量或 `hunt.js` 的选择器
3. 回归：`node scripts/hunt.js search --name 耳机 --applicant 苹果公司`，能输出 `CN30*S` 候选即正常
