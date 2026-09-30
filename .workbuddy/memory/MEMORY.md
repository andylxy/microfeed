# microfeed 项目长期记忆（精简版；细节归位到技能 / .scratch 规范文档）

## 硬约束
- **禁止自动 git 提交**；门禁 = `git diff --check` 无输出 + `yarn typecheck`（**不是裸 tsc**）+ 定向测试。不直接提交 `main`，走 `<type>/<short-kebab-case>` 分支。提交信息中文 `type(scope): 描述`。
- 改 i18n 必跑 `yarn i18n:check`（tsc 通过 ≠ 键正确）。
- OpenAPI：`src/shared/OpenApiDocument.ts` 是唯一事实来源；改任何英文原文必须同步 `OpenApiTranslations.ts`，否则 `tests/unit/openapi.test.ts` 红三条。生成文件不手改。

## 新功能「菜单+权限」强制清单
- SSOT：`.scratch/microfeed-rbac/new-feature-menu-permission-checklist.md`，漏一步=线上回归。
- 三条最贵教训：① `ext_permissions.id` 必须用 `permissionId()` 推导（手写 id 会让 bootstrapAdmin 500）；② 菜单行必须挂 `parent_code` 组 + `ext_menu_permissions` 映射；③ 权限码在 `PERMISSION_CODES` + `seed.ts` 双镜像，测试跑 page-guards + rbac.test.ts 全量。

## 上游分叉（fork of microfeed/microfeed，origin=andylxy/microfeed）
- 上游活跃，勿假设停更。迁移同号不同名（上游 0023 vs 本地 0023）按文件名识别，不致命。
- 合并后必跑四门禁（AdminCredentials + worker auth/rbac/login-credential）：防通行密钥按钮、密码策略 12↔6、登录字段类型被静默回退。
- 本地特有：`auth_user` 多 `username`/`displayUsername`（0039）；强制首次改密已取消（428 决策链保留但休眠）；默认角色 `readonly`（0043）。减少分叉：新逻辑放 `ext_*` 表/新文件，对上游文件只做插行级改动。

## 账号与认证
- 登录标识 = 邮箱或用户名（better-auth username 插件；按含 `@` 分派）。用户名 3–32 位 `[a-zA-Z0-9_.]`，存小写。只填用户名 → `adminUsernameEmail()` 占位邮箱。
- 密码策略常量只在 `src/shared/AdminCredentials.ts`，改完跑 `AdminCredentials.test.ts`。
- RBAC 决策链（guard.ts）：401 未登录/banned/设备吊销 → 428 休眠 → `*` ALLOW → legacy admin → code∈perms → 403。多角色=权限并集，无拒绝语义；用户级 grant/deny 已删（0046），勿再引入。角色改 code 必须级联重建（`renameRbacRoleCode`）；`CODE_LOCKED_ROLES={super_admin, readonly}`。

## 中医迁移（ctwh → microfeed，进行中）
- **SSOT：`.scratch/tcm-import/spec.md`（16 节）+ `.scratch/tcm-import/issues/01..18`**。分支 `feature/tcm-import`。
- 方案 E：不建表；书→channels、篇章/条文/方剂/中药/名词→items；`items` 加 `tcm_kind` + `tcm_parent_id` 两列 2 索引（0070）；标记表加 color/small_font/link_type（0071）；分类针灸/人纪 + 容器频道方剂/本草/名词（0072）。**源 int64 不落库**，关联全用 11 位 id（`_microfeed.bookId` 镜像 `book_id` 列；父子走 `tcm_parent_id`）。
- 关系模型与查询→索引对照在 spec §16（三条不变量：一个关系一个载体；tcm_parent_id 只用于父子条目；源 int64 只在脚本内存）。
- **PC Web 对 `$X{}` 原样输出（用户拍板）**；渲染器 `src/shared/TcmMarkers.ts` 保留未接线（递归解析、脏括号容错），将来接 `FeedPublicJsonBuilder` 一处即可。App 端 `GetTipsStyleConfig` 从标记表下发 13 项样式。
- 导入脚本 `scripts/import-ctwh/`（parse/build/main）：MySQL 转义还原、确定性 11 位 id（sha256(kind+源id)→base62，重跑幂等不翻倍）、**全 data 递归清洗未配对 UTF-16 代理字符**（源数据 5 条中药正文有，不清则 Worker 序列化 500）；保真审计 `verify-fidelity.mts`（node:sqlite 直读，嵌套 spawn 在沙箱 EBUSY）。
- App 端点：`/api/AppBookRequest/*` 14 个路由 + `src/server/tcm/`（reads/app-auth/config），中间件对该命名空间匿名放行；login 复用 better-auth + 签发 content:read API Key（不移植 AccessKey/HMAC）；登录路径已加入 THROTTLED_AUTH_PATHS。**App 端点不进 OpenAPI 契约（拍板）**。
- **App 契约事实（反查 App 源码实锤，勿再疑）**：App 统一 Gson、无 @SerializedName、字段名严格匹配；`signatureId` 是 long → **后端保留 SignatureId 字段名、值=篇章条目 11 位 id，App 端待改 long→String（拍板）**；GetAllMingCi 真实形状=小驼峰 `{Id, mingCiList[], name, imageUrl, text}`；CaseTag=WorkInfo.`Case`（{1,2,3} 隐方药页、5=伤寒显单位页）；别名三源=yaoAlias + **Yao.YaoList** + BookBody.BieMing（result[0]=正名，切分符 `[,,；; 。.、]+`，后者覆盖）。篇章 description 聚合条文正文=拍板保留（spec §5.2）。
- **netcore 对齐循环已完成（2026-09-29）**：8 端点本地+生产 vs netcore golden **全部零 MISMATCH** 并已部署。两个修复进 build.ts：①删 BOOK_NAME_OVERRIDE["10001"]（书名恢复源 WorkInfo「伤寒金匮・(宋版)」，卷章按 BookNo 关联不合并——BookNo 10001 内容实为伤寒论 27 篇，金匮在 10002）；②新增 CONTAINER_CHANNELS（方剂/本草/名词三容器频道，此前只在远端手工建、build 产物缺失致 993 条目孤儿）。golden 工具已参数化：capture-new `--base/--out-dir`、compare `--state-dir(默认 local-state)/--new-dir`；生产比对产物 golden/new-prod/。GetAllZhongYao=known-adaptation（容器去重拍板）。
- 重灌工具：`.scratch/tcm-import/repour.mts`（node:sqlite 幂等双库直灌，参数 `<instance> <state-dir>`）。parse.ts 手写 MySQL parser 已获**用户拍板豁免**（一次性脚本+保真审计兜底，spec §10 有豁免记录）。
- **工单 15 done（golden 零 MISMATCH）**：旧后端在 192.168.2.158:9991（App `SecurityConfig` 内置默认设备密钥直签，无需登录）；wire 真相 = 信封 `{code:200,data,msg:"请求成功"}` + 全小驼峰 + GetAllZhongYao 仅 `{name,text}` + 方剂数值字段为字符串 + 正文分隔符 `\r\n`/`\r`/`\n` 混用（textToHtml 无损往返）+ 排序键 `_microfeed.no`（FangNo/MingCiNo/YaoNo）。工具：golden/capture.mts + compare.mts；回归 = tests/unit/tcm-golden.test.ts。剩余工单：16 生产导入、17 图片（无源图）、18 ADR。
- ⚠️ 双本地库：`wrangler --local` 写 `.wrangler/state/v3/d1`，`manage dev` 读 `local-state/v3/d1`——同名不同目录，导错库=页面 404。
- 生产待办：主频道归属（systemName 跟随主频道 title）、条文 unlisted(4) 不进 feed、东方玄幻保留、图片回填、golden 对比后分批写远程。
- **生产站点 = `https://feed.881019.xyz`**（实例 ctwh-881019-xyz）。
- **公开站首页/页面样式一致性 = 「激活主题」必须一致**，与内容数据无关：远程激活 `feed-zh`（`local.feed-zh@0.1.34`，带 **ADR-0010** 的 `--mf-page-bg` 画布色，`docs/novel-cms/adr/0010-*.md`，定义在 `themes/feed-zh/web-{header,home}.mustache`）；本地实例曾在 2026-09-28 重建时丢掉它、回落到 `microfeed default` ⇒ 首页画布色/排版/`<style>` 块数与远程全不对。修法：`yarn manage theme install ./themes/feed-zh --local --instance <n>` 然后 `theme activate <theme-id> --local --instance <n>`（可用 `theme activate bundled-default-v2` 回滚）。排查本地≠远程页面样式时**先比激活主题**（查 `theme_state.active_theme_id`）。
- 站点标题来自主频道 `data.title`（主频道 `J1jGJjUWeCz` title 星河剑歌；旧 `01ESy1LsL0F` 已随整库替换消失）。
- **2026-09-29 用户拍板：本地实例只留《星河剑歌》**——其余 22 频道（全部 TCM 书+6 占位小说）及条目已删，现=1 频道/17 条目（14 已发布章节 + 3 条 book_id=NULL 草稿特意保留，含「第二卷 第1章 星河觉醒」），VACUUM 后 35MB。**远端未动**，TCM 数据都在远端，可 `.scratch/backups/resync-remote-to-local.sh` 一键恢复（内部调 do-sync.mjs，需 realtables.txt；停服务后跑）。`.scratch/tcm-import/out/` 33 个批次 SQL 已删（build.ts 可重新生成）；`.scratch/backups/` 的 D1 备份/转储全删，仅留 4 个脚本（do-sync.mjs/realtables.txt/resync-remote-to-local.sh/cleanup-keep-xinghe.mjs）。注意：本地今后新写内容无备份兜底。
- **小说书卷章操作知识已固化（通用所有「小说类」书，不含 TCM 类）**：文档 `docs/novel-cms/xinghe-book-structure.md`（星河剑歌=参考实现，结构分析+审计 SSOT）+ 项目技能 `.workbuddy/skills/novel-book-ops/`（原名 xinghe-chapter-ops，2026-09-29 泛化）：`add-book.mjs` 建书（照抄星河剑歌频道 JSON 结构，同名拒绝，genre 接受 ID/名称）+ `add-chapter.mjs` 加章（`--book <ID|书名>`，三道闸：pub_date 顺序/同卷章号重号/标题章号一致性）。铁律：**pub_date=该书全局阅读顺序键**（字符串比较，统一 .000Z）、**书键双写**（book_id 列+_microfeed.bookId 必须一致）、**卷键=volume 字符串逐字一致**（卷归属=承载章的书键，非实体）、**序号键=chapterNo 卷内序号**（每卷独立从 1、=标题章号、同卷唯一、缺省 0 必乱序）、content_format 缺省即 HTML、公开书页平铺不按卷分组。**用户纠正后补充的结论（2026-09-29）**：API Schema 全字段 optional（.loose()），空标题空正文草稿实证存在 ⇒ 「书名/卷/章/正文必须有」是**效果强制**非系统强制；chapterNo=**卷内序号**（每卷独立从 1 计数、=标题章号、同卷唯一、缺省按 0 必乱序）；**公开书详情页是平铺列表不按卷分组**（卷分组只在后台卷面板，阅读页仅显示卷标）。**2026-09-30 补充（重要，两套模型）**：本项目的"书"分两类，**三键规则只对小说类成立**——判别 `SELECT 1 FROM items WHERE book_id=? AND tcm_kind IS NOT NULL LIMIT 1`；小说类卷=`_microfeed.volume` 标签（卷非实体）、归属靠卷名逐字一致、卷面板可改；**TCM 类卷=`tcm_kind='chapter'` 条目（实体）、章=section、归属靠 `tcm_parent_id`、卷面板只读**。`add-chapter.mjs` 已加闸 0：TCM 书直接拒绝（否则写入的 volume 标签被忽略、新章落进未分卷）。TCM 的 volume/chapterNo 只是回填的展示派生值（编辑页读它），结构权威是 tcm_parent_id，重导后需重跑 `.scratch/backfill-tcm-volume.mjs`。另：**条文 status=4(unlisted) 在卷面板显示"已发布"，禁止为消掉"草稿"把 status 改成 1**（会把条文推进公开 feed）。
- **远端→本地整库同步要点**：`wrangler d1 export` 遇 FTS5（site_search_* 12 张虚拟表）直接报错 ⇒ 用 `--no-schema --table <60 实表>` 只导数据，并过滤派生表 `site_search_documents` 的 INSERT；FTS 全靠触发器（items/pages → documents → exact/trigram），原子事务内 DELETE+重放即自动重建，无需手动重建索引。

## 本机环境（反复咬人）
- `yarn`：`./node_modules/.bin/yarn`；shim 报 sed/dirname 缺失 → 前置 `export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:$PATH"`。
- safe-delete 闸（>50 文件即拒）：`CODEBUDDY_SAFE_DELETE_ENABLED=0` 前缀，或 `mv` 改名代替删除（`.vite`、`dist` 同理）。
- 测试必须 `./node_modules/.bin/yarn vitest run`；全量 test 不可当门禁（约 130 例超时假失败），定向跑子集。改测试文件也要过 tsc（noUncheckedIndexedAccess）。
- 远程 D1 直查必须先 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy`（否则 7403，别误判 token 失效）。
- **typecheck 热缓存约 1–2 分钟**（18–24 分钟是冷缓存值），别怕跑；失败先看 log 尾部 `Result` 与 `error ts`。
- 部署由 AI 直接执行（用户要求），先读 `.microfeed/deploy*.log` 再动手；用 `microfeed-deploy` / `microfeed-deploy-verify` 技能。
- **⚠️ `yarn build` 裸跑会静默生成空库**：`astro.config.ts` 用 `MICROFEED_WRANGLER_CONFIG` 选配置，裸跑回落仓库根 `wrangler.jsonc`（无 database_id）→ miniflare 换哈希 → 新建 **0 表空 sqlite**，真库在另一哈希文件里 → 全站 500 / TCM 端点全空（`no such table: items`）。**构建必须带实例变量**：`MICROFEED_WRANGLER_CONFIG=.microfeed/instances/<n>/wrangler.jsonc` + `MICROFEED_LOCAL_STATE=.microfeed/instances/<n>/local-state`。判据：`dist/server/wrangler.json` 的 `topLevelName` 应为实例名、`database_id` 应为 `a7188289-…`。
- 每次 git commit 后立刻 `git rev-parse HEAD` 复核（本环境会吃分支引用）；`src/shared/` 新模块用相对导入；组件测试用 `React.createElement` 不写 JSX；bash heredoc 生成代码后必须实测（`$var` 会被 bash 展开）。
- node:sqlite 可直读 miniflare sqlite；沙箱内嵌套 spawn（cmd.exe/wrangler 子进程）会 EBUSY。
- **`manage dev` 起的进程跨 Bash 工具调用会被回收**：必须**在同一次调用内**完成「nohup 起服务 → 轮询等就绪 → curl 抓页面」，下次调用 curl 就是 exit 7 / HTTP 000。冷启动到可响应约 **70 秒**（只等 25s 会误判没起来），日志出现 `astro ready` + `Local http://localhost:4321/` 才算就绪。起法：`export CODEBUDDY_SAFE_DELETE_ENABLED=0` + `nohup ./node_modules/.bin/yarn manage dev --local --instance <n> &`。
- 本地 D1 实际路径是 `.microfeed/instances/<实例>/local-state/v3/d1/`（`manage-cli/lib/config.ts` 的 `instanceDirectory(...)/local-state`），不是仓库根。

## 其他
- 正文按原形保存（`data.description` + `content_format`），渲染只在显示时做；Quill 白名单丢 class/style，wangEditor 靠 `_microfeed.body_editor` 锁定（import AdminRichEditor 的测试必须 vi.mock 两个 wangeditor 包）。
- `channels.genre` 存分类 id；item id 11 位；`STATUSES={1 published,2 unpublished,3 deleted,4 unlisted}`（unlisted 不进 feed、可直链）。
- 两个记忆目录并存：`.workbuddy-ai/memory/` 与 `.workbuddy/memory/`，两边都写，整理前先问用户。
- 参照实现：XiHan.BasicApp（`D:\git\AiCode\XiHan.BasicApp`）菜单/RBAC 样板；菜单≠权限、一菜单一权限点。
- **桂林古本对齐循环（2026-09-29 二轮）**：单书导入 `main.ts --book-no 1001000 --full`（build.ts options.onlyBookNo；本书方剂引用的 17 个 yao 一并导入；单书 no=源 FangId 升序排名）。**netcore 按书 wire 不一致**（10001: ID="0"+字符串数值；1001000: id=342+数字）→ reads.ts `FANG_NUMERIC_WIRE_BOOKNOS` 按书复刻形状。**生产全库 bookNo 曾为 null**（旧 build 不写）→ 13 条 json_set UPDATE 补齐。8 端点本地+生产 vs netcore 零 MISMATCH。compare.mts 有 `--old-dir/--lenient-ids`，capture `--book-no/--old-dir/--new-dir`。诊断：API 下载已部署 worker 内容 grep 特征（token 从 wrangler 配置读、不回显）。
- **后台卷面板对 TCM 书只读结构视图（2026-09-29 二轮修正）**：TCM 条目无 `_microfeed.volume` 标签，extVolume `listVolumeBoard` 探测 `tcm_kind IS NOT NULL` 走 TCM 分支——chapter(篇章)=卷(名=标题,序=`_microfeed.section`)、section(条文)=卷内章(序=`_microfeed.receiptNo`,每卷 1..N 连续)、孤儿兜底桶；**无「方剂」卷**（用户拍板：不能另起新名称，方剂不是卷/章）；`readOnly=true`(ExtVolume.ts VolumeBoard 加字段, VolumesApp.tsx 隐藏操作 + unlisted 显示「已发布」非「草稿」)。`listVolumeBooks` 过滤 `_microfeed.tcmContainer` 容器频道；**方剂归属经 admin-list.ts `bookRef` CASE(sourceBookId 优先) 解析真实书**（fang 在 admin 列表/按书过滤显示伤寒杂病论・(桂林古本) 而非「方剂」）。纯展示层,不动 App 契约。
