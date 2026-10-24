# ADR-0046: 关于页内容专用表化（ext_app_about_info + 后台管理页）

- 状态：Accepted（已实施：迁移 0145 建表 + 存量搬移 + 权限码/菜单/权限树种子、读写层、后台 /admin/app-about、i18n）
- 日期：2026-10-23
- 决策人：用户 + 代码评审
- 关联设计：ADR-0029（后台可编辑字段、内容逐字存取约定，本 ADR 复用其「原样存取、清空写空串」口径）、ADR-0038（合并后侧栏从权限树节点读取，页面节点必须带 path / entry_code）、ADR-0018（单一 ADR 编号空间）；迁移 0145（建表 + json_each 存量搬移 + 种子）

## 背景

旧后端 getAboutInfo 的数据来自 DevConfig 表的 `aboutInfo`（一个可选的 `[{text, name}]` 数组），在 microfeed 里被平铺进 `settings` 表 `webGlobalSettings` 行的 `data.aboutInfo`。两个问题：

1. **存储错位**：关于页是独立业务实体，却寄生于 settings 口袋键，与「全局站点设置」语义混淆，无法独立授权、独立管理、独立迁移。
2. **无管理界面**：全仓没有任何界面能查看或修改它；想改致谢 / 手册 / 书名作者 / 更新日志只能直接改库或重跑导入。

App 端 AboutActivity 按 `name` 固定 4 槽位分发（`about_thks` / `about_manual` / `about_bookname` / `app_updata_log`），text 走自有 `$x{...}` 可点击标记 + `|` 换行，**非 Markdown**，未知 name 丢弃。因此后台编辑器只需作输入面板，内容逐字存取即可，不需要富文本 / Markdown 渲染。

## 决策

### D1｜专用表 ext_app_about_info，name 主键即分发枚举

```sql
CREATE TABLE IF NOT EXISTS ext_app_about_info (
  name       VARCHAR(80) PRIMARY KEY,
  text       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

- `name` 是主键，也是 App 的分发枚举。将来 App 新增槽位只需加行，无需改表（与「App 契约封闭枚举」一致）。
- `text` 逐字字符串，建表列宽 80 与读写层校验一致（`name.length <= 80`）。

### D2｜一次性存量搬移，旧字段只读不删

迁移 0145 用 `json_each(settings.data, '$.aboutInfo')` 把 `webGlobalSettings.aboutInfo` 拆行搬入新表（`INSERT OR IGNORE`，幂等可重放）。旧字段**保留原样不清理**——与「已应用迁移一字不动」同理，历史数据不做破坏性变更；新表读写后旧键不再被任何代码读取。

### D3｜读写层：整表同步，删未提交行

`src/server/app/about/config.ts`：

- `readAboutInfo`：`SELECT name, text … ORDER BY name`，按 name 稳定排序。
- `saveAboutInfo`：先校验每条 `{name, text}`（name 非空且 ≤80、text 必为字符串），再 **upsert 提交行 + 删除提交里没有的行**，同一 `database.batch` 原子生效。
- 整表同步让「删槽位」成为显式动作——提交里去掉某 name 即物理删除，不留 App 永不显示的幽灵行；names 为空时占位 `DELETE` 防 SQL 空 `IN` 报错。
- 槽位集合是封闭枚举（App 只认 4 个 name），整表同步在封闭集上安全。

### D4｜公开端点 getAboutInfo 改读新表

`src/server/tcm/config.ts` 的 `getAppAboutInfo` 由读 settings 口袋改为 `SELECT name, text FROM ext_app_about_info ORDER BY name`，返回形状 `[{text, name}]` 不变（App 契约零改动）。该端点保留在匿名清单（App 无需登录即可读关于页）。

### D5｜后台管理页 /admin/app-about，4 槽位各一编辑器

- 路由：`GET /admin/ajax/app-about`（`system:app-about:read`）+ `POST /admin/ajax/app-about/save`（`system:app-about:manage`），注册于 `src/server/admin/pc-interfaces.ts`。
- 页面 `src/pages/[adminPath]/app-about/index.astro` + 组件 `src/components/admin/app-about/AppAboutApp.tsx`：4 个固定 name 槽位各一个 `AdminMarkdownEditor`（复用 `/admin/items/new` 条文注文同款组件），内容逐字存取（ADR-0029 约定）。

### D6｜权限码 + 菜单 + 权限树种子（0087/0127/0133 模式）

迁移 0145 种子：

- 权限码 `system:app-about:read` / `system:app-about:manage`（id 与 `permissionId()` 公式逐字节一致）。
- 菜单行挂「运营管理」组（devices 601 / app_versions 602 / login_logs 603 / announcements 604 / cloud_usage 605 之后），sort 606；可见性只认 `ext_menu.permission_code` 直列（ADR-0038）。
- 权限树节点：页面节点 `page_app_about` 带 `path='app-about'` / `entry_code='system:app-about:read'`（0133 起页面节点必须带这两列，否则合并后侧栏少一行），+ 两个码叶子。
- `super_admin` 靠 `*` 通配天然拥有；editor / readonly 不授予（治理类口径，与公告一致）。
- i18n：`menu.item.appAbout`（关于页内容 / About page content）双语文案，菜单行 `name_zh` / `name_en` 与之逐字一致（`admin-menu.test` 守住）。

## 后果

- 关于页内容从 settings 口袋键升级为独立授权、独立管理、独立迁移的实体。
- App 契约零改动：getAboutInfo 响应形状、字段名、空数组语义不变；存量数据经迁移自动搬入。
- 后台首次出现关于页可视化编辑能力。
- 负面 / 风险：① 整表同步是「提交即真理」——误清空提交会物理删除所有槽位（设计取舍：封闭枚举下可接受，且撤销只需重新提交）；② 编辑器复用 Markdown 组件但内容非 Markdown，App 端的 `$x{...}` / `|` 标记由 App 自行解析，后台只负责原样存（ADR-0029 约定，不做前端渲染）；③ 上线需对远程 D1 执行 `d1 migrations apply`，0145 自动建表 + 搬存量。

## 验证

- 单测（定向跑绿）：`app-interfaces.test.ts` / `pc-interfaces.test.ts` 登记新端点；`rbac-permission-docs.test.ts` / `admin-menu.test.ts`（worker，菜单顺序 + 节点显示名）；`manage-cli/snapshot.test.ts` 的 `SNAPSHOT_TABLES` 加 `ext_app_about_info`。
- 门禁（astro check / tsc / endpoints / i18n / migrations / layout / adr）全过。
- 联调：后台 /admin/app-about 编辑 4 槽位保存后，App 关于页对应槽位即时反映；匿名 getAboutInfo 直读新表。
