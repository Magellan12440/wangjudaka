# 网剧大咖 · 工程仓库

> 微信小程序（AI 漫剧一站式创作 / 生成 / 分发 / 数据回传）+ 服务端编排内核 + PC 工作台
> 方案书：`网剧大咖_实施方案书_v4.2.md`｜进度核查：`docs/进度核查表.md`｜上线操作：`docs/上线操作手册.md`
> 算力上游：灵悟中转站（代理商主账号算力池），网关 `https://api.lingkeai.ai/v1/*`
> **V4.2（2026-11-05）：一句话成剧 OneShot（创作页勾选后自动走完 大纲→总谱→剧本→分镜→出图→剪辑 全链路）+ 大师语法配方库（21 条导演组合配方按风格/节拍自动落地进提示词）+ 零依赖合成音频（9 种情绪 BGM + 16 种音效，无版权）+ 字幕（SRT/ASS + 片头 AI 标识）+ 剪辑单与 FFmpeg 渲染命令 + 分发四步闭环（上传→审核→签合同→提现）+ 微信云托管部署文档；自测 496 项全绿 + 小程序运行时自测扩展通过**
> **V4.1.1 部署就绪（2026-11-05）：发布包 `dist/wangju-daka-4.1.1.tar.gz`（Docker / systemd 双路线 + Nginx HTTPS + 部署手册）；服务端 SIGTERM 优雅退出；`npm run pack` / `deploy:check` 入链**
> **V4.1（2026-11-04）：管理后台补齐邀请面板；邀请裂变（有效邀请才发 ¥1）；剧集系列/续集资产复用**
> **V4.0（2026-11-04）：品牌更名「网剧大咖」，小程序 6 页面全量重写 + 12 节点真实产物驱动**

---

## 0. 安全须知（最高优先级，先读）

| 项 | 规则 |
|---|---|
| 主账号凭据 | **只**存在于 `server/.env.local`，已被 `.gitignore` 排除；绝不写入 `miniprogram/` 或 `web/` 任何文件，绝不写入 git，绝不出现在任何 API 响应里 |
| 前端可见性 | 小程序端与 PC 端**只**能看到：点数余额、点数单价表、模型展示名、生成结果。看不到上游账号、API Key、真实成本 |
| 日志脱敏 | `src/core/redact.js` 全局脱敏 `sk-` / 手机号 / 密码 / `QC_COMPARE_TOKEN`（祖先链检测，合法共享引用不误判） |
| 编译器出口 | 任何模型调用必须经 `PromptCompiler.compile()` → `RelayAdapter.call()`，`RelayAdapter` 构造函数私有 |
| 交付闸门 | 一致性 KPI + 证据链 + AI 标识任一不过即阻断，见 `src/compliance/CompliancePack.js` |
| DAG 事实 | 画布只是渲染层，节点定义永不被布局篡改，见 `src/canvas/CanvasService.js` |
| 上传边界 | 上传助手只做预填与提醒，`no_auto_submit` 恒为 true，见 `src/distribution/UploadHelper.js` |

---

## 1. 目录结构

```
网剧大咖/
├── 网剧大咖_实施方案书_v4.2.md   # 计划书（当前版本，§30–§33 为 V4.2，§29 为 V4.1，§28 为 V4.0）
├── docs/
│   ├── 进度核查表.md                   # ★ 后续任务与进度核查入口（先读这个）
│   ├── 上线操作手册.md                  # ★ 提审到发布的分步操作单（含常见驳回点）
│   ├── 上传与内测指南.md                # ★ 上传要什么密钥、手机内测怎么连后端
│   ├── 上线前需提供的清单.md            # 上线前必须由你补齐的材料
│   ├── API.md                          # 后端接口文档
│   ├── 微信云托管部署.md                # ★ 云托管环境实况 + 一键部署命令 + 参数表
│   ├── 开源方案调研.md                  # 剧本/图片/视频/剪辑四环节开源方案选型结论
│   └── 示例_AI创作说明截图包.html       # 真实生成的 7 页合规证据包（可直接打印）
├── deploy/                             # ★ 部署套件（Nginx HTTPS 反代 / systemd 单元 / 生产环境模板 / 部署手册）
├── dist/                               # 发布产物（tar.gz + sha256，gitignore）
├── Dockerfile / docker-compose.yml     # 容器化部署（node:22-alpine，无需 npm install）
├── miniprogram/                        # 微信小程序（原生 WXML/WXSS/JS，导入微信开发者工具即可运行）
│   ├── app.js / app.json / app.wxss     # 启动登录 / 7 页面 + 4 tab / 设计系统 v2（极光/玻璃卡/扫光按钮）
│   ├── config.js                        # ★ 唯一的运行配置入口（baseUrl 上线前必须换 HTTPS 域名）
│   ├── assets/tab/*.png                 # 8 个 tabBar 图标（零依赖 PNG 生成器产出）
│   ├── pages/                          # index / create / project / distribute / mine / invite / legal
│   └── utils/                          # api.js（请求+上传）/ format.js（格式化）/ motion.js（入场·滚动·进度环·震动）
├── server/                             # 服务端（零第三方运行时依赖，Node 22+ ESM）
│   ├── .env.local                      # 真实凭据（gitignore）
│   ├── .env.example                    # 占位模板（可提交）
│   ├── scripts/
│   │   ├── check_seeds.js              种子完整性自检
│   │   ├── sync_models.js              模型清单同步（dry-run 默认；code 撞车自动加序号）
│   │   ├── smoke_v33.js                V3.3 端到端 HTTP 冒烟（9 步，需先启动服务）
│   │   ├── smoke_v34.js                V3.4 阶段 H 冒烟（自启动 8791，22 步）
│   │   ├── smoke_v35.js                V3.5 微信三件套冒烟（自启动 8798，16 步）
│   │   ├── smoke_mini.js               V4.0 小程序配套冒烟（自启动 8797，33 步）
│   │   ├── check_miniprogram.js        小程序静态体检（11 组）
│   │   ├── mini_runtime_sim.js         小程序页面运行时自测（40 项，伪造运行时跑真页面）
│   │   ├── make_mini_icons.js          tabBar PNG 图标生成器（零依赖）
│   │   ├── live_smoke.js               ★ 真实计费真机验收（--live [--with-video]）
│   │   └── check_web.js                PC 前端体检（语法/引用/零凭据/接口对齐）
│   ├── src/
│   │   ├── config/       环境配置与脱敏（含 QC_COMPARE_* 比对服务配置）
│   │   ├── core/         错误码、脱敏、工具
│   │   ├── relay/        算力池适配器（唯一模型出口）、模型注册表、水位熔断
│   │   ├── compiler/     提示词编译器（七段 + 13 校验）
│   │   ├── seeds/        八大内置库种子数据 + 加载器
│   │   ├── ledger/       点数账本（预扣/结算/退款/幂等）
│   │   ├── qc/           一致性自检服务（V3.3）+ 比对 provider 框架（V3.4）
│   │   ├── canvas/       PC 无限画布服务（V3.4，DAG 是事实、布局只是渲染层）
│   │   ├── wechat/       微信客户端：access_token / code2session / 机审 / 支付签名（V3.5）
│   │   ├── auth/         登录态：openid 建档 + 自签 session token（V3.5）
│   │   ├── security/     内容安全机审（msgSecCheck/imgSecCheck + 审计，V3.5）
│   │   ├── pay/          微信虚拟支付：下单/回调验签/幂等发货（V3.5）
│   │   ├── growth/       邀请裂变：专属码/有效性判定/里程碑结算/反作弊（V4.1）
│   │   ├── analytics/    数据看板 / 收益计算器（V3.3）
│   │   ├── compliance/   AI 创作说明截图包 + 交付闸门（V3.3）
│   │   ├── docs/         创作文档六表 + 跨文档校验
│   │   ├── rhythm/       剧情节奏把控大师
│   │   ├── pipeline/     Blueprint / 故事引擎 / 导演总谱 / 生成服务
│   │   ├── assets/       资产库 + 连续性锁 + 情绪资产
│   │   ├── media/        EDL + FFmpeg 渲染 + AI 标识
│   │   ├── distribution/ 分发中控台（V3.3）+ 上传助手（V3.4，绝不自动投稿）
│   │   ├── store/        JSON 持久化（可平滑换 MySQL）
│   │   └── api/          HTTP 路由（70+ 接口）+ 本地静态托管（web/ 白名单）
│   └── tests/            node --test 单元测试（193 项）
├── web/                                # PC 端工作台（零第三方依赖，浅色主题）
│   ├── index.html                      导航首页（含服务健康）
│   ├── canvas.html / canvas.js / canvas.css    无限画布（拖拽/缩放/平移/推进状态/存布局）
│   └── upload-helper.html / upload-helper.js   上传助手（预填/清单/打开平台/回写/导入导出）
└── miniprogram/                        # 微信小程序前端
    └── pages/ …（首页/创作/项目[含质检]/分发[含看板]/我的）
```

---

## 2. 本地运行

```bash
cd server
npm run seed:check          # 种子完整性（含 8 平台收益政策交叉校验）
npm test                    # 全量单测（串行，221 项）
npm run web:check           # PC 前端体检（语法 / 引用完整性 / 零凭据 / 接口路径对齐）
npm run mini:check          # 小程序静态体检（11 组：结构/事件/跳转/接口/WXML 表达式/零凭据）
npm run mini:sim            # 小程序页面运行时自测（伪造 App/Page/wx，真跑 7 个页面，49 项）
npm run mini:doctor         # 上传环境体检（上传密钥 / miniprogram-ci / 三个环境后端地址）
npm run mini:lan            # 手机内测：打印电脑局域网 IP
npm run mini:preview        # 生成预览二维码（开发版，手机扫码）
npm run mini:upload         # 上传开发版（需先放代码上传密钥；之后在后台设体验版/提审）
npm run models:sync         # 模型清单同步 dry-run（需 Key 或 --from-file）
node src/index.js           # 启动本地 API 服务（默认 8787，同时托管 web/ 页面）
npm run smoke               # 另开终端：V3.3 端到端 HTTP 冒烟（9 步）
npm run smoke:h             # 阶段 H 冒烟（自启动 8791，22 步，跑完自动清理）
npm run smoke:v35           # V3.5 微信三件套冒烟（自启动 8798，16 步）
npm run smoke:mini          # V4.0 小程序配套冒烟（自启动 8797，33 步）
npm run smoke:live          # ★ 真实计费验收：chat+image ≈0.03 算力（--with-video 追加视频）
npm run deploy:check        # 部署套件自检（镜像/反代/systemd/环境模板/打包清单，64 项）
npm run pack                # 打发布包 → dist/wangju-daka-<版本>.tar.gz（含 sha256）
npm run verify              # 一键串联以上全部（448 项），CI 用
curl http://127.0.0.1:8787/health
```

**小程序怎么跑**：微信开发者工具 → 导入项目 → 目录选 `miniprogram/` → AppID 已填 `wxe3380ec60a48931d` →
详情 → 本地设置 → 勾选「不校验合法域名」→ 编译。后端跑在 `http://127.0.0.1:8787` 即可全链路可用
（`miniprogram/config.js` 是唯一的运行配置入口，`hosts` 按 `develop / trial / release` 三套地址自动切换）。
提审到发布见 `docs/上线操作手册.md`；**上传要什么密钥、手机内测怎么连后端见 `docs/上传与内测指南.md`**。

PC 工作台：服务启动后直接打开 `http://127.0.0.1:8787/index.html`（或 `/canvas.html` / `/upload-helper.html`）。

`.env.local` 已配置真实 `RELAY_API_KEY`：填 `RELAY_MOCK=false`（或不设）即为 **live 模式**，
`RELAY_MOCK=true` 则强制 MOCK（演示/压测用）。live 下媒体走任务制（提交→轮询），水位由真实余额驱动。
**一致性自检在无比对服务时恒为「待人工复核」，交付闸门会因此阻断——这是刻意设计，不允许假装通过。**
填 `QC_COMPARE_ENDPOINT` 接入真实比对服务后，`checkAsync` 才会产出真实分数。

---

## 2.5 打包与部署

```bash
cd server
npm run deploy:check     # 先自检部署套件（缺文件/漏种子/凭据泄漏都会在这里被拦住）
npm run pack             # 产出 dist/wangju-daka-<版本>.tar.gz + .sha256 + build.json
```

发布包结构与部署步骤见 **`deploy/README.md`**（随包一起发出）。核心事实：

| 项 | 说明 |
|---|---|
| 运行时依赖 | **零第三方依赖**，只要 Node ≥ 22，不需要 `npm install` |
| 数据 | JSON 文件，落在 `DATA_DIR`（Docker 挂 `./server/data`，裸机 `/var/lib/wangju-daka`） |
| 两条路线 | Docker（`docker compose up -d --build`）／裸机（systemd 单元 + Nginx） |
| HTTPS | 小程序 request 域名只认 https，必须 Nginx + 受信任证书（Let's Encrypt 可） |
| 包内不含 | `node_modules`、`tests`、`scripts`、`data`、`.env`、任何 `.key` |
| 优雅退出 | 收到 SIGTERM 会先 `flush()` 落盘再退出（`docker stop` / `systemctl stop` 都走这条） |

验收四条命令（缺一不可）：

```bash
curl -s https://<域名>/health                                  # 版本对得上
curl -s -o /dev/null -w "%{http_code}\n" https://<域名>/index.html   # 静态页 200
curl -s -o /dev/null -w "%{http_code}\n" https://<域名>/api/admin/overview  # 无令牌应 403
# 建个项目，再去 DATA_DIR 确认 projects.json 真的写进去了（容器没挂卷会在这里露馅）
```

---

## 3. 阶段验收记录

### 阶段 A — 内核（已完成 ✅）
- 种子库全数入库：32 风格 / 6 导演原型 / 38 镜头卡 / 27 转场卡 / 42 光影卡 / 44 节奏模板 / 40 情绪卡 / 8 平台收益政策 + 曲库+模型表+平台库
- 算力池：私有构造 + 签名出口（3 种绕过尝试全部被拒）+ 并发/限流/熔断/三级水位
- 编译器：六段拼装 + 12 条强制校验 + 竖屏 9:16 自动适配
- 测试：37/37

### 阶段 B — 业务层（已完成 ✅）
- 点数账本（预扣/结算/退款/幂等/对账）、资产库（版本快照/影响面）、节奏大师（四闸门）、
  创作文档六表（跨文档体检）、生成服务（编译→预扣→调用→结算）、蓝图引擎（OneShot 报价）
- 时间线（转场 7 规则）、渲染（FFmpeg 命令 + AI 标识 + -16 LUFS）、分发中控（8 平台）
- HTTP 服务 40+ 接口；端到端冒烟：报价 7 集/91 镜/2670 点 → 充值 → 生成扣 6 点 → 对账差额 0
- 测试：79/79

### 阶段 C — 小程序前端（已完成 ✅，V4.0 重写为 6 页面、V4.2 扩为 7 页面，见阶段 J / N-O-P）
- 5 个页面：创作首页 / 提案卡 / 项目详情（流程·资产·镜头·体检）/ 分发中控 / 我的（点数·充值·流水）
- JSON 与 JS 语法检查全部通过，可用微信开发者工具直接导入

### 阶段 D — 一句话成片内容层（已完成 ✅）
- 故事引擎：一句话 → 大纲 → 剧本节奏过闸 → 分镜表（模型不可用时内置结构化兜底，天然合规）
- 转场配额：导演偏好服从硬规则（按集配额 / 8.5 秒间隔 / 集末定格预留）
- 87/87 单元测试；全 32 风格 × 按集时间线 × 总时长精确 = 32/32 通过

### 阶段 E — V3.2 角色情绪库 + 导演视听总谱前置（已完成 ✅）
- **情绪作为资产**：40 张情绪卡（8 条表演锁 / 强度 / 情绪弧线 / 微表情时间轴 / 语气 / 三种亲和 / 专属负面词），
  可入库为角色表演资产、可设角色情绪调色板、可版本化与预演影响面
- **第 13 条强制校验**：在场角色缺情绪卡、卡不存在、高强情绪镜长不足、说话人无语气一律拒绝；
  `image`（分镜图）与 `video` 同等强制
- **七段编译器**：新增 P2.5 情绪表演段，提示词显式声明最高优先级 + 逐角色点名 +
  视频情绪弧线/微表情时间轴/语气，负面词追加表情基线与卡片专属排除项
- **N02.5 导演视听总谱**：镜别 / 光影 / 转场 / 节奏 / 情绪在**剧本与分镜图之前**逐拍定死并自检；
  不合格打回，剧本硬约束注入，分镜图按 `plan_id` 继承，视频阶段只负责让表演动起来
- **103/103 单元测试；全 32 风格端到端 32/32 通过**

### 阶段 G — V3.3 质量锁与分发数据闭环（已完成 ✅）
- 一致性自检（可插拔 provider / 不假装通过 / KPI 报告 / 漂移建议）、数据看板 + 收益计算器、
  合规交付包（7 页证据 + 交付闸门）、模型同步、小程序「质检」tab 与分发页看板/计算器/证据包
- **142/142 单元测试；全 32 风格 32/32；`npm run smoke` 9 步全通过**

### 阶段 H — V3.4 PC 工作台与比对 provider 框架（已完成 ✅）
- **PC 无限画布**（`web/canvas.html` + `src/canvas/CanvasService.js`）：拖拽 / 缩放 / 平移 / SVG 依赖边 /
  节点详情与状态推进 / 保存与重置布局；DAG 是事实，布局只做不可篡改校验后的渲染层
- **上传助手**（`web/upload-helper.html` + `src/distribution/UploadHelper.js`）：表单预填 / 素材清单 /
  交付闸门提示 / 打开平台上传页 / 状态回写 / 预填包导出导入；`no_auto_submit` 恒为 true
- **比对 provider 框架**（`src/qc/providers/` + `checkAsync`）：HTTP 比对适配器，未配置即降级，
  绝不假装通过；`QC_COMPARE_TOKEN` 已入脱敏名单
- **静态托管**（`src/api/static.js`）：web/ 白名单 + 防目录穿越，PC 页直接由服务打开
- **182/182 单元测试；前端体检 10/10；`npm run smoke:h` 22 步全通过；V3.3 既有 9 步不回退**
- 方案书升级为 `网剧大咖_实施方案书_v3.4.md`（§26）

### 阶段 I — V3.5 真实网关对接 + 微信合规三通道（已完成 ✅）
- **真实模型注册表**：10 个占位 upstream_id 全部映射到网关实测模型（9 个有效 + 1 个红线保留条目），
  定价来自 `/skills/models/{name}/pricing` 实测；193 个真实模型已同步落盘（184 个 `commercial_ok=false` 待核验）
- **任务制媒体协议**：网关无 OpenAI 媒体端点，image/video/audio/music 全部走
  `POST /media/generate` → `GET /skills/task-status` 轮询；chat 保持同步
- **真实余额水位**：`/skills/balance` 驱动熔断/告警（60s TTL 缓存，失败回退本地估算）
- **微信登录**：`wx.login` → code2session → openid 建档（幂等）→ 自签 token；小程序 app.js 全链路接入
- **内容安全机审**：msgSecCheck/imgSecCheck 封装 + 3 个创作入口拦截 + 审计流水
- **虚拟支付**：下单/签名/回调验签/幂等发货；未配置商户号时 mock 联调；配置后运维充值通道自动关闭
- **LIVE 真机验收（真实计费）**：chat 6.5s / image 21s（0.0228 算力）/ video 94s（1.296 算力），消耗对账吻合
- **193/193 单元测试；`smoke:v35` 16/16；`smoke:h` 22/22 不回退；前端凭据零命中**
- 方案书升级为 `网剧大咖_实施方案书_v3.5.md`（§27）

### 阶段 J — V4.0 更名「网剧大咖」+ 小程序全量重写 + 自测体系（已完成 ✅）
- **品牌更名**：小程序名、导航标题、方案书、README、docs、服务名（`wangju-daka-server`）全链路替换；
  物理目录名保留（改名会打断微信开发者工具的已导入路径）
- **小程序 6 页面全量重写**：首页（自定义导航 + 一句话输入 + 数据概览 + 作品卡 + 隐私授权弹层）/
  创作（三步向导 + 12 风格可展开 32 + 画幅·画质·时长·视频类型 + 报价防抖 + 总谱预览）/
  剧集详情（6 tab + 12 节点泳道 + 分镜卡 + 资产 + 生成 + 质检 + 交付 Checklist）/
  分发中控（项目横滑 + 4 格看板 + 8 平台宫格 + 状态回填 + 收益测算）/
  我的（点数卡 + 充值 + 兑换 + 流水 + 关于）/ 协议（用户协议 + 隐私政策 + AI 说明）
- **设计系统**：`app.wxss` 一套变量（墨黑 #080A0F + 香槟金 #F2C14E）+ card/btn/chip/pill/sheet/skeleton
- **tabBar 图标**：8 个 PNG 由零依赖生成器（zlib + CRC32 + 3× 超采样抗锯齿）产出，不引入任何第三方资源
- **服务端聚合**：`GET /api/home`（列表 + 统计一次返回）、`GET /api/projects/:id/overview`（详情页一次渲染）
- **真实产物驱动进度**：`RunSync` 按 N01–N12 的真实产物点亮节点，媒体节点无记录就保持 pending；
  修掉 `db.update('runs')` 写空集合导致进度丢失的缺陷（集合名统一为 `blueprint_runs`）
- **短剧节奏闸门兜底**：4 集短剧也会补齐 ≥3 次反转，不再被自己的闸门卡死（新增单测）
- **自测体系三层**：静态体检 11 组 + 页面运行时自测 40 项（伪造 App/Page/wx 真跑页面）+ 接口冒烟 33 项
- **204/204 单测；`npm run verify` 338 项全绿**
- 方案书升级为 `网剧大咖_实施方案书_v4.2.md`（§28 / §29；V4.2 起为 §30–§33）

### 阶段 K — V4.1 管理后台 / 邀请裂变 / 剧集系列（已完成 ✅）
- **管理后台补齐**：`web/admin.html` 新增「邀请裂变」面板（奖励额度 / 每日笔数 / 同 IP 上限 / 新用户窗口 / 发放条件 + 记录表 + 判定无效）；
  原有「充值档次（含赠送福利）」与「兑换码」保持；全部接口 `X-Admin-Token` 鉴权，未配令牌一律 403
- **邀请裂变**：每用户专属 6 位邀请码；有效邀请 = 新用户（24h 内且无作品）+ 未被邀请过 + 非同设备 + 同 IP 未超限 + **完成首部作品**；
  有效才发 1 点（¥1），发放幂等，管理员可撤销并扣回；邀请人每日笔数上限，超限自动挂起补发
- **剧集系列**：一季一个项目，`series_id` / `season_no` / `prev_project_id`；「拍下一季」继承 spec 与角色连续性锁、
  **不继承上一季画面**；`assets/lineage` 可追溯到第一季；归档不删数据，默认列表过滤
- **越权保护**：带登录态时不能替他人建项目/操作他人项目（`403 OBJECT_FORBIDDEN`），堵住「替小号建项目骗邀请奖励」
- **Ledger 扩展**：`grant()` 赠送入账（不计入累计充值）、`adjust()` 可负数撤销（余额不为负、对账仍平衡）
- **小程序**：新增邀请页（专属码/复制/分享带 code/统计/记录/绑定/规则）、剧集详情「拍下一季」、首页与详情显示「第 N 季」
- **220/220 单测（新增 16 例增长用例）；`npm run verify` 383 项全绿**
- 方案书升级为 `网剧大咖_实施方案书_v4.2.md`（§29；V4.2 起 §30–§33）

### 阶段 L — V4.1.1 换号上线链路打通（已完成 ✅）
- **小程序换号**：旧号 `wx7575ac…` 实测是小游戏账号（`gameApp: true` / 上传报 `game.json not found`），
  已换成 `wxe3380ec60a48931d`（`mini:doctor` 确认「账号类型 小程序」）
- **上传成功**：`npm run mini:upload` 已上传 **v4.1.1 开发版**；旧密钥已删除，业务代码零改动
- **修掉编译级缺陷**：`pages/mine/mine.wxml` 流水列表把 `wx:else` 与 `wx:for` 写在同一节点，
  编译器先展开 `wx:for` 导致 `wx:else` 失去配对（`Bad attr wx:else ... wx:if not found`）；
  改为 `<block wx:else>` 包裹，并把该组合加入静态体检第 3 组，防止复发
- **修掉机审阻断**：`msgSecCheck` v2 必须带本小程序真实用户 openid，原来用 `'mock_openid'` 占位，
  真实凭据生效后一律 `40003`，会**卡死建项目**。现在从登录档案取 openid（`ContentSecurity.openidOf`），
  取不到时如实降级为 `degraded_no_openid` 并落审计，不卡用户也不假装已机审
- **221/221 单测（新增 openid 解析用例）；`npm run verify` 384 项全绿**

### 阶段 M — V4.1.1 部署就绪（已完成 ✅）
- **发布包**：`npm run pack` 产出 `dist/wangju-daka-4.1.1.tar.gz`（74 文件 / 166 KB）+ `.sha256` + `.build.json`，
  零第三方依赖自写 tar 写入器（ustar + gzip），跨平台行为一致
- **两种部署形态**：Docker（`node:22-alpine`，无需 `npm install`，`docker compose up -d --build`）／
  裸机（systemd 单元：`EnvironmentFile` + `Restart=always` + `KillSignal=SIGTERM` + `ReadWritePaths`）
- **HTTPS 反代**：`deploy/nginx/wangjudaka.conf`（TLS1.2+、HTTP→HTTPS、ACME 路径、`proxy_read_timeout 600s` 适配长生成、
  `client_max_body_size 25m`、管理台可选 IP 白名单）
- **生产环境模板**：`deploy/env.production.example`（HOST 默认 127.0.0.1、DATA_DIR 独立盘、ADMIN_TOKEN/SESSION_SECRET 必填说明）
- **服务端加固**：`SIGTERM/SIGINT` 优雅退出（先停接入 → `db.flush()` 落盘 → 退出，8s 兜底强退）；
  `HOST` 可配（容器 0.0.0.0 / 反代 127.0.0.1）；`/health` 增加 `version` / `uptime_sec` / `dataDir`
- **打包闸门**：`pack_release.js` 对「种子数据为 0」直接报错；`check_deploy.js` 64 项（含真跑 `--list` 校验清单，
  确保过滤规则没有误删运行必需文件、没有混入 `.env`/`.key`/测试/数据）
- **实测**：解包到干净目录 → 填 `.env` → `node src/index.js` → `/health` 返回 `version 4.1.1 / env production`、
  种子 32/6/38/27/42/44/40、管理端无令牌 403 / 有令牌 200、建项目后 `projects.json` 真实落盘
- **`npm run verify` 448 项全绿**（新增 `deploy:check` 64 项）

### 阶段 N/O/P — V4.2 项目闸门 / 素材库 / 前端 UI 重做（已完成 ✅）

**N. 项目闸门**：项目是唯一创作容器，没有项目不能写剧本、出图、出视频。
- `projectOf(req, projectId, { required })` 统一守卫，缺前置 **428 `PROJECT_REQUIRED`**，越权 **403**；
  `shotService.generate()` 二次校验「有项目但没剧本」同样 428；视频无关键帧 409 `SHOT_SOURCE_REQUIRED`
- 前端流程改造：创作页只建项目 + 建流水线 → 跳 `?setup=1` 停在「素材」tab，不再自动生成总谱；
  用户显式点「生成剧本与分镜」，再逐镜出图/出视频

**O. 素材库**：把小说喂进来的完整通路（全程零第三方依赖）
- 支持 `.txt/.md`（1MB / 12 万字）、`.docx`（10MB，零依赖 ZIP + `inflateRawSync` 抽取正文）、
  图片 8MB、视频 24MB、音频 12MB；单项目 24 条、同类 12 条
- 手写 multipart 解析（对齐 `wx.uploadFile`）；`/media/<24hex>.<ext>` 免鉴权静态服务
  （`<image>/<video>` 带不了 Authorization，靠不可猜文件名 + Range/206）
- `digest()` 把文本素材按条截断（1600 字/条、总量 5000 字）注入故事引擎 prompt；
  图片/视频只作说明，**不假装多模态**；生成后回写 `materials_used` / `reference_chars`

**P. 前端 UI 重做**：设计系统 v2「夜戏」
- `app.wxss` 重写：极光背景（光斑漂移）、玻璃卡（顶部高光）、香槟金扫光按钮、`conic-gradient` 进度环、
  `seg` 滑动指示器、`rise` 阶梯入场、`tap-on` 点击缩放
- `utils/motion.js`：`enter / countUp / ringStyle / segStyle / haptic / clear`，定时器统一挂 `page.__counters`
- 7 页全部重排：首页（hero + 剧组横滑 + 数字滚动）、创作页（三步条 + 提案卡 + 成本条形图 + 建组轨道）、
  剧组页（7 tab + 进度环 + 四宫格上传 + 场次卡 + 逐镜出图）、分发页（看板四格 + 8 平台宫格）、
  我的（金卡余额 + 档位横滑 + 账单）、邀请（票券 + 时间轴）、协议（吸顶分段 + 引言卡）
- 体检新增第 9 组闸门：每页必须有 `pageAnim` 与 `hover-class="tap-on"`，全仓不得残留旧主色 `#f2c14e`

**验收**：`npm run verify` **496 项全绿** —— 228 单测 / 13 前端 / 15 组体检 / 61 运行时 / 64 部署 /
22+16+77 冒烟；版本 4.4.0。

### 阶段 F — 代码侧已就绪，只差资质材料
- ~~真实 API Key~~ ✅ 已配置并验证（V3.5）
- ~~内容安全机审、支付接入、登录态~~ ✅ 代码已完成（V3.5），填微信资质即激活
- ~~小程序可提审状态~~ ✅ 已完成并自测（V4.0 / V4.1）
- ~~管理后台 / 邀请裂变 / 续集~~ ✅ 已完成（V4.1）
- ~~小程序账号类型 + 代码上传~~ ✅ 已打通（V4.1.1，v4.1.1 开发版已在后台）
- 剩余：小程序 AppID / 类目 / 隐私保护指引 / 已备案 HTTPS 域名 / 虚拟支付商户号、合同确认、
  图像比对服务地址、算力充值、曲库音频、平台账号、部署环境
- 详见 `docs/上线操作手册.md`（怎么提审）、`docs/上线前需提供的清单.md`（要准备什么）、方案书 §28.4

---

## V4.9.0 — 亮点：亮色画风 / 账号中心 / 万能素材 / 分发闭环

**A. 画风改明亮（设计系统 v4「晴光」）**
- `app.wxss` 重写为浅色系统：冷白纸感底 `#F4F7FD`、主文字 `#16233A`、暖橙强调 `#FF8A3D`
- 全站深色 hex 批量映射（`#06070C→#F4F7FD`、`#F3C969→#E08A22`、`#6FE0A8→#22B07D`），
  `rgba(255,255,255,低透明)` 一律改为压暗 `rgba(22,35,58,a)`，白底上不再出现"看不见的字"
- `app.json` 导航 / 下拉背景 / tabBar 全部转浅色；新增 `scripts/gen_tab_icons.mjs` 生成 4 组浅色 tab 图标
- 顺手合并重复类定义，修掉字号不全、模块不居中、`.flow-item` 被挤断的老问题

**B. 账号中心（新页 `pages/account`）**
- 服务端 `AuthService` 引入 `token_version` + 设备会话表：**改密 / 退出全部设备 = tv+1，旧 token 立刻失效**，
  不需要黑名单；`sessions()` 可单独踢某一台设备
- 新增注册（手机号+密码，验证码可选）、改密（首设免旧密）、验证码重置、注销（需输入「注销」二字）
- `AccountCenter.js` 一次返回身份/安全/余额/额度/设备；额度含今日、近 7 天、近 30 天与「余额还能跑几次」
- 登录页新增「注册新账号 / 忘记密码」两条通路，短信未接入时给中性提示而不是红字报错

**C. 万能素材**
- 素材不再挑格式：`.csv/.tsv`、`.xlsx`、`.pptx`、`.pdf`、`.json/.srt` 以及任意其它文件都能传
- 新增零依赖 `assets/office.js`：手写 ZIP 中央目录 + `inflateRawSync`，
  xlsx 读 `sharedStrings` + 每张 sheet，pptx 按页取 `<a:t>`，pdf 尽力抽文本
- **读不出正文的文件（扫描版 PDF / 老 .doc）不拒收**：转「存档」并在备注里说清为什么不参与改写
- 小程序端 `wx.chooseMessageFile({ type: 'all' })`，一次最多 9 个

**D. 分发工作台**
- 平台详情里可选「投哪一集」，支持**一次铺到全部平台**（跳过已建过的平台）
- 任务区「新建 +」先选平台再进详情；四步闭环（分发 → 审核 → 签约 → 提现）、数据回填、收益测算、审核材料打包全可用

**E. 文案去后台化**
- 创作页把模型 / 剪辑档位收进「更多设置」，按钮改「就按这个开始」，
  「按当前设定预估消耗」→「整部剧大概要花」，去掉「×倍率扣点」等内部口径
- 首页与空态全部改成口语引导（加料 / 调性 / 出成片）

**验收**：`npm run verify` 全绿 —— 324 单测（新增 `office_parse` 5 项）/ 13 前端 / 15 组体检 /
127 运行时 / 71 部署 / 22+16+78 冒烟；版本 4.9.0

---

## V4.9.1 — 亮点：切换账号 / 本地上传剧本 / 充值独立页 / 容量测算

**A. 切换账号（多账号，一键来回）**
- 新增 `miniprogram/utils/accounts.js` 账号簿：本机保存最近 5 个账号的昵称、手机尾号与 token
- token 是自签的，切换只是换 token → **不需要验证码、不需要联网等待**；`app.switchAccount(uid)` 会用
  `api.me()` 复核一次，被改密/退出全部设备的账号会被标成「需要重新登录」并引导重登，绝不静默失败
- 账号页顶部新增「切换账号」：点别的账号直接切、点「添加另一个账号」进登录页 `?mode=add`（不会把当前账号顶掉）、
  长按可从本机移除

**B. 改编剧本支持上传本地文件**
- 服务端新增 `POST /api/texts/extract`：**不入库、不建项目**，只把文件读成正文回填输入框
- 复用 `assets/office.js` 的解析器：`docx / pdf / xlsx / csv / tsv / pptx / txt / md / json / srt` 全支持
- 创作页把「从聊天选 TXT」换成实心按钮「上传本地文件」，读不出正文的（图片、扫描版 PDF）如实说明原因，
  剧名还空着时用文件名兜一个

**C. 充值系统重建（独立页 `pages/recharge`）**
- 根因：旧弹层里 `pay()` 在「档位没加载出来」时是 `if (!pkg) return;` —— **静默无响应**；
  档位卡点选要依赖已加载的数组，接口一失败就整块点不动。这就是「点充值、点档位都没反应」的实际原因
- 现在所有入口（余额卡、档位卡、收益页「去充值」、余额不足弹窗、账号页）统一进独立页：
  档位 + 自定义金额（1 点 = 1 元，最低 1 元 / 单笔上限 5000）+ 订单记录 + 待支付重试
- 服务端 `VirtualPay.createOrder` 支持 `amountCny` 自定义金额；mock 通道会明确标注「内测直充：到账但不扣真实款项」，
  配好商户号后自动切换到 `wx.requestVirtualPayment`，小程序不用重新发版
- 扣费链路复核：`GenerateService` 走 `ledger.hold → settle/release`，预扣按余额拦截、按实际消耗多退少补，
  失败全额退回；新增 6 条测试锁住「档位/自定义/边界/幂等/预扣结算」

**D. 单密钥容量测算**
- 新增 `relay/Capacity.js` + `npm run capacity` + `GET /api/admin/capacity`
- 输出：单镜/单集/整部成本、单条时延、每分钟吞吐、可同时出片人数、余额可支撑镜头数与**当前瓶颈判定**
- 实测（余额 5.51 算力）：单镜 4.25 算力、3 集短剧 230 算力 → **余额连 1 集都撑不住，瓶颈是余额不是并发**
- 并发闸门由「满了直接拒」改为**先排队再失败**（`RELAY_QUEUE_WAIT_MS`，默认 6s），第 9 个用户不再直接吃错误

**验收**：340 单测 / 13 前端 / 15 组体检 / 142 运行时 / 71 部署 / 22+16+78 冒烟 全绿；版本 4.9.1

---

## V4.10.0 — 亮点：剧本先定版 / 百万字 / 资产出图 / 上传不再静默

**A. 上传本地文件「点了没反应」的根因与修法**
- 老代码 `wx.chooseMessageFile({ fail: () => {} })` —— 失败被吞掉，回调不来时页面什么都不做，
  用户看到的就是「点了没反应」。
- 新增 `miniprogram/utils/pickFile.js`：能力探测 → 真实 errMsg → 老基础库退回 `type:'file'` →
  **40s 无回调主动报错** → 取消与失败分开处理。创作页与素材页统一改走它。

**B. 素材库继承剧本 + 本地入口**
- 素材 tab 顶部新增「已确定的剧本」卡：剧本、角色、场景、道具都沿用这一版，一键跳去换版
- 素材库主按钮改为「上传本地文件（任意格式，一次 9 个）」，Word / PDF / 表格 / 演示稿自动取正文

**C. 剧本先定版，再谈出图（真正的流水线）**
- 新链路：**生成候选（1~3 版）→ 选定一版 → 角色/场景/道具资产卡 → 资产设定图 → 分镜图 → 片段 → 成片 → 分发**
- 服务端新增 `projects/ScriptLibrary.js`：`script_candidates`（候选）与 `script_vault`（个人剧本库）
- `POST /plan/candidates` 一次出两版（常规版 / 强开场版 / 配角视角版），`POST /plan/select` 定稿：
  写总谱 + 建资产卡（只补不删，不冲掉人工调整）+ 自动入库
- **修正了一处自锁**：资产图不能走分镜分支（分镜要求「角色已有图」，而资产图正是在造那张图）。
  新增编译器 `options.mode='asset_sheet'` 分支：定妆图/场景概念图/道具设定图三套构图，
  不校验情绪卡、不带参考图，其余（扣费、归档、质检、stamp）完全复用同一条链。
- 新接口：`GET /assets/overview`（分组+进度）、`POST /assets/:code/image`（单张/重绘）、
  `POST /assets/images`（按类型批量）、`POST /shots/images`（按集批量出分镜图）

**D. 选定即入库，随时可改**
- 新页 `pages/scripts`（我的 → 我的剧本）：列出定稿剧本，可改标题 / 梗概 / 备注，
  可「套用到当前项目」（重建总谱与资产卡），可移除
- 接口：`GET /library/scripts`、`GET /library/scripts/:id`、`POST .../update`、`POST .../remove`、`POST .../apply`

**E. 百万字**
- 单条正文上限 12 万字 → **120 万字**（`text` 文件体积 1MB → 8MB），抽取接口默认同样放到 120 万
- 生成剧本不再「只取前 1600 字」：`digest` 改为**分层压缩**——
  章节结构清单 + 开头 30% + 主体等距抽样 + 结尾 20%，预算内如实标注「已分层压缩」
- 创作页输入框 `maxlength=-1`，计数改 `/1000000`

**验收**：`npm run verify` 全绿 —— 353 单测（新增 `script_library` 8 项 / `asset_sheet` 5 项）/
13 前端 / 15 组体检 / 151 运行时 / 71 部署 / 22+78 冒烟；版本 4.10.0

---

## V4.11.0 — 亮点：内置虚拟导演 / 五维一致性底层强制 / 生成物随手改随手重出

**A. 虚拟导演：把「每一环真的用了库」变成可执行的事**
- 新增 `director/DirectorAgent.js`：九个链式节点（大纲 → 总谱 → 剧本 → 节奏 → 资产 → 分镜 → 片段 → 成片 → 分发），
  每节点声明必须应用的库；前一步不过闸，后一步不许开工
- **强制**：情绪 / 转场 / 运镜 / 节奏四库在任何生成前都必须解析出真实卡号。用户不选，导演按剧情与风格自动挑；
  选了就按用户的来（`pinned`），并写进总谱 `global.director_policy` 与决策日志
- **手动引用不破坏结构**：运镜整片统一；转场只替换原本已是非硬切的拍（配额与 8.5 秒间隔仍由总谱裁决）；
  情绪必须落在该角色调色板内且强度跳变 ≤2；节奏只落到推进/冲突段，开场钩子、反转落点、共情高点、集末钩子保留
- 新页 `pages/director`（项目页顶部「导演」进入）：链式进度、四库选择（含每张卡的中文说明）、五维状态、决策日志
- 新接口：`GET /api/projects/:id/director`、`POST .../director/policy`、`POST .../director/policy/reset`、
  `GET .../director/log`、`GET /api/director`

**B. 五维一致性 = 底层强制规则（不是"生成后再看看"）**
- 新增 `qc/ConsistencyGuard.js`，与图像相似度（`ConsistencyChecker`）互补：
  - **角色**：资产卡 + 连续性锁（按模板下限，角色 4 条）+ 设定图
  - **道具**：镜头点名的道具必须是已建卡的那一件，且带锁
  - **场景**：同一集空间引用同一张场景卡，带空间/光源锁 + 概念图
  - **内容**：镜别/运镜/光影/转场/情绪/节奏必须与总谱一致；对白与说话人自洽
  - **声音字幕**：每个有戏的角色有固定声线资产（缺则自动补一份，绝不让同一角色换嗓子）；
    对白按字幕同步规则算容量与语速，放不下就拦
- 三道闸：编译期（`guardCompile`，花钱前拦住）→ 镜头生成前（`assertBeforeGenerate`，缺卡按模板补齐但仍需出图）
  → 交付闸门（`CompliancePack.deliveryGate` 纳入五维 blockers）
- 新接口：`GET /api/projects/:id/consistency`、`GET /api/projects/:id/consistency/locks`、`GET /api/qc/consistency/guard`

**C. 生成物随手改、随手重出、多版本可选**
- 新增 `POST /shots/:shotNo/update`：改镜别 / 运镜 / 光影 / 转场 / 情绪 / 场景 / 道具 / 时长 / 对白 / 动作；
  **改写同步回总谱**（只有一份事实），角色名单不允许在这里改（换人要回剧本重选）
- 新增 `POST /shots/:shotNo/regenerate`：单镜重出图/视频，保留历史版本
- 新增 `POST /shots/:shotNo/pick`：从历史里选定正式版；剪辑 `collectShots` 优先采用选定版本（不再一律取最新）
- **修复 `regenerate` 的真实缺陷**：老实现只把 patch 丢回编译器，`resample` 传的是空请求，必然报「风格不存在」。
  现在生成时落 `compile_input` 快照，重出以它为底再叠加补丁；老记录给出明确指引而不是编译错误
- 前端镜头卡：「改一改」（弹层改参数，不自动花钱）→「重出这一镜」→「选版本」；镜头 tab 顶部有五维状态与已 pin 的技巧

**验收**：`npm run verify` 全绿 —— 382 单测（新增 `director_agent` 8 / `consistency_guard` 14 / `shot_edit` 7）/
13 前端 / 15 组体检 / 152 运行时 / 71 部署 / 22+16+80 冒烟；版本 4.11.0

---

## V4.12.0 — 亮点：用户点选的规格变成不可偏离的约束（第十个提示词库）

**问题**：开机页的「风格 / 时长 / 剧集 / 画质 / 屏幕比例」只漂到参数层，提示词里几乎看不见；
其中三项还是**算错的**——选 2K 实际出 576×1024（比 720P 更糊，且只扣 0.6 倍点数），
选 4:3 与 1:1 一律按 1920×1080 横屏出，集数则完全靠模型自觉（写几集就是几集）。
用户选完看不出差别，等于没选。

**A. 第十个库：用户规格提示词库**
- 新增 `prompts/SpecLibrary.js` + `core/frame.js`（画幅×画质的唯一真源，编译器与剪辑单共用）
- `normalize()` 把用户点选归一成规格；非法画幅/画质**直接报错**，不再静默退回 9:16
- `segments()` 产出 P0 规格契约段（画布像素 / 构图占位 / 细节目标 / 单片时长 / 片型 / 品牌色板），
  插在六段之前——画布错了后面全白写；`textRules()` 给文本环节产出编剧铁律（集数必须恰好 N 集）
- 规格库纳入 `STAGE_REQUIREMENTS` 的**每一个环节**（含资产设定图与剧本），
  漏传即 `PROMPT_LIBRARY_MISSING`，编译期与 RelayAdapter 两道闸都会拦

**B. 修掉三个真错**
- 2K → `1440x2560`（原 576×1024）；4:3 → `1440x1080`（原 1920×1080）；1:1 → `1080x1080`（原 1920×1080）
- 计价口径修正：2K 图 1.9 倍 / 1080P 1.0 倍（原 1080P 1.6、2K 0.6，高画质反而最便宜）；报价与实际扣费同一函数
- 提示词不再写「2k cinematic quality」这种分辨率字面量，改为画质描述（微纹理/边缘锐度/禁压缩块）——
  写 "720p" 只会让模型往低清方向画
- 资产设定图不再把用户画质硬降成 720P

**C. 集数从"提示里的一句话"变成结构承诺**
- `StoryEngine.fitEpisodes()`：模型少写 → 按节奏模板补足（每集自带 2 个递增冲突 + 集末钩子 + 共情点，
  过得了节奏闸门）；模型多写 → 并进末集（反转与钩子不丢）；时长按用户总时长均分，末集吃取整误差
- 总谱新增 `episode_count / episode_sec_target / video_type`，自检核对集数与单集时长；
  分镜产出后 `assertStoryboardSpec` 再核一次（集数 / 单镜 ≤10s / 画幅），不合规当场抛 `SPEC_VIOLATION`
- 交付闸门新增 `spec_lock`：交付前核对"做出来的还是用户要的那个规格"

**D. 顺带修掉的两个"假生效"**
- 风格 `palette`（之前只给前端画色块看）真正进提示词：`严格色板 #1C1C1C #9E2B25 …，不得引入色板外色相`
- 素材库参考图 `material_references` 之前是死参数（编译器根本没读），现在以 `style_reference` 角色进参考图列表
- 片型真正分流：静态漫剧禁止运镜、解说漫要求旁白优先、动态漫剧要求运镜真实执行

**E. 看得见**
- 项目页镜头 tab 新增「出片规格条」：一行显示 `竖屏 9:16 · 1080x1920 · 1080P · 6 集 × 90s · 动态漫剧`，
  偏差时标红并列出具体问题
- 新接口：`GET /api/projects/:id/spec`（规格体检）、`GET /api/spec/options`（可选清单，避免前后端漂移）；
  `/overview` 增加 `spec` 摘要

**验收**：398 单测（新增 `spec_lock` 15）/ 13 前端 / 15 组体检 / 152 运行时 / 71 部署 / 22+16+80 冒烟；版本 4.12.0
