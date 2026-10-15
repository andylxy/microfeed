# ADR-0027: 后台卷看板按需读取——逐卷计数与写入守卫点查

- 状态：Accepted
- 日期：2026-10-15
- 决策人：用户 + 设计评审
- 关联设计：ADR-0011（`rows_read` 为代价单位）、ADR-0012（物化 + 触发器失效）、ADR-0014（显式复合索引）、ADR-0017（窄投影）、ADR-0024（无全表扫描基线）、ADR-0025（卷作为一级阅读单位，本 ADR 把同一口径搬到后台）、ADR-0026（物理删除端点，与本 ADR 无交集）
- 本 ADR 来源：`.scratch/volumes-on-demand/spec.md`（grill-with-docs 评审定稿）与其 `issues/01..05`；探针脚本与输出留在同一目录

## 背景

后台的卷看板（`/[adminPath]/volumes/`）原先用一个入口把整本书读完：`listVolumeBoard` 先读这本书的全部条目行，再在内存里分组成卷。本机《黄帝内经・素问》（81 卷 / 2,883 条条文 / 2,964 行读物）的口径：

| 动作 | 改动前 | 改动后 |
| --- | --- | --- |
| 打开一本书 | 行读 2,964，索引步进 + 回表合计 8,812，响应 428,124 字节 | 行读 3,046，响应 5,254 字节 |
| 点开最大一卷（306 条） | 已含在上一行 | 612 行（306 索引步进 + 306 回表），47,478 字节 |
| 归卷 3 条的写入守卫 | 5,928 行（整本读两遍）+ 一次全量内容读取 | 6 行（每条一次主键点查） |

远程 D1 每天 5M 行读额度：按 8,812 的口径这一页每打开一次吃 0.18%，最多 567 次就把额度用完；按 3,046 的口径可支撑 1,641 次。

页面底部那个分页器与代价无关：它把已经拿到手的整块数据做客户端切片，翻页零次请求。它制造了「这页读得少」的印象，真正的代价在那一次整本读取。ADR-0025 已经在读者侧把书页目录改成「只列卷、点开才读」，后台这一页是同一件事的最后一块。

## 决策

### D1｜读取入口拆成两个，整块看板入口删除

`listBookVolumes(db, bookId)` 返回这本书的卷与每卷条数，**不含任何条目行**；`listVolumeEntries(db, bookId, volumeKey)` 返回一卷的全部条目，不翻页。`listVolumeBoard` 与其共享形状（`VolumeBoard` / `VolumeGroup` / `VolumeChapter`）随最后一个使用者一起删除。卷键由后端给出并塞进同一个 `key` 字段：TCM 典籍是那行篇章的 11 字符 id，标签书是 `_microfeed.volume` 的卷名，前端不需要分辨书的种类。

响应从 428,124 字节降到 5,254 字节，靠的是「不读条目正文」加上窄投影：展开一卷时每条只回 `id / title / status / pub_date / volumeOrder`（47,478 字节），而不是把整坨 `data` 展开（136,998 字节）。

### D2｜逐卷条数走覆盖索引，接受一次 `USE TEMP B-TREE FOR GROUP BY`

迁移 `0116_index_book_kind_volume_count.sql` 原地重建同名的 `items_book_kind`，末尾追加 `tcm_parent_id`，列序 `(book_id, tcm_kind, status, pub_date, tcm_parent_id)`。逐卷计数一条：

```sql
SELECT tcm_parent_id AS parent, tcm_kind AS kind, COUNT(*) AS total
FROM items
WHERE book_id = ? AND tcm_kind != 'chapter' AND status != ?
GROUP BY tcm_parent_id, tcm_kind
```

一次扫描同时给出每卷条数、按父项分组的条文数（未归类桶由这一列推出）与方剂等其他类的行数。本机《素问》81 卷实测（`.scratch/volumes-on-demand/08-ticket01-plan.ts`）：`SEARCH items USING COVERING INDEX items_book_kind (book_id=?)` 加 `USE TEMP B-TREE FOR GROUP BY`，81 组 / 4,208 字节 / 中位 0.625 毫秒、0 次回表；把索引退回 0116 之前的四列形状后同一条走 `items_book_id` 并逐行回表，中位 3.817 毫秒；它取代的整本读取是 2,964 行 / 1,233,002 字节 / 中位 9.717 毫秒。分组键排在 `pub_date` 之后，索引序给不出分组序，所以计划里那句 `USE TEMP B-TREE FOR GROUP BY` 是这条查询的固有形状，`check-d1-scan` 会对它报 D1SCAN-002——本 ADR 就是它的理由，脚本的判定规则不为此改动。

`tcm_kind != 'chapter'` 而不是 `= 'section'`：中药书与名词书挂在篇章下的 `yao` / `term` 行同样是这一卷的条目，只数 `section` 会让卷行上的条数与展开该卷时读到的条目数不一致。

### D3｜`items_book_kind` 前四列顺序不能动

`pub_date` 必须在第 4 位。ADR-0025 D4 那条「最近一条条文」的 1 行查询（`WHERE book_id = ? AND tcm_kind = 'section' AND status = 1 ORDER BY pub_date DESC LIMIT 1`）靠的就是索引里 `pub_date` 紧跟过滤列；把它挪走，那条查询退回 8,348 行。新列只能往末尾追加，这也是本 ADR 敢沿用同名索引、保持索引个数不变的前提。

### D4｜篇章查询刻意不带 `status != 3`

卷列表把被软删的篇章从展示里剔掉，但它的 id 仍是合法分组键——「条文挂在被软删的篇章下」不算未归类，这是按需读取之前既有的口径。要复刻它就得把被删篇章的 id 一并读回来（81 行），所以那条查询没有 `status` 条件。未归类只数 `section`：方剂带着本书的 `book_id` 却没有父项，属于独立的方剂目录，混进来会凭空造出一个几百条的「未归类」桶。

### D5｜写入守卫逐条主键点查，按卷条件选 id

四个写入口（归卷、改名、调序、设置卷序）原先都先读整本书攒出合法 id 集合。改为：

- 归属判定对每个提交进来的 id 各做一次主键点查（`SELECT id FROM items WHERE id = ? AND <守卫条件>`），守卫条件是 `book_id = ?` 加上书的种类口径（中医典籍 `tcm_kind NOT IN ('chapter', 'fang')`，标签书只比 `status`）。跨书 id 依旧静默忽略，不返回错误、不改动别人的条目。
- 书的存在性用 `channels` 主键点查（`volumeBookExists`），只看行在不在：被软删的书照样可以整理，这与卷列表不按 `status` 过滤书目行一致。书形用 `items_book_kind` 上的一次 `LIMIT 1` 探测。`getContent(null)` 只读 `channels` 与 `settings`，`items` 零行。
- 改名与卷序按卷条件只选 id 一列：TCM 走 `tcm_parent_id`（`items_section_order` 首列）或未归类的 `NOT EXISTS` 口径，标签书走卷名条件。卷序的载荷会把当前列出的每个卷都带进来，逐卷反查篇章 id 要步进 6,561 行，改为一次篇章列表（81 行）建「标题 → id」映射。

归卷 3 条：改动前 5,928 行，改动后 6 行。守卫与整行读取各一次，代价由提交的 id 数决定，与这本书有多少条无关。

### D6｜标签书不加派生列

本机 9,506 条条目全部带 `tcm_kind`，标签书分支在这份数据上走不到（探针实测）。因此不给 `_microfeed.volume` 加派生真实列与 `(book_id, volume)` 索引：卷名条件在 `items_book_id` 上步进这本书的全部条目行，这条分支的读取代价按整本算。生产是否存在这类书由用户在生产侧执行只读查询确认（语句与判读方式记在 `.scratch/volumes-on-demand/issues/04-tag-book-branch.md` 的 Comments）；一旦出现需要按需读取的标签书，另开 ADR 处理派生列，而不是在本 ADR 下追加。

### D7｜分页器从这条页面移除，指导文件删掉那条强制条款

`每页条目数`设置不再被这页读取。AGENTS.md 里「新建任何管理后台列表/看板类页面模块时，必须内置分页器」整条除掉，换成「列表页的取数代价按 D1 行读判断，不得为了凑分页控件而一次性读整本或整表」——那条强制条款会把后来的人推回整本读取。

## 后果

- 读者侧一行不改：公开的书页目录、卷页、App 目录的读取器与输出形状保持原样（ADR-0025 的口径）。条目编辑器、方剂看板、中药/名词看板不改。
- 一次「点书 + 点开一卷」从 8,812 行降到合计约 3,658 行（3,046 + 612），最坏情形（点开最大一卷）不再随整本书大小增长。
- 卷序调整仍是写放大：上下移动会为被点到的那些卷的每条写 `volumeOrder`。这是「卷序存成条目上的标签」这一既有存储形状的固有代价，改动前后同阶，不在本 ADR 范围内（另开任务）。
- 端点层锁住两条边界：卷键不属于这本书时返回空列表且零条目读（过期或手填的地址不能跨书取内容）；缺 `content:volume:read` 时两个读入口 403，缺 `content:volume:update` 时四个写入口 403。

## 验证口径

主接缝是 `tests/worker/`（`migrations/` 全量应用到 Miniflare D1，0116 重建后的索引被真的使用）：`volumes-on-demand.test.ts`、`volumes-expand.test.ts`、`volumes-tag-book.test.ts`、`volumes-write-guards.test.ts`。第二条接缝是数据层单元测试（`node:sqlite` 实现同一个最小 D1 端口）：`tests/unit/server/extVolume.test.ts` 锁排序与分组口径。两层都不使用 mock 替身。测试的运行由用户手动触发 `.microfeed-gate-subset` 技能；本 ADR 里的数字来自本机 D1 只读探针，`node:sqlite` 拿不到 D1 的 `meta.rows_read`，「索引步进 + 回表」为推得口径。
