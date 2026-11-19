# design-patent-hunter 外观专利猎手

拍一张产品照片，自动完成：**AI 认图 → CNIPA 外观设计专利检索 → 下载官方公告 PDF → 提取各视图原图（透明底 / 规范命名）**。

最终交付两样东西：

1. `<申请号>_FullTextImage.pdf` —— 国家知识产权局授权公告文本**官方原件**（扉页 + 全部视图 + 简要说明）
2. `views/` 文件夹 —— 各视图透明底 PNG，按 `作者_设计N视图_宽x高.png` 命名，可直接导入建模软件还原 3D 模型

```
产品照片
   │  AI 视觉识别（品类 / 形态特征 / 洛迦诺分类 / 关键词）
   ▼
CNIPA 专利检索及分析系统（pss-system.cponline.cnipa.gov.cn）
   │  关键词检索，筛选外观设计（真实 Chrome + CDP，过瑞数反爬）
   ▼
候选专利列表 ── AI 视觉比对 ──> 确认命中
   ▼
官方导出接口（一次调用打包全部申请号）
   ▼
├── <申请号>_FullTextImage.pdf   官方公告文本
└── views/                       各视图透明底 PNG（墨迹包围盒精确裁切）
```

## 实测效果

输入 Siri Remote（第二代）照片，命中苹果公司专利 **CN307048716S**（申请号 CN202130547907.0）：

- `demo/CN202130547907_FullTextImage.pdf` —— 官方公告文本，与官网手动下载逐字节一致
- `demo/views/` —— 14 张视图（设计1、设计2 各 7 视图），命名示例：

```
苹果公司_设计1主视图_164x604.png
苹果公司_设计1后视图_164x603.png
苹果公司_设计1左视图_50x599.png
苹果公司_设计1立体图_155x560.png
...
```

视图尺寸自洽（主/后等高、左右等宽），墨迹包围盒精确到原始上传图的边界，建模时比例可直接对齐。

## 快速开始

```bash
npm install        # playwright-core + pdfjs-dist + @napi-rs/canvas

# 1. 首次使用：登录 CNIPA（弹出专用 Chrome 窗口，登录态保存在本地档案）
node scripts/run.js search --query "遥控器" --max 1
# 返回 {"code":"NEED_LOGIN"} 时，在弹出的 Chrome 窗口里登录后重跑

# 2. 检索外观设计专利
node scripts/run.js search --query "遥控器 AND 苹果公司" --max 30 --out ./out/产品名

# 3. 下载官方公告 PDF
node scripts/run.js fetch --ids CN307048716S --out ./out/产品名

# 4. 从 PDF 提取各视图（透明底，按作者_视角_尺寸命名）
node scripts/extract_views.js <公告PDF> ./out/产品名/views --author 苹果公司
```

在 [WorkBuddy](https://www.workbuddy.cn) 等 AI 助手里作为 Skill 使用时，第 1 步的"认图"和第 3 步的"视觉比对命中"由 AI 完成，人只需要拍一张照片。

## 目录结构

```
├── SKILL.md                  # AI 助手 Skill 清单（五步工作流 / 故障处理 / 硬规矩）
├── scripts/
│   ├── lib.js                # Chrome 启动（专用档案持久登录）+ 检索 + 结果抽取
│   ├── run.js                # 主流程：search / fetch / all
│   ├── official.js           # CNIPA 官方导出接口（Bearer token + 批量 zip）
│   ├── zip.js                # 零依赖 ZIP 解包（GBK 文件名兼容）
│   ├── extract_views.js      # 整页渲染 + 标题定位 + 墨迹包围盒裁切 + 白底转透明
│   ├── extract_native.js     # 内嵌位图原生分辨率抽取（CTM 几何配对标题）
│   ├── pdf.js                # Chrome 无头 HTML→PDF（兜底公告文本合成）
│   ├── doc.js                # 公告文本版式
│   ├── capture.js            # 网络抓包（接口变了用它重抓）
│   └── probe.js              # 页面诊断
├── references/
│   ├── locarno.md            # 洛迦诺分类速查
│   ├── search-syntax.md      # CNIPA 检索语法（只收录实测可用的）
│   └── selectors.md          # 页面选择器 / 反爬排障 / 导出接口文档
└── demo/                     # Siri Remote 端到端实测样例
```

## 两套视图输出

| 输出 | 说明 | 适用 |
|---|---|---|
| `extract_views.js`（默认） | 300dpi 渲染 + 墨迹包围盒收紧，如 164×604 | 建模参考、展示（推荐） |
| `extract_native.js --transparent` | PDF 内嵌位图原生分辨率，如 82×302，零插值 | 追求零失真 |

说明：CNIPA 公告 PDF 里的视图是**内嵌位图**（非矢量），存储分辨率约为版面显示的一半。两款工具都从同一数据源出发，前者平滑放大，后者保留原生像素。

## 技术要点（踩坑记录）

详细版见 `references/selectors.md`。

1. **瑞数反爬**：pss-system 对自动化浏览器直接白屏。必须真实 Chrome + `--remote-debugging-port` + 独立 `--user-data-dir`，`connectOverCDP` 接管（`navigator.webdriver=false`）
2. **合成事件被忽略**：`el.click()`（isTrusted=false）对 CNIPA 前端无效，筛选/勾选必须走 CDP 真实鼠标输入
3. **官方导出接口**：`POST /api/pubsearch-app-tools/tools/literature/export`，Bearer JWT 在 `localStorage.token`，返回 zip 直链；**每天 5 次下载配额**，所有申请号合并成一次调用
4. **会话有效期**：仅数小时；`credentials.json`（参考 `credentials.example.json`）可自动重登
5. **内嵌位图**：公告 PDF 的视图不是矢量；用 pdfjs 渲染 + 标题几何配对（CTM 摆放区域 ↔ 标题坐标）定位，比手动框选精确

## 免登录配置（可选）

```json
// credentials.json（明文保存于本机，勿提交/勿外传）
{ "account": "手机号或证件号", "password": "密码" }
```

## 免责声明

- 本工具仅供个人/企业内部侵权风险自查与竞品外观布局摸底，**法律效力以官方公告为准**
- 请遵守 CNIPA 服务条款：不要高频批量爬取（脚本内置 3 秒节流，单轮 ≤30 件）
- 不要将 `credentials.json`、`patent_profile/` 上传到任何地方
