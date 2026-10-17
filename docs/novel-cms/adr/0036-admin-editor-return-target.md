# ADR-0036: 后台编辑器返回目标跟随来源

- 状态：Accepted
- 日期：2026-10-17
- 决策人：用户 + 设计评审
- 关联设计：ADR-0027（后台卷看板按需读取——本 ADR 沿用它的卷键口径，不改读取路径）
- 本 ADR 来源：2026-10-17 的 grill-with-docs 评审（8 轮问题定稿，见「决策」各条的取舍理由）

## 背景

从卷看板（`/[adminPath]/volumes/`）点开一章，跳转目标是条目编辑页（`/[adminPath]/items/<id>/`）。编辑完想回原来那一卷，页面上没有任何入口：

| 事实 | 位置 |
| --- | --- |
| 编辑页左上角 `← 查看全部条目` 是服务端渲染的面包屑，**写死**指向 `items/list` | `src/pages/[adminPath]/items/[itemId]/index.astro:44-48` |
| 侧栏高亮同样写死 `ALL_ITEMS` | 同上 `:35` |
| 删除条目成功后固定跳 `items/list` | `src/components/admin/items/EditItemApp/index.tsx:331` |
| 卷看板的展开态（书 + 卷键）本来就存在地址里，返回目标完全可重建 | `src/components/admin/volumes/VolumesApp.tsx:52-69` |
| 进入条目编辑页的调用共 11 处，其中 5 个看板是「点进去编辑」的入口：全部条目、卷、留痕、方剂、中药/名词 | `editItem(` 全仓检索 |
| 面包屑 `hidden … lg:inline-flex`，<1024px 不渲染 | `src/components/admin/AdminTopBar.astro:49-55` |

三个候选做法：把面包屑**直接替换**成固定的「卷章管理」；**两个链接都留**；**返回目标跟随来源**。直接替换会让从「全部条目」「留痕」「方剂」进来的用户回不到列表，两个链接会把顶栏挤成两行且窄屏仍然没有入口。

## 决策

### D1｜返回目标由看板自报，参数是「名字」不是 URL

看板在链接上写 `?from=volumes&bookId=…&volume=…`，编辑页用 `resolveAdminReturnTarget()` 把这个**名字**解析成返回目标（`src/shared/AdminReturnTarget.ts`）。`from` 走注册表白名单，未知名字返回 `null`，调用方退回自己的默认返回链接。

注册表当前四个看板：`volumes`（书 + 卷键）、`fangs`（书）、`yao`（书）、`term`（书）。后三个的主轴只有书，所以只带 `bookId`。

不接收 `?back=<url>` 这类任意地址：手改地址最多让人回到「全部条目」，不会把返回箭头变成开放重定向。注册表就是唯一的扩展点，接一个看板 = 一条注册项 + 一处链接。


### D2｜缺必需参数就退回，不带人去看空看板

`volumes` 的必需参数是 `bookId`。缺它时卷看板只会显示「先选择一本书」，比回「全部条目」更没用，所以 `resolveAdminReturnTarget` 直接返回 `null`。`fangs` / `yao` / `term` 同理，`bookId` 就是它们唯一的必需参数。参数长度上限 200 字符，超出视为噪声丢弃。

### D3｜卷键原样透传，不从条目反推

`volume` 传的是看板自己的**卷键**：TCM 典籍是那行篇章的 11 字符 id，标签书是 `_microfeed.volume` 的卷名，未归类是 `unfiled`。条目身上的 `_microfeed.volume` 是**卷名**，对 TCM 书反推出来的键指不到卷（见 CONTEXT.md「卷键」、ADR-0027）。所以返回目标只能由看板报出来，服务端不做推导。

### D4｜侧栏高亮跟随返回目标

`from=volumes` 时编辑页把左侧菜单高亮切到「卷章管理」。返回箭头指向卷章管理而高亮停在「查看全部条目」是两个互相矛盾的信号。

侧栏形状不变：`volumes`、`all_items`、`fangs`、`yao`、`term` 同属 `group_content`（`migrations/0050_ext_menu_groups.sql:35-36`、`0073_ext_fang_menu_permissions.sql:27`、`0077_ext_tcm_yao_term_menu_permissions.sql:28-30`），切换高亮都渲染同一个分组子侧栏，只是被选中的那一行换了，不会跳成另一套导航。

### D5｜方剂 / 中药 / 名词三个看板先把书写进地址

这三个看板的选中书原先只活在 React state 里，地址上没有任何状态。返回目标要指回「这本书的看板」，前提是看板自己能读回这本书，所以先给它们补上 `?bookId=`：选中书时 `writeBoardParam()` 写回地址，挂载时 `readBoardParam()` 读回。

顺带得到两个既有行为：刷新不再丢选中，地址可以当书签或发给同事。回收站视图（`?deleted=1`）不进返回目标——它是可切换的临时视图，返回后停在正常列表上。

编辑器里的互参链接也要带上同一个查询串：`FangEditor` 的条文引用原先直链 `items/<id>`，从方剂点进一条条文，再往回走就退回「查看全部条目」。`EditItemApp` 从 `returnUrl` 里取出查询串交给它，跨条目的一跳仍指向同一个看板。

### D6｜删除后同样跟随来源

删除成功的跳转从固定 `items/list` 改成 `returnUrl ?? ADMIN_URLS.allItems()`：从卷看板进来的章节删掉后回到那一卷，看着它少一条，而不是跳到全站平铺列表。

### D7｜未保存修改时的返回行为不改

评审时把「有未保存修改时点链接」当成静默失败，**这是错的**：`preventCloseWhenChanged` 在 `astro:before-preparation` 上 `preventDefault()` 之后，Astro 的 router 会改走 `location.href = to.href`（`node_modules/astro/dist/transitions/router.js:250-254`），于是 `beforeunload` 生效、浏览器弹出原生「离开此页面？」确认框，确认后整页跳转。也就是说确认**已经存在**，只是样式是浏览器原生的，且是一次整页加载。

要做成样式化确认框，就得在链接点击层拦截（`preventDefault` 已经在 router 内部触发原生回退，改不动它的跳转目标），改动面覆盖全部 7 个使用该守卫的页面（条目编辑、频道编辑、页面编辑、站点文件、主题草稿、设置、代码编辑器）。收益是弹窗样式，代价是 7 个页面的导航路径重写，**不划算**，因此维持现状。

### D8｜窄屏不处理

面包屑在 <1024px 不渲染，编辑页在窄屏上只能靠浏览器后退。用户明确「不需要小屏的」，本次不加窄屏返回入口，也不动全局面包屑的响应式规则（会波及 20 多个后台页面）。

## 后果

- 卷看板 → 编辑页 → 返回，回到原来那一卷且该卷自动展开；方剂 / 中药 / 名词看板 → 编辑页 → 返回，回到原来那本书。跨条目互参（方剂 → 条文）同样带着同一个返回目标。往返 **0 次额外 D1 读取**：返回目标全部由地址解析得出，编辑页不新增查询。
- 从「全部条目」「留痕」进来的用户行为**一字不变**，仍回各自的默认目标。
- 地址里带 `bookId` / `volume`，可以把它当书签或发给同事，打开即是那一卷 / 那本书（卷看板本来就这么读地址，方剂 / 中药 / 名词三个看板自本 ADR 起也如此）。
- **已知边界**：在编辑页把章节改到别的卷之后，返回链接仍指向原来那一卷——那一卷里已经没有它了。这是「回到我点进来的地方」的字面含义，不做智能重定向。
- **未接的 2 个看板**：留痕、全部条目仍是固定返回目标。机制已通用，各差 1 条注册项 + 1 处链接改动。

## 验证口径

主接缝是共享层纯函数：`tests/unit/shared/AdminReturnTarget.test.ts` 锁白名单（未知名字、`toString` 这类原型键、缺 `bookId`、超长参数一律 `null`）、四个看板的标签与跳转目标、卷键透传、参数顺序，以及 `adminReturnQuery` 与 `resolveAdminReturnTarget` 的往返一致。`tests/unit/shared/StringUtils.test.ts` 锁 `ADMIN_URLS.editItem` 带不带查询串的两种形状。

渲染侧的接线由 `tests/unit/source-architecture.test.ts` 的「lets the board decide the item editor's back link」锁住：四个看板各自在链接上自报家门、各自把选中的书读回地址，编辑页的面包屑、侧栏高亮、`returnUrl` 三处接线，任一漏接就红。astro 页面本身不做渲染测试，浏览器里的人工核对仍是最后一道：卷看板点章 → 左上角显示「← 卷章管理」→ 点它回到该卷且展开；方剂 / 中药 / 名词看板点条目 → 左上角显示对应看板名 → 点它回到那本书。

测试只写不跑，运行由用户手动触发 `.microfeed-gate-subset` 技能。
