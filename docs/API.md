# 后端接口文档

> 服务启动：`cd server && node src/index.js`（默认 http://127.0.0.1:8787）
> 统一响应：`{ ok: true, data }` 或 `{ ok: false, code, message, detail }`
> 所有响应经全局脱敏，任何含凭据的字段都不会出网。

## 基础

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（含算力模式、种子库计数） |
| GET | `/api/config` | 前端白名单配置（点数档位、AI 标识开关） |

## 目录库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/styles` | 32 种风格 |
| GET | `/api/styles/:code` | 风格详情（含画风、调色板、光影约束、镜头配比） |
| GET | `/api/directors` | 6 种导演原型 |
| GET | `/api/shot-cards?dim=distance\|height\|orientation\|lens\|movement` | 38 张镜头卡 |
| GET | `/api/lighting-cards?cat=time\|position\|motion\|color` | 42 张光影卡 |
| GET | `/api/transitions?kind=in_camera\|post` | 27 张转场卡 |
| GET | `/api/rhythm-templates?cat=hook\|conflict\|reversal\|empathy` | 44 条节奏模板 |
| GET | `/api/models?role=chat\|image\|video\|audio\|music` | 模型（只含展示名与点数价，不含上游真名） |

## 账户与点数

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account/balance?userId=` | 余额 |
| GET | `/api/account/entries?userId=` | 流水 |
| POST | `/api/account/recharge` | 充值（**必须**用微信订单号做 `idemKey`，幂等） |
| GET | `/api/account/reconcile?userId=` | 对账（余额 == 流水求和） |

## 项目 / 蓝图

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/projects` | 建项目（风格/画幅/画质/总时长/视频类型） |
| GET | `/api/projects?userId=` | 项目列表 |
| GET | `/api/projects/:id` | 项目详情 |
| GET | `/api/home` | **小程序首页聚合**：`{ stats, projects[] }`，一次拿到统计 + 作品（含 style_name / episodes / shots / credits / progress / run_id / next_node） |
| GET | `/api/projects/:id/overview` | **小程序详情聚合**：`{ project, style, run, progress, plan, shots≤24, assets, generations≤20, qc, gate, docs }` |
| POST | `/api/oneshot/quote` | **一句话成片报价**（集数/镜头数/点数/耗时；`videoType` 影响视频成本折减） |
| GET | `/api/blueprints` | 蓝图模板（BP_ONESHOT 等 5 套） |
| POST | `/api/runs` | 创建运行（创建即按已有产物同步节点） |
| GET | `/api/runs/:id` | 运行详情（节点状态由真实产物驱动，非手工点完成） |
| GET | `/api/runs/:id/next` | 下一待执行节点 |
| POST | `/api/runs/:id/nodes/:nodeId` | 更新节点状态 |

## 系列 / 续集（V4.1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/series?userId=` | 我的系列分组（一部剧 = 一个系列，一季 = 一个项目） |
| GET | `/api/projects/:id/series` | 某项目所属系列：各季列表 + 跨季共享角色 |
| POST | `/api/projects/:id/season` | 开下一季：继承 spec 与角色连续性锁，**不继承画面**；body 可带 `title` / `prompt` |
| POST | `/api/projects/:id/archive` | 归档 / 取消归档（`{archived:true/false}`）；默认列表过滤归档 |
| GET | `/api/projects/:id/assets/lineage` | 资产跨季血缘（origin_project_id / origin_asset_code） |

> 越权红线：带 `Authorization` 时只能操作自己的项目，跨用户一律 `403 OBJECT_FORBIDDEN`。

## 项目闸门（V4.2，最重要的一条）

**没有项目，就不能写剧本、出图、出视频。** 所有创作类接口都过同一个守卫 `projectOf(req, projectId)`：

| 情况 | 状态码 | 业务码 |
|---|---|---|
| 项目不存在 / 没建项目就调生成 | **428** | `PROJECT_REQUIRED` |
| 带登录态但项目不属于自己 | **403** | `OBJECT_FORBIDDEN` |
| 项目 ID 查不到（非幂等查询） | 404 | `NOT_FOUND` |
| 有项目但还没生成剧本就出图 | **428** | `PROJECT_REQUIRED`（`shotService` 二次校验） |
| 视频请求但该镜还没关键帧 | 409 | `SHOT_SOURCE_REQUIRED` |

> 为什么是 428 而不是 400：请求本身是合法的，缺的是**前置条件**。前端据此弹「先去建项目」引导，而不是报参数错误。

## 素材库（V4.2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/materials` | 素材列表 + `stats`；**不下发全文**，只给 `preview`（前 120 字） |
| POST | `/api/projects/:id/materials/text` | 粘贴文本入库：`{ name, text, note }`（20 字 ~ 12 万字） |
| POST | `/api/projects/:id/materials/upload` | multipart 上传（`field=file`，可多文件，`note` 字段带说明）：txt/md/docx/png/jpg/webp/mp4/mov/mp3/wav |
| POST | `/api/projects/:id/materials/:materialId/remove` | 删除素材（同时清磁盘文件） |
| GET | `/api/projects/:id/materials/digest` | 摘要预检：`{ text, used, chars }`，前端显示「将引用 N 字」 |
| GET | `/media/<24hex>.<ext>` | **免鉴权**静态文件（`<image>/<video>` 无法带 Authorization）；支持 `Range` → 206 |

上限：图片 8MB / 视频 24MB / 音频 12MB / 文本 1MB（12 万字）/ docx 10MB；单项目 24 条、同类 12 条。

| 错误 | 状态码 | 说明 |
|---|---|---|
| `MATERIAL_UNSUPPORTED` | 415 | PDF / 可执行文件等不支持的类型 |
| `MATERIAL_TOO_LARGE` | 413 | 超过单文件上限 |
| `MATERIAL_EMPTY` | 422 | 空文本 / 超长文本 |
| `MATERIAL_LIMIT` | 409 | 超过条数上限 |

`digest()` 注入规则：文本按条截断（1600 字/条）、总量 5000 字；图片/视频/音频只把 `name + note` 作为参考说明列出，
**不声称多模态**。`POST /projects/:id/plan` 会把摘要作为 `reference` 传给故事引擎，落库 `materials_used` 与 `reference_chars`。

## 剧本视图与逐镜生产（V4.2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/script` | 剧本阅读视图：`{ outline, episodes[{no, scenes[{beat_no, action, dialogue[], locked}]}], materials_used }` |
| POST | `/api/projects/:id/shots/:shotNo/generate` | 按分镜号出片：`{ kind: 'image' \| 'video' }`；服务端按总谱拼 `compileRequest`（前端不能绕过总谱） |
| GET | `/api/projects/:id/shots/:shotNo/generations` | 该镜历史产物（含真实点数） |

`kind='video'` 必须是本镜已有关键帧，否则 409 `SHOT_SOURCE_REQUIRED`；镜号不存在 404 `SHOT_NOT_FOUND`。
`shotService` 返回 `{ ...生成结果, shot_no, kind, compile:{ shot_card, lighting_codes, transition, emotion, pending_references } }`。

## 邀请裂变（V4.1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/invite/me?userId=` | 我的邀请面板：专属码 / 统计 / 记录（昵称脱敏）/ 规则文案 |
| POST | `/api/invite/bind` | 绑定邀请关系 `{code, deviceId}`；返回 `{ok,status,message}`，`status` ∈ pending/qualified/rewarded/rejected |

**有效邀请判定**（全部满足才发奖）：邀请码有效 · 非自邀 · 该账号未被邀请过 · 注册 24h 内且无作品 ·
非同设备 · 同 IP 未超限 · 被邀请人完成首部作品 · 邀请人当日未超笔数上限。奖励默认 1 点（1 元），幂等键 `invite:<inviteId>`。

## 管理端 · 邀请（V4.1，需 `X-Admin-Token`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/invites?status=&limit=&offset=` | 邀请记录（含无效原因文案） |
| GET | `/api/admin/invites/stats` | 统计：待完成 / 已发放 / 无效原因分布 / 当前规则 |
| POST | `/api/admin/invites/reject` | 判定无效 `{inviteId, reason}`；已发奖励自动从余额扣回 |
| GET/POST | `/api/admin/invite-settings` | 读写规则：奖励点数 / 每日笔数 / 同 IP 上限 / 绑定窗口 / 是否需里程碑 |

## 资产 / 文档 / 节奏

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/projects/:id/assets` | 建资产（角色/场景/道具/声线，锁数不足会被拒） |
| GET | `/api/projects/:id/assets?type=` | 资产列表 |
| POST | `/api/projects/:id/assets/impact` | 升版影响面预演（命中镜头数 + 重生成点数） |
| DELETE | `/api/projects/:id/assets/:code` | **本人删除资产**（需 `{confirm:true}`，写删除凭证；`POST .../delete` 为别名） |
| GET | `/api/projects/:id/assets/deletions` | 删除凭证（谁/何时/哪一份/原因） |
| GET | `/api/me/assets` | 本账号资产总账（只读对账，不跨账号） |
| GET | `/api/admin/assets/isolation` | 隔离自检（管理端） |
| GET | `/api/admin/assets/rule` | 资产归属与保留规则四条（R1 归属 / R2 隔离 404 / R3 永久保留 / R4 仅本人可删） |
| POST | `/api/projects/:id/docs` | 写创作文档（六表之一） |
| GET | `/api/projects/:id/docs/check` | **跨文档体检**（角色/场景缺失、缺光影卡、对白超长…） |
| POST | `/api/rhythm/diagnose` | 节奏诊断（四项闸门 + 修订建议） |
| POST | `/api/rhythm/gate` | 节奏闸门（不达标返回失败原因） |
| GET | `/api/rhythm/curve?totalSec=90` | 单集节奏曲线五段 |

## 故事引擎（一句话成片）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/story/outline` | 一句话 → 大纲与人物（N02） |
| POST | `/api/story/storyboard` | 大纲 → 分镜表（N05，每镜字段齐备可直接过编译器） |
| POST | `/api/story/rhythm` | 节奏闸门（N04，返回五闸与修订建议） |
| POST | `/api/story/asset-drafts` | 大纲角色 → 资产草稿（锁数达标） |

## 生成（唯一出口）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/generate` | 编译 → 预扣 → 调用 → 结算（失败全额退回） |
| POST | `/api/generate/:id/regenerate` | 重生成：`resample` / `change_prompt` / `change_reference` / `change_model` |
| GET | `/api/generations?projectId=&shotNo=` | 生成记录 |
| POST | `/api/compile/preview` | 只编译不花钱（看提示词与卡片） |
| POST | `/api/compile/validate` | 只校验（分镜表批量体检） |

## 时间线 / 渲染 / 交付

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/timeline/build` | 构建 EDL（强制 7 条转场规则） |
| POST | `/api/render/command` | 生成 FFmpeg 命令（含 AI 标识烧录、-16 LUFS 响度归一） |
| POST | `/api/render/music` | 逐镜配乐规格（含署名清单） |
| POST | `/api/render/delivery` | 交付包（含 AI 创作说明与证据清单） |

## 分发

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/platforms` | 8 个平台卡片（政策库） |
| POST | `/api/distribution` | 建分发任务（带材料清单） |
| POST | `/api/distribution/:id/status` | 更新状态（按平台状态机校验） |
| POST | `/api/distribution/:id/revenue` | 收益回传 |
| POST | `/api/distribution/:id/stats` | 数据回传（播放/完播） |
| GET | `/api/distribution?projectId=` | 任务列表 |
| GET | `/api/distribution/summary?projectId=` | 收益看板 |

### 分发收益排行榜（V4.16）

口径：**全平台 + 全时间累计**，不做单平台榜、不做日/周榜；**只取前 1000 名**；**每日刷新一次**（东八区自然日）；
**所有用户默认参与**。收益只能写自己的分发（跨账号 404），避免名次被代刷。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/leaderboard` | 榜单（**公开可读**，未登录也返回同一份）。带登录态时多返回 `me`（我的名次 / 距前 1000 差多少）。条目只有名次、昵称、金额、作品数、平台数、涨跌，**不含 user_id** |
| GET | `/api/leaderboard/rules` | 榜单口径（容量 1000 / 每日刷新 / 默认参与 / 4 条说明），前端文案与此同源 |
| POST | `/api/leaderboard/participation` | `{optOut:true}` 退出榜单并**当场重建**当天快照；`{optOut:false}` 恢复参与 |
| POST | `/api/admin/leaderboard/refresh` | 管理端手动重算（`X-Admin-Token`），返回与上一份快照的新增/掉榜人数 |


## V3.2 角色情绪库（情绪作为资产）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/emotion-cards?cat=&intensity=` | 40 张情绪卡（basic/conflict/low/high/micro），返回精简目录 |
| GET | `/api/emotion-cards/:code` | 单张完整卡（含 8 条表演锁、micro_timeline、voice_hint） |
| POST | `/api/projects/:id/assets/emotion` | 把情绪卡固化成角色表演资产：`{emotionCode, characterCode, name, lockValues}` |
| GET | `/api/projects/:id/assets/emotion?characterCode=` | 列出角色情绪资产 |
| POST | `/api/projects/:id/assets/:code/emotion-palette` | 设角色情绪调色板：`{baseline, palette[], forbid[]}` |
| GET | `/api/projects/:id/assets/:code/emotion-palette` | 读调色板（未建档返回角色定位默认） |

编译请求新增字段：`shot.emotions = { CH01: 'EMO-XXX' }`（或顶层 `emotion_map`）、
可选 `assets.emotions`。输出新增 `cards.emotion`。
在场角色缺情绪卡 → `MISSING_EMOTION_CARD`；`image` 与 `video` 同等强制。

## V3.2 导演视听总谱（N02.5，剧本与分镜图之前）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/story/plan` | 由大纲生成总谱（镜别/运镜/光影/转场/节奏/情绪逐拍定死 + 自检） |
| POST | `/api/story/plan/validate` | 只做总谱自检 |
| POST | `/api/story/plan/constraints` | 取注入剧本的硬约束文本 |
| POST | `/api/story/script` | N03 剧本；总谱不合格抛 `PLAN_NOT_APPROVED` |
| POST | `/api/story/storyboard` | N05 分镜；可传 `plan` / `script`，缺省自动建总谱 |
| POST | `/api/story/chain` | 一句话 → 大纲 → 总谱 → 剧本 → 分镜 → 节奏闸门（全链路结构化产物） |
| POST | `/api/projects/:id/plan` | 项目创建后生成并持久化总谱（集合 `director_plans`） |
| GET | `/api/projects/:id/plan` | 读回同一份总谱（含 outline / plan / script / storyboard） |
| GET | `/api/projects/:id/director/brief` | **V4.17** 定调：`tone / one_liner / theme / color / camera / cut / sound / avoid / checkpoints / derived_from`（有 plan 读 plan，无 plan 现场推导，确定性输出） |
| GET | `/api/projects/:id/director/grammar?episode=` | **V4.17** 镜头语法体检：11 类判据（时长越界 / 连续同卡 / 同运镜 / 景别卡死 / 跳级硬切 / 开场无交代 / 快切无呼吸 / 快慢对比 <1.5 倍 / 特写过载 / 集末无定格 / 全硬切），打分 A/B/C/D |
| GET | `/api/projects/:id/director/preflight?shotNo=` | **V4.17** 单镜预检：时长与叙事目的区间、景别、参考图齐备性、提示词预算一次给全 |

三个导演接口均走账号隔离：非本人项目返回 **404**（不泄漏存在性）。

`/api/story/plan` 请求：`{outline, spec, projectId?, planId?}`。
`/api/story/chain` 请求：`{userId, projectId, prompt, spec, model?}`。
所有下游产物都带 `plan_id` / `beat_no`，剧本每场回抄 `locked` 供核对。

## V3.3 质检：一致性自检与交付闸门

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/qc/providers` | 已注册比对 provider 及可用性（`feature` 可用 / `mock` 恒降级） |
| POST | `/api/qc/consistency/check` | 单镜自检：`{projectId, shotNo, assetCode?, reference, candidate?, similarityScore?, provider?, threshold?, strict?}` |
| GET | `/api/qc/consistency/report?projectId=&episode=&threshold=` | KPI 报告：通过率 / 平均分 / 漂移 / 待复核 / 按集按资产聚合 |
| GET | `/api/qc/consistency/advice/:id` | 漂移镜的重生成建议（mode = resample / change_prompt / change_reference / change_model） |
| POST | `/api/qc/delivery-gate` | `{projectId, episodeNo?, threshold?}` → `ready / blockers[] / warnings[] / consistency / evidence` |

**provider 契约**：`{name, available, compare({reference,candidate}) -> {score, dimensions}}`。
`reference` / `candidate` 为 `{locks[], emotion_codes[], lighting_codes[], style_code}`。
无候选特征时自动 `degraded`：`score=null`、`needs_manual_review=true`，**不返回「通过」**。
`strict:true` 遇漂移抛 `CONSISTENCY_DRIFT`；生成链默认 `strict:false` 只标记不回滚。

`POST /api/generate` 新增可选字段 `reference` / `candidate`（不传则由编译输入自动构造参考特征），
返回体新增 `consistency`，生成记录落 `consistency{check_id,verdict,score,provider}`。

## V3.3 数据看板 / 收益 / 合规包

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/analytics/dashboard?projectId=&from=&to=&granularity=day\|week` | 实时看板：概览 / 按平台 / 按集 / 按日差分趋势 / 收益明细 |
| GET | `/api/analytics/settlements?projectId=` | 待结算账期、次月账单日、提现与开票提醒 |
| POST | `/api/analytics/stats` | 追加时序快照：`{distributionId, stats:{views,likes,comments,shares,completion_rate}, recordedAt?}` |
| POST | `/api/analytics/revenue` | 追加收益账期：`{distributionId, period, grossAmount, currency?, settlementStatus?}` |
| POST | `/api/analytics/revenue/calculate` | 收益估算：`{platformCode, dramaType(2d/3d/live_action/narration), views, completionRate, costPoints, exclusiveMultiplier}` |
| POST | `/api/analytics/settlement/:id` | 推进结算 / 开票状态 |
| GET | `/api/revenue-policies` | 8 平台政策库（系数 / 结算周期 / 更新日期 / 免责声明） |
| POST | `/api/compliance/pack` | 生成 AI 创作说明 + 7 页证据 HTML + manifest + credits，返回 `html` 与落盘路径 |
| GET | `/api/compliance/pack?projectId=&episodeNo=` | 读回合规包 |

旧接口 `POST /api/distribution/:id/stats`、`/api/distribution/:id/revenue` 返回结构不变，
内部改为 **append-only** 写入 `stat_snapshots` / `earnings`，`recordedAt` 会透传。

**收益估算公式**：`有效播放 = views × (0.4 + 0.6×完播率)`；
`估算分账 = 有效播放 ÷ 1000 × 基准单价 × 类型系数 × 独家倍率`；返回恒带 `estimate_only:true` 与免责声明。

## V3.4 阶段 H：PC 无限画布 / 上传助手 / 比对 provider / 静态托管

### 画布（DAG 是事实，布局只是渲染层）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/canvas/runs?projectId=` | 某项目下的运行列表（含 `has_layout`） |
| GET | `/api/canvas/:runId/graph` | 合并视图：DAG 节点 + 依赖边 + 布局坐标 + 视口 + 统计 + 总谱/质检摘要 |
| GET | `/api/canvas/:runId/layout` | 读取布局（未保存时返回自动布局，`persisted:false`） |
| PUT | `/api/canvas/:runId/layout` | 保存布局 `{layout:{nodes:{N01:{x,y}}, viewport:{x,y,zoom}, note?}}`；做不可篡改校验 |
| POST | `/api/canvas/:runId/layout/reset` | 重置为自动布局 |

布局红线：未知节点 → `CANVAS_UNKNOWN_NODE`；夹带 `status/name/gate/cost_credits/edges` → `CANVAS_DAG_IMMUTABLE`；
非法坐标 → `CANVAS_INVALID_COORD`；zoom 越界 → `CANVAS_INVALID_VIEWPORT`。

### 上传助手（只做预填与提醒，绝不自动投稿）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload/prepare` | `{distributionId}` → 预填字段 / 素材清单 / 平台入口 / 交付闸门 / `copy_text` |
| POST | `/api/upload/bundle` | `{distributionId}` → 导出 `lingwu.upload.bundle/1` 预填包并留证 |
| POST | `/api/upload/import` | `{bundle}` → 导入预填包；缺 `no_auto_submit=true` 拒绝 |
| POST | `/api/upload/mark` | `{distributionId, status, note?, openedAt?, prefill?}` → 回写状态（校验平台 status_flow） |
| GET | `/api/upload/submissions?distributionId=` | 回写历史（`submitted_by=user_manual`、`auto_submitted=false`） |
| GET | `/api/upload/bundles?distributionId=` | 导出记录 |

所有响应恒带 `no_auto_submit:true`、`policy.auto_submit:false`；非法状态 → `UPLOAD_STATUS_INVALID`。

### 比对 provider 配置 / 异步自检（P0-1 框架）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/qc/providers/config` | 比对服务配置状态（安全摘要，不含 token/完整 endpoint） |
| POST | `/api/qc/providers/configure` | 按 `QC_COMPARE_*` 环境变量装配并注册；未配置 endpoint 时不注册 |
| POST | `/api/qc/consistency/check-async` | 异步自检：先 `await compareAsync()`，再采信真实分数；无服务恒 `degraded` |

契约：`POST QC_COMPARE_ENDPOINT`，body `{reference,candidate,generated_url}`，响应 `{score:0~1, dimensions?}`，
可选 `Authorization: Bearer QC_COMPARE_TOKEN`。`extractScore()` 只认 0~1 的有限数字，字符串/越界一律拒绝。

### 本地静态托管

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/web/status` | web/ 文件清单与根目录存在性 |
| GET | `/`、`/index.html`、`/canvas.html`、`/upload-helper.html`、`/*.js`、`/*.css` | 静态托管（web/ 白名单，防目录穿越，no-store/nosniff） |

---

## V3.5 微信通道：登录 / 内容安全 / 虚拟支付

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | `wx.login(code)` 登录/注册（幂等），返回 `{token, user, mode}`。未配置 WX_APPID 时 mock 降级（同 code 同用户） |
| GET | `/api/auth/me` | 需 `Authorization: Bearer <token>`，返回当前用户与余额 |
| GET | `/api/wechat/status` | 微信三能力（登录/机审/支付）各自 mock/live 状态自检 |
| POST | `/api/security/check` | 文本机审自查 `{content, scene, bizType}`；违规返回 `pass:false` |
| GET | `/api/security/audit?bizType=&limit=` | 机审审计流水 |
| GET | `/api/pay/packages` | 点数包列表与 `pay_mode`（mock/live） |
| POST | `/api/pay/virtual/order` | 需登录。建充值单；live 模式返回 `wx.requestVirtualPayment` 签名参数，mock 模式返回联调说明 |
| GET | `/api/pay/virtual/orders` | 需登录。我的充值订单 |
| POST | `/api/pay/virtual/mock-success` | mock 联调发货（**已配置商户号后自动禁用**） |
| POST | `/api/pay/virtual/notify` | 微信发货回调：验签 → 订单置 paid → Ledger 幂等入账 |

机审拦截点（服务端自动执行，违规抛 `CONTENT_BLOCKED`）：`POST /api/projects`（标题+创意）、`POST /api/story/outline`、`POST /api/story/chain`。

**注意**：虚拟支付已配置（`WX_PAY_OFFER_ID`+`WX_PAY_APP_KEY`）后，运维通道 `POST /api/account/recharge` 自动关闭，充值只认验签回调。

---

## 运维（生产需鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/pool/health` | 算力池：并发、RPM、熔断、水位 |
| POST | `/api/pool/state` | 设置水位（`{balancePoints, capacityPoints}`） |
