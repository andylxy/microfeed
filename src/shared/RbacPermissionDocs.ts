/**
 * 权限码的说明目录：功能、守的接口、注意事项。
 *
 * 这份内容**逐条对照代码引用点写成**，不是凭权限名推测：
 *   - 「守的接口」来自 `grep PERMISSION_CODES.<X>` 命中的页面守卫
 *     （`requirePagePermission`）与处理器守卫（`requireRbac` / `withRbacGuard`），
 *     以及 `src/server/api/api-permissions.ts` 的 `DOMAIN_RULES`；
 *   - 路由省略后台前缀（默认 `admin`），`/books` 即 `/<adminPath>/books`；
 *   - 代码里没有引用点的码，`gates` 如实写「代码中暂无守卫引用」，不编造端点。
 *
 * 权限码是代码常量（ADR-0038 D4），所以说明也放在代码侧、与常量同源；
 * 目录新增码时这里必须同步补一条，`tests/unit/shared/rbac-permission-docs.test.ts`
 * 会把「目录有码、说明缺失」钉成失败。
 */

export interface RbacPermissionDoc {
  /** 这个码授予什么能力，以及缺了它会怎样。 */
  summary: string;
  /** 它实际守的页面 / 接口（来自代码引用点），每条带方法与用途。 */
  gates: readonly string[];
  /** 注意事项：默认授权、与相邻码的关系、无引用、只读版等。 */
  caveats?: readonly string[];
}

/**
 * 按权限码索引的说明。键必须是 `RBAC_PERMISSIONS` 里的 `code` 或通配 `*`。
 */
export const RBAC_PERMISSION_DOCS: Readonly<Record<string, RbacPermissionDoc>> = {
  // ── content · 书 ─────────────────────────────────────────────
  "content:book:create": {
    summary:
      "新建书。书是内容的顶层容器，新建之后才能在它下面挂分类、卷和章节。没有这个码，书列表页的「新建」动作会被拒（403）。",
    gates: ["接口 /ajax/books（POST）— 新建一本书"],
    caveats: [
      "默认授予 editor / readonly（新账号的默认角色）。",
      "与 content:book:read 分开授权：能建书不等于能打开书列表。",
    ],
  },
  "content:book:read": {
    summary:
      "查看书列表与单本书详情。书列表页、书的详情读取都靠它；没有这个码，书列表页会 403，集成 API 的 content/books 也会拒绝读取。",
    gates: [
      "页面 /books — 书列表，进入即校验",
      "接口 /ajax/books（GET）— 书列表查询",
      "集成 API content/books（GET）— 只读；写方法返回 405",
    ],
    caveats: [
      "默认授予 editor / readonly。",
      "与 content:book:update / create / delete 分开：只有查看权时能进列表，不能改、不能删。",
    ],
  },
  "content:book:update": {
    summary:
      "编辑书。改书名、简介、状态等属性都走这个码；它只动书的元数据，不动书下的章节正文。",
    gates: ["接口 /ajax/books/{bookId}（PUT）— 更新单本书"],
    caveats: [
      "默认授予 editor / readonly。",
      "通常要先有 content:book:read，才能在列表里定位到要编辑的书。",
    ],
  },
  "content:book:delete": {
    summary:
      "删除书。删除不可逆，会连带影响书下的内容，因此默认不授予 editor，只给超管或显式授权者。",
    gates: ["接口 /ajax/books/{bookId}（DELETE）— 删除单本书"],
    caveats: [
      "不默认授予 editor。",
      "删除前建议确认书下没有仍需保留的章节；误删后只能从备份恢复。",
    ],
  },

  // ── content · 分类 ───────────────────────────────────────────
  "content:category:create": {
    summary:
      "新建分类。分类是书的归类维度，新建后还需要 content:category:order 才能调整它在导航里的顺序。",
    gates: ["接口 /ajax/categories（POST）— 新建分类"],
    caveats: ["不默认授予 editor。", "与 content:category:order 分开：能建不等于能排序。"],
  },
  "content:category:read": {
    summary:
      "查看分类列表与单个分类详情。分类页、表单里的分类下拉、集成 API 的分类读取都靠它；没有它，分类页打不开。",
    gates: [
      "页面 /categories — 分类列表",
      "接口 /ajax/categories（GET）— 分类列表",
      "接口 /ajax/categories/{categoryId}（GET）— 单个分类详情",
      "集成 API content/categories（GET）— 只读",
    ],
    caveats: ["默认授予 editor / readonly。"],
  },
  "content:category:update": {
    summary: "编辑分类。改分类名、描述等属性。",
    gates: ["接口 /ajax/categories/{categoryId}（PUT）— 更新单个分类"],
    caveats: ["默认授予 editor / readonly。", "改排序不在这里，归 content:category:order。"],
  },
  "content:category:delete": {
    summary: "删除分类。删除前要确认分类下没有仍要保留的书。",
    gates: ["接口 /ajax/categories/{categoryId}（DELETE）— 删除单个分类"],
    caveats: ["不默认授予 editor。"],
  },
  "content:category:order": {
    summary: "调整分类排序。排序结果会影响前台分类导航的展示顺序。",
    gates: ["接口 /ajax/categories/order（PUT）— 批量保存分类顺序"],
    caveats: ["不默认授予 editor。", "排序是独立权限：能编辑分类不代表能改顺序。"],
  },

  // ── content · 卷 ─────────────────────────────────────────────
  "content:volume:read": {
    summary:
      "查看卷结构。一本书下的卷列表、每卷包含哪些条目，都靠这个码读取；没有它，卷页面打不开。",
    gates: [
      "页面 /volumes — 卷结构",
      "接口 /ajax/volumes（GET）— 卷列表",
      "接口 /ajax/volumes/entries — 卷内条目",
    ],
    caveats: ["默认授予 editor / readonly。"],
  },
  "content:volume:update": {
    summary:
      "编辑卷结构：把条目分配到卷、调整卷顺序、重命名卷、重排卷内条目。它只动归属与顺序，不改章节正文。",
    gates: [
      "接口 /ajax/volumes/assign — 把条目分配到卷",
      "接口 /ajax/volumes/order — 调整卷的先后顺序",
      "接口 /ajax/volumes/rename — 重命名卷",
      "接口 /ajax/volumes/reorder — 重排卷内条目",
    ],
    caveats: [
      "默认授予 editor / readonly。",
      "章节正文的增删改归 content:chapter:*，与卷结构分开。",
    ],
  },

  // ── content · 章节（条目） ───────────────────────────────────
  "content:chapter:create": {
    summary:
      "新建章节（条目）。章节是实际内容单元，新建后才会出现在条目列表和卷结构里。",
    gates: [
      "接口 /ajax/feed（创建分支）— 新建章节",
      "集成 API items（POST）— 新建条目",
    ],
    caveats: [
      "默认授予 editor / readonly。",
      "章节写入集中在 /ajax/feed，按动作分派 create / update / delete 三个码。",
    ],
  },
  "content:chapter:read": {
    summary:
      "查看章节列表与条目详情。条目页、条目列表、搜索、审核页的读取都复用它；没有它，条目相关页会 403。",
    gates: [
      "页面 /items、/items/list、/items/new、/items/{itemId} — 条目相关页",
      "接口 /ajax/feed（GET）— 读取章节",
      "接口 /ajax/items（GET）— 条目摘要列表",
      "集成 API content/chapters、items（GET）、feed、search — 只读",
    ],
    caveats: [
      "默认授予 editor / readonly。",
      "它被多个页面复用：条目页、审核页、搜索都靠它读数据。",
    ],
  },
  "content:chapter:update": {
    summary:
      "编辑章节（条目正文与属性）。审核页的撤销/恢复动作也走这个码，因此它同时覆盖内容编辑与审计回滚。",
    gates: [
      "接口 /ajax/feed（更新分支）— 更新章节",
      "接口 /ajax/r2-ops — 章节相关的 R2 文件操作",
      "接口 /ajax/audit/{itemId} — 撤销/恢复动作另需本码",
      "集成 API items（PUT / PATCH）— 更新条目",
    ],
    caveats: [
      "默认授予 editor / readonly。",
      "审核页的撤销动作没有单独的写码，直接复用本码。",
    ],
  },
  "content:chapter:delete": {
    summary: "删除章节（条目）。删除不可逆，因此默认不授予 editor。",
    gates: [
      "接口 /ajax/feed（删除分支）— 删除章节",
      "集成 API items（DELETE）— 删除条目",
    ],
    caveats: [
      "不默认授予 editor。",
      "删除前可先用 content:audit:read 查历史，确认不是误操作。",
    ],
  },

  // ── system · 账号与角色 ──────────────────────────────────────
  "system:user:manage": {
    summary:
      "后台用户管理：创建账号、改密码、启用/停用、重置、删除等。它只管账号本身，不管账号被授了哪些角色。",
    gates: [
      "页面 /users — 用户列表",
      "用户端点 /ajax/rbac/* — 用户 CRUD、改密、启停、重置",
    ],
    caveats: [
      "只授 super_admin（走通配 *），不默认授予 editor。",
      "与 system:role:manage 分开：能管用户不代表能改角色授权。",
    ],
  },
  "system:role:manage": {
    summary:
      "角色与授权管理：角色的增删改、权限树勾选、角色 code 调整。它决定「谁拥有哪些权限」，是权限体系的根。",
    gates: [
      "页面 /rbac — 权限管理页",
      "页面 /rbac/audit — RBAC 审计页",
      "角色端点 /ajax/rbac/* — 角色 CRUD、授权读写",
    ],
    caveats: [
      "只授 super_admin（走通配 *）。",
      "角色 code 改动需同步重命名（renameRbacRoleCode），不能只改显示名。",
    ],
  },

  // ── system · 站点设置与集成 ──────────────────────────────────
  "content:settings:manage": {
    summary:
      "站点设置管理：站点配置、主题安装/激活、代码编辑器。它属于站点级能力，默认不给 editor。",
    gates: [
      "页面 /settings、/settings/themes、/settings/themes/drafts/{draftId}、/settings/code-editor",
      "接口 /ajax/themes/* — 主题安装、激活、草稿读写",
      "接口 /ajax/cloud-usage/token — 用量看板的临时凭证",
    ],
    caveats: [
      "站点级能力，不默认授予 editor。",
      "主题写库走绑定参数：D1 单条语句约 100KB 上限，大主题分块写入。",
    ],
  },
  "system:webhook:manage": {
    summary: "Webhook 管理：事件订阅、端点配置、投递记录。读写共用这一个码。",
    gates: [
      "页面 /webhooks、/webhooks/events、/webhooks/endpoints、/webhooks/deliveries",
      "Webhook 接口（webhook-handlers 内部守卫）",
    ],
    caveats: ["不默认授予 editor。", "事件、端点、投递记录三块都由它统一把关。"],
  },
  "system:api:manage": {
    summary:
      "后台 API 区管理：接口清单、API 设置、API Key、认证配置。它只决定能否进入 API 区；具体接口能读写什么仍由 content:*:* 决定。",
    gates: [
      "页面 /api、/api/settings、/api/explorer、/api/auth",
      "接口 /ajax/api/settings — API 设置",
      "接口 /ajax/api/keys、/ajax/api/keys/{apiKeyId}、/ajax/api/keys/{apiKeyId}/rotate — API Key 管理与轮换",
    ],
    caveats: [
      "不默认授予 editor。",
      "它是 API 区的入口码；接口级读写仍由各域的 content:*:* 决定（ADR-0009）。",
    ],
  },

  // ── content · 频道 / 审核 / 审计 ─────────────────────────────
  "content:channel:manage": {
    summary: "主频道设置管理。整域一个码，读与写共用。",
    gates: [
      "页面 /channels/primary — 主频道设置",
      "集成 API channels（整域一个码，读写同一码）",
    ],
    caveats: ["不默认授予 editor。"],
  },
  "content:review:manage": {
    summary:
      "审核管理：待审条目、纠错单。审核通过/驳回、纠错单处理都是写操作，统一走这个码。",
    gates: [
      "页面 /review、/review/{itemId} — 审核列表与详情",
      "接口 /ajax/review、/ajax/review/{itemId} — 审核动作",
      "接口 /ajax/review/corrections、/ajax/review/corrections/{correctionId} — 纠错单",
    ],
    caveats: ["不默认授予 editor。", "审核动作没有单独的写码，统一归本码。"],
  },
  "content:audit:read": {
    summary:
      "查看审计记录与条目历史。它只授予读能力；审计页上的撤销/恢复动作另需 content:chapter:update。",
    gates: [
      "页面 /audit、/audit/{itemId} — 审计列表与条目历史",
      "接口 /ajax/audit、/ajax/audit/{itemId}（GET）— 读取审计数据",
    ],
    caveats: [
      "只读；撤销/恢复动作另需 content:chapter:update。",
      "审计读不授予任何写能力，可以放心授给只做巡检的账号。",
    ],
  },

  // ── content · 页面 / 站点文件 / 媒体 ─────────────────────────
  "content:page:manage": {
    summary:
      "自定义页面管理：新建、编辑、排序、清理。页面导航的排序也归这个码。",
    gates: [
      "页面 /pages、/pages/new、/pages/{pageId}",
      "接口 /ajax/pages、/ajax/pages/order、/ajax/pages/{pageId}、/ajax/pages/{pageId}/purge",
      "集成 API pages（整域一个码）",
    ],
    caveats: ["默认授予 editor / readonly。", "页面导航排序也在本码内，不另设排序码。"],
  },
  "content:site_file:manage": {
    summary: "站点文件管理：新建、编辑、发布、重置、预览。",
    gates: [
      "页面 /site-files、/site-files/new、/site-files/{siteFileId}",
      "接口 /ajax/site-files、/ajax/site-files/{siteFileId}、/ajax/site-files/{siteFileId}/publish、/ajax/site-files/{siteFileId}/reset、/ajax/site-files/preview",
      "集成 API site-files（整域一个码）",
    ],
    caveats: ["默认授予 editor / readonly。"],
  },
  "media:file:manage": {
    summary:
      "媒体文件管理。后台没有独立页面，这个码只在登录凭证调用集成 API 的 media_files 域时校验。",
    gates: ["集成 API media_files（读/写同一码）"],
    caveats: [
      "后台没有独立页面；只在集成 API 调用时生效。",
      "上传、读取、删除媒体都走这一个码。",
    ],
  },

  // ── App 内容端点（migration 0131 按域细分） ──────────────────
  "app:nav:read": {
    summary: "App 导航数据读取。App 启动时拉取导航/分类结构。",
    gates: ["AppBookRequest/GetNav/"],
    caveats: ["App 能力码：不进侧栏，不默认授予，由运营手工挂到角色。"],
  },
  "app:style:read": {
    summary: "App 提示样式配置读取。后台改标注标记后，App 下次启动取到新配置。",
    gates: ["AppBookRequest/GetTipsStyleConfig/"],
    caveats: ["App 能力码：不进侧栏，不默认授予。"],
  },
  "app:chapter:read": {
    summary: "App 章节目录读取。App 打开一本书时用它拉目录。",
    gates: ["AppBookRequest/GetBookChapter/"],
    caveats: ["App 能力码：不进侧栏，不默认授予。"],
  },
  "app:content:read": {
    summary: "App 章节内容读取。App 打开某一章时用它拉正文。",
    gates: ["AppBookRequest/GetChapterContent/"],
    caveats: ["App 能力码：不进侧栏，不默认授予。"],
  },
  "app:fang:read": {
    summary: "App 中药方剂读取。",
    gates: ["AppBookRequest/GetBookIdFang/"],
    caveats: ["App 能力码：不进侧栏，不默认授予。"],
  },
  "app:zhongyao:read": {
    summary: "App 中药数据读取（含别名）。一个码覆盖中药主表与别名两个端点。",
    gates: ["AppBookRequest/GetAllZhongYao/", "AppBookRequest/GetAliaZhongYao/"],
    caveats: ["App 能力码：不进侧栏，不默认授予。"],
  },

  // ── content · 标注标记 ──────────────────────────────────────
  "content:annotation-markers:read": {
    summary:
      "读取标注标记清单。富文本编辑器用它拼工具栏按钮；没有它，编辑器里看不到可用的标记。",
    gates: ["接口 /ajax/annotation-markers/list（GET）— 标记清单"],
    caveats: ["默认授予 editor / readonly。"],
  },
  "content:annotation-markers:manage": {
    summary:
      "维护标注标记（新增、改名、删除）。改动会影响 App 的提示样式（GetTipsStyleConfig）。",
    gates: [
      "页面 /annotation-markers",
      "接口 /ajax/annotation-markers/create、/update、/delete",
    ],
    caveats: ["不默认授予 editor。", "改标记后 App 下次启动才取到新配置。"],
  },

  // ── content · 方剂 / 别名 / 中药 / 名词 ─────────────────────
  "content:fang:read": {
    summary:
      "查看方剂。方剂板只读，行内编辑会跳到条目页，条目编辑受章节码控制。",
    gates: ["页面 /fangs", "接口 /ajax/fangs（GET）— 方剂列表"],
    caveats: ["默认授予 editor / readonly。", "方剂板的写操作不在本码，走条目页的章节码。"],
  },
  "content:alias:read": {
    summary: "查看别名。",
    gates: ["页面 /aliases", "接口 /ajax/aliases（GET）— 别名列表"],
    caveats: ["默认授予 editor / readonly。"],
  },
  "content:alias:manage": {
    summary: "维护别名（新增、改名、删除）。",
    gates: ["页面 /aliases（维护入口）", "接口 /ajax/aliases 的写方法"],
    caveats: ["默认授予 editor / readonly。", "别名与中药/名词共用条目模型。"],
  },
  "content:yao:read": {
    summary: "查看中药。",
    gates: ["页面 /yao", "接口 /ajax/yao（GET）— 中药列表", "中药条目接口的读分支"],
    caveats: ["默认授予 editor / readonly。"],
  },
  "content:yao:manage": {
    summary: "维护中药（新增、改名、发布、软删、恢复）。完整正文仍在条目编辑器里改。",
    gates: ["页面 /yao（维护入口）", "中药条目接口的写分支"],
    caveats: ["默认授予 editor / readonly。"],
  },
  "content:term:read": {
    summary: "查看名词。",
    gates: ["页面 /term", "接口 /ajax/term（GET）— 名词列表", "名词条目接口的读分支"],
    caveats: ["默认授予 editor / readonly。"],
  },
  "content:term:manage": {
    summary: "维护名词（新增、改名、发布、软删、恢复）。",
    gates: ["页面 /term（维护入口）", "名词条目接口的写分支"],
    caveats: ["默认授予 editor / readonly。"],
  },

  // ── system · 设备 / 版本 / 日志 / 公告 ──────────────────────
  "system:device:read": {
    summary: "查看 App 设备列表。",
    gates: ["页面 /devices", "接口 /ajax/devices（GET）— 设备列表"],
    caveats: ["不默认授予 editor。"],
  },
  "system:device:manage": {
    summary: "设备管理：吊销、恢复。与 device:read 分开，能看列表不代表能吊销。",
    gates: ["页面 /devices（管理入口）", "设备接口（device-handlers）"],
    caveats: ["不默认授予 editor。", "吊销会立即让设备失去访问能力，操作前请确认。"],
  },
  "system:app-version:read": {
    summary: "查看 App 版本。",
    gates: [
      "页面 /app-versions",
      "接口 /ajax/app-versions（GET）— 版本列表",
      "接口 /ajax/app-versions/apks（GET）— APK 列表",
    ],
    caveats: ["不默认授予 editor。"],
  },
  "system:app-version:manage": {
    summary: "App 版本管理：保存版本、上传 APK。",
    gates: [
      "页面 /app-versions（管理入口）",
      "接口 /ajax/app-versions/save — 保存版本",
      "接口 /ajax/app-versions/apks（POST）— 上传 APK",
    ],
    caveats: ["不默认授予 editor。"],
  },
  "system:login-log:read": {
    summary: "查看 App 登录日志。",
    gates: ["页面 /login-logs", "接口 /ajax/login-logs（GET）— 日志列表"],
    caveats: ["不默认授予 editor。"],
  },
  "system:login-log:manage": {
    summary: "登录日志管理（预留码）。",
    gates: ["代码中暂无守卫引用"],
    caveats: [
      "目录已播种，但当前没有页面或端点使用它。",
      "不要据此以为能控制写入；日志端点目前只校验 :read。",
    ],
  },
  "system:announcement:read": {
    summary: "查看 App 公告。",
    gates: ["页面 /announcements", "接口 /ajax/announcements（GET）— 公告列表"],
    caveats: ["不默认授予 editor。"],
  },
  "system:announcement:manage": {
    summary: "App 公告管理：新建、编辑、发布。",
    gates: ["页面 /announcements（管理入口）", "接口 /ajax/announcements/save — 保存公告"],
    caveats: ["不默认授予 editor。"],
  },

  // ── App 能力 · 搜索 / 名词 / 版本 / 公告 ────────────────────
  "app:search:global": {
    summary:
      "App 首页全局搜索。与 app:search:book 构成双码门：持任一即可访问搜索权限端点。",
    gates: ["GET /api/app/search-permission（与 book 构成双码门）"],
    caveats: [
      "不默认授予；运营在权限树把码挂到角色叶子才开放。",
      "端点内部按角色分别回答 global / book 两个搜索码的持有情况。",
    ],
  },
  "app:search:book": {
    summary:
      "App 书内搜索。与 app:search:global 构成双码门；只给 book 就只开书内搜索。",
    gates: ["GET /api/app/search-permission（与 global 构成双码门）"],
    caveats: ["不默认授予。", "与 global 分开授权，可以只开放书内搜索。"],
  },
  "app:mingci:view": {
    summary:
      "App 名词解释查看。无此码时名词列表不加载；数据端点与查看权同权。",
    gates: ["GET /api/app/mingci-permission", "AppBookRequest/GetAllMingCi/"],
    caveats: ["不默认授予。", "数据端点与查看权共用同一个码，不另设数据码。"],
  },
  "app:version:read": {
    summary:
      "App 版本升级检查。默认授予 editor / readonly：App 每次启动都要查升级，缺了它刚装好的 App 查不到更新。",
    gates: ["GET /api/app/version"],
    caveats: ["默认授予 editor / readonly。", "端点内部会用同一个码再复核一次（防御纵深）。"],
  },
  "app:announcement:read": {
    summary:
      "App 运营公告通道。默认授予 editor / readonly：缺了它 App 收不到公告。",
    gates: ["GET /api/app/announcements"],
    caveats: ["默认授予 editor / readonly。", "与 version 同构：门即权限码本身。"],
  },

  // ── system · 运维看板 / 菜单 / App 能力 ─────────────────────
  "system:cloud-usage:read": {
    summary:
      "Cloudflare 用量查看（D1 / R2 / Workers）。只读运维看板，一个码覆盖三个分区。",
    gates: [
      "后台首页的用量卡片",
      "页面 /cloud-usage",
      "接口 /ajax/cloud-usage（GET）— 用量数据",
    ],
    caveats: ["只授 super_admin（走通配 *），不默认授予 editor。"],
  },
  "system:menu:manage": {
    summary: "菜单管理（只读一版）。菜单结构已并入权限树，本页只保留对照视图。",
    gates: ["页面 /menu", "接口 /ajax/menu/*（写入当前一律 409）"],
    caveats: [
      "ADR-0042 只读一版：下一版整页下线，本码一并退役。",
      "写入已关闭；改菜单请到权限管理页改节点。",
    ],
  },
  "system:app-capability:manage": {
    summary:
      "App 能力管理（权限管理页 App 端分区的可见性）。它决定账号能否看到 App 板，不决定移动端业务码的授权。",
    gates: [
      "页面 /rbac 的 App 板可见性（isAppBoardVisible）",
      "App 能力接口的守卫",
    ],
    caveats: [
      "只授 super_admin（走通配 *）。",
      "与 app:* 业务码分开：后者是移动端运行时用的，不决定 App 板是否可见。",
    ],
  },

  // ── 通配 ────────────────────────────────────────────────────
  "*": {
    summary: "超级管理员：持有即通过所有权限检查（通配）。",
    gates: ["所有页面与接口（rbacAllows / requirePagePermission 遇 * 直接放行）"],
    caveats: [
      "super_admin 角色默认持有；只应授予超管。",
      "不要把它当普通权限码挂给业务角色。",
    ],
  },
};

/** 取某个权限码的说明；未登记的码返回 `null`（渲染端据此显示「暂无说明」）。 */
export function permissionDoc(code: string | null | undefined): RbacPermissionDoc | null {
  if (!code) return null;
  return RBAC_PERMISSION_DOCS[code] ?? null;
}
