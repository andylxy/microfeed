# 主题仓库

本册从仓库根 `AGENTS.md` 移出，规则条文、命令与实测记录逐字保留；触发条件见 `AGENTS.md` 的读取约定。

- 当用户要求编码代理从已保存实例初始化、导出、复制、fork、检查或开始开发主题时，使用本仓库的 `export-microfeed-theme` 技能。
- 使用 `yarn manage theme init` 从站点的实际外观创建新主题身份；需要保留包身份的精确已安装不可变版本时使用 `yarn manage theme export`。初始化或导出后仅做验证；除非用户另行要求安装、激活、停用、删除、staging、提交、创建远程或推送，否则不执行这些操作。验证用的预览服务器用完必须停止。

## 中文主题 `local.feed-zh`（本项目维护的中文主题）

- 源码在 **`themes/feed-zh/`**，包身份 `local.feed-zh`，版本号写在 `microfeed-theme.json` 的 `version`。
- 它**不在** `BUNDLED_THEME_CATALOG` 里（说明见 `themes/README.md`），因此 `init` / `deploy` **不会**自动安装、同步或激活它——必须手工安装。
- 它是 workspace 成员（根 `workspaces` 覆盖 `themes/*`），依赖用 `workspace:^` 指向仓库内的 `@microfeed/theme-kit`。**不要**在这个目录里执行 `git init`（会被当成 gitlink 提交）。
- **仓库外的 `../microfeed-themes/feed-zh` 已冻结，不再维护**，保留它仅为历史参考。今后中文主题的一切修改都改 `themes/feed-zh/`；不改仓库外那份，也不再从它安装。

### 改完中文主题后：安装与激活

```console
# 1. 先递增 microfeed-theme.json 里的 version（同一个 packageId + version 不能对应不同内容）
# 2. 校验与测试
node --import tsx packages/theme-kit/src/cli.ts validate themes/feed-zh --json
node --import tsx packages/theme-kit/src/cli.ts test themes/feed-zh --json

# 3. 安装到目标实例。开发环境（默认）装本地，加 --local；本项目不使用 --preview。
#    装到生产环境由用户主动管理，用户明确要求时才执行不带 --local 的那条。
#    安装完成后一定是「未激活」状态。
yarn manage theme install themes/feed-zh --instance ctwh-881019-xyz --local

# 4. 确认列表里出现了新版本
yarn manage theme list --instance ctwh-881019-xyz --local

# 5. 在后台 Settings → Themes 预览确认后，再单独激活
yarn manage theme activate <theme-id> --instance ctwh-881019-xyz --local
```

- **安装与激活是两步**，安装后必然未激活——这是有意的安全设计，不要试图一步到位。
- `theme delete` 会拒绝删除 **Built-in 版本**与**当前激活的 Custom 版本**，且需要 `--confirm <精确 theme-id>`。
- 改主题**只影响显示**，不要顺手改功能逻辑。

### 安装激活后：清理旧版本（只保留最新版 + 上一版）

**这是本项目的固定收尾动作**：`install` + `activate` 完成后接着执行，不用再逐次确认口径；执行后把删掉了哪些版本报给用户。`install` 只 INSERT、不覆盖，同一个 `packageId` 每装一次就多一行，后台主题列表会把它们全部列出来，所以每次上线后都要清理。

**保留哪两行**：刚安装并激活的那一版（版本号最大）＋ 紧邻的上一版（回滚点）。**其余版本全部删除。**

```console
yarn manage theme list --instance ctwh-881019-xyz                                    # 确认 active 是刚装的那一版，记下要删的 id
yarn manage theme delete <theme-id> --instance ctwh-881019-xyz --confirm <theme-id>  # --confirm 必须与 theme-id 完全一致
```

- **必须保留上一版**：`theme rollback` 依赖 `theme_state.previous_theme_id`。删除该字段指向的版本时，CLI 会自动把它清成 `NULL`，回滚点随之消失。第 3 行起更早的历史版本没有任何用途，一律删除。
- 管理后台（Settings → Themes 的 custom tab）有同用途的界面入口（[ADR-0026](../../docs/novel-cms/adr/0026-purge-only-physical-delete-path.md)）：「清理旧版本」按钮先 dryRun 给出将删清单再执行，口径为全局——全部自定义主题里只留激活行与上一版行（上文 CLI 流程为按 package 口径），已软删除的墓碑行一并清除；每行删除是二选一对话框，归档（软删除）或永久删除（purge，需输入 `package@version` 确认）。
- 软删除（`theme delete` 与管理后台的「归档」）写 `deleted_at`，行仍留在表里，继续占 `UNIQUE(package_id, version)`——重装同版本会报 `versionReusedAfterDeletion`，墓碑行只能靠「清理旧版本」或单行「永久删除」释放重装位。
- ⛔ **不要**用 `wrangler d1 execute … "DELETE FROM themes …"` 绕过。管理后台的「永久删除」（purge 端点）是唯一合法物理删除路径：拒绝内置与当前激活行、删行后清理该版本在 R2 的资产、修正 `theme_state`。裸 SQL 三条都做不到——留下孤儿 R2 对象、`theme_state` 悬空指向、不可恢复。
- 内置主题（`microfeed.*`）不参与清理：CLI 与管理后台都拒绝删除它们，也不占 Custom 配额。每个环境上限：100 个未删除 Custom 版本、20 个草稿。

## 安装 / 发布 / 草稿上线前的绑定参数确认（强制）

每一次 `yarn manage theme install`（带 `--local` 与不带的都算）、后台主题安装、草稿发布，动手前都要确认写 `themes` / `theme_drafts` 的通道用的是绑定参数，下面三条全部满足才算通过：

1. 写库 SQL 文本里只有 `?` 占位，`bundle_json`、`preview_fixture_json`、`manifest_json` 都没有按字面量拼进 SQL；
2. 全部值经 `.bind(...)` / `queryD1WithParameters(...)` / D1 REST 的 `{sql, params}` 传入；
3. 结果判据：整行 `bundle_json` 由一条 INSERT 写入，没有出现为绕过 D1 单语句 100KB 文本上限而做的分块 UPDATE。

量化依据（2026-10-26 本地 D1 实测）：`themes` 未删除 9 行的 `bundle_json` 最大 119,974 字节（激活行 `local.feed-zh@0.1.54`）、合计 513,506 字节；含 3 行墓碑的 12 行最大 121,180 字节、合计 816,400 字节。任一条不满足（例如拿到的是字面量 SQL 文件），先改造通道再执行安装，不要在不合格通道上重试。完整条文与跨环境同步的额度纪律：`docs/agents/d1-sync.md` 末节；常驻结论：`AGENTS.md`「主题写库必须用绑定参数」。
