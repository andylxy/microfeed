# 中医内容迁移到 microfeed · 技术规范

- 状态：**Draft**（方案已定稿，实现未开始）
- 日期：2026-09-28
- 决策人：用户
- 相关仓库：
  - 目标：`D:\git\AiCode\microfeed`（本仓）
  - 源数据：`D:\git\AiCode\microfeed\ctwh\*.sql`（MySQL dump）
  - 源后端：`D:\git\web\Vue.NetCore\vol.api.sqlsugar`（.NET 8 + SqlSugar，运行中）
  - 源移动端：`D:\git\app\AndroidProject-old`（包名 `run.yigou.gxzy`）

---

## 1. 决策记录

| 项 | 决定 |
| --- | --- |
| Android App | **保留**。microfeed 逐函数照抄 `/api/AppBookRequest/*`，路径与响应 JSON 形状完全对齐，App 只改 baseUrl、零改码 |
| 问诊 / AI 对话 | **不迁**（`WenZhen*` 四表、`getConversation` / `streamConversation`） |
| 范围 | 典籍 / 方剂 / 中药 / 名词 四块 |
| 数据模型 | **方案 E：不建新表**，全部落在 `channels` + `items` + `_microfeed` 口袋 |
| 分类 | 用现有 `ext_category` 动态标签；新建「针灸」「人纪」，保留「东方玄幻」 |
| 编辑入口 | **不另开页面**，在现有博文管理页 `/admin/items/` 编辑，层级最细到条文 |
| 图片 | 走项目媒体（R2）；**源文件后补**，导入时置空，原始路径存 `_microfeed.sourceImagePath` |
| 登录 | `login` / `replaceToken` **迁移** |

---

## 2. 源数据事实（实测）

### 2.1 数据量

| 文件 | 行数 | 源表 → .NET 实体 | 含义 |
| --- | --- | --- | --- |
| WorkInfo.sql | 13 | `WorkInfo` → BookInfo | **书籍元数据**（作者 / 成书时间 / 封面 / 简介） |
| Book.sql | 445 | `Book` → **BookChapter** | 篇章 |
| BookBody.sql (10MB) | 8066 | `BookBody` → **BookChapterBody** | 条文 / 小节 |
| Fang.sql | 804 | `Fang` → **FangYao** | 方剂 |
| FangBody.sql | 2023 | `FangBody` → **FangYaoBody** | 方剂组成 |
| Yao.sql | 172 | `Yao` → ZhongYao | 中药 |
| yaoAlias.sql | 47 | `yaoAlias` → yaoAlia | 药名别名 |
| MingCi.sql | 17 | `MingCi` → BeiMingCi | 名词解释 |

> ⚠️ 表名与 .NET 实体名**不是**一一对应（`Book` 是篇章不是书），移植时以 .NET 实体语义为准。

### 2.2 书籍清单（`WorkInfo`，13 本）

| ChapterId | Case | BookName | BookNo | Author | 有篇章？ |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 针灸大成 | 100100 | 杨继州 | ✗ |
| 2 | 9 | 针灸篇・(人纪) | 9010000 | 倪海厦 | ✗ |
| 3 | 9 | 伤寒论・(人纪) | 9040000 | 张仲景(倪・注) | ✗ |
| 5 | 9 | 黄帝内经・(人纪) | 9030000 | — | ✗ |
| 6 | 5 | 伤寒金匮・(宋版) | 10001 | — | ✓ |
| 7 | 5 | 金匮要略・(宋版) | 10002 | — | ✓ |
| 8 | 2 | 难经 | 20100000 | — | ✓ |
| 9 | 2 | 黄帝内经・素问 | 20200000 | — | ✓ |
| 10 | 2 | 黄帝内经・灵枢 | 20300000 | — | ✓ |
| 11 | 9 | 神农本草经・(人纪) | 9020000 | 倪・注 | ✗ |
| 12 | 5 | 伤寒杂病论・(桂林古本) | 1001000 | 张仲景 | ✗ |
| 13 | 3 | 神农本草经疏 | 400100 | 缪希雍.明 | ✗ |
| 14 | 9 | 金匮要略・(人纪) | 9050000 | 张仲景・汉 | ✗ |

**只有 5 个 `BookNo` 有篇章数据**：10001 / 10002 / 20100000 / 20200000 / 20300000。
方剂 `FangSourceBookId` 取值 `{10001, 10002, 1001000, 9040000, 9050000}` —— 其中 1001000 / 9040000 / 9050000 三本**没有篇章**，只有方剂。

### 2.3 `Enable` 分布（实测，存疑）

| 表 | Enable=1 | Enable=0 |
| --- | --- | --- |
| WorkInfo | 至少 1 | 至少 3 |
| Book | 335 | 77 |
| **BookBody** | **0** | **8066（全部）** |
| Fang | 365 | 438 |
| Yao | 172（全部） | 0 |
| MingCi | 17（全部） | 0 |

⇒ **禁止在导入时按 `Enable` 硬过滤**（BookBody 会一条不剩）。`Enable` 原样存进表，可见性交给后台控制。

### 2.4 两个数据陷阱

1. **MySQL 方言**：反引号标识符 + `\r\n` / `\'` 反斜杠转义。**SQLite 不解析反斜杠转义**，直接执行会把字面 `\n` 存进正文。
2. **脏花括号**：存在 `$m{{虚者}` 这类内容本身以 `{` 开头的记录；标记可嵌套（`$a{$q{《千金》}…}`）。

---

## 3. 目标站点现状（远程 D1 实测，实例 `ctwh-881019-xyz`）

- 生产域名 `https://feed.881019.xyz`，站点标题「星河剑歌」（小说演示站）
- `ext_category` 4 条：东方玄幻 `cat_x1` / 本草 `OteD-aXHV_d` / 内经类 `j24vLiF3Sym` / 伤寒 `1runoCsI7dr`
- `channels` 7 本，全是小说演示书；`items` 35 篇
- 库大小 5.8MB；导入后预计 20–30MB，远低于限额

模型事实（ADR-0006 实测）：

- **书 = `channels` 行，章 = `items` 行**，靠 `data._microfeed.bookId` 关联（非外键）
- **卷不是实体**，只是 `_microfeed.volume` 字符串
- 正文存 `data.description`，格式由 `data.content_format` 标明（缺省 html）
- `/api/v1/content/*` 是**只读** API；`yarn microfeed item create` 只写主频道、不支持 bookId；旧的「从 txt 导入章节」页已在迁移 **0066 删除** ⇒ **没有现成批量写入通道**

---

## 4. 标记协议 `$X{}`（权威规格）

来源：`AndroidProject-old/library/text-renderer/src/main/java/run/yigou/gxzy/text/TipsTextRenderer.java` + `TipsTextRenderConfig.java`

### 4.1 解析规则

```java
Pattern.compile("\\$([a-zA-Z]{1,10})\\{([^}]*)\\}")   // marker 1-10 字母，内容不含 }
```

旧实现**单遍非递归**：`$a{$q{《千金》}…}` 会被解析成 marker=`a`、content=`$q{《千金》`，内层原样显示且吃掉一个 `}`。**新实现要做成递归，修掉这个 bug。**

### 4.2 样式配置（`StyleConfig{color, isSmallFont, linkType}`）

| marker | 语义 | 颜色 | 小字(0.7×) | linkType | 全库频次 |
| --- | --- | --- | --- | --- | --- |
| `u` | **药物 / 药名** | 蓝 `#0000FF` | — | **1 → 药物详情** | 4287 |
| `w` | **剂量** | 绿 `rgb(28,181,92)` | ✓ | 0 | 3636 |
| `f` | **方剂名** | 蓝 | — | **2 → 方剂详情** | 1969 |
| `q` | **引用书名** | 浅绿 `rgb(61,200,120)` | — | 0 | 454 |
| `a` | **按语 / 校注小字**（可嵌套 `$q`） | 灰 | ✓ | 0 | 347 |
| `m` | 红色强调（术语 / 书名） | 红 | — | 0 | 293 |
| `n` | 蓝色短语（解说） | 蓝 | — | 0 | 87 |
| `x` | 橙色单字（偏 / 偶 / 升 / 反） | `#EA8E3B` | — | 0 | 76 |
| `g` | **名词解释** | 半透明蓝 `rgba(0,128,255,0.9)` | — | **3 → 名词详情** | 10 |
| `r` | 红色小字（说明） | 红 | ✓ | 0 | 1 |
| `v` | 蓝色 | 蓝 | — | 0 | 1 |
| `y` | 棕色 `#9A764F` | 棕 | — | 0 | 1 |
| `h` | 黑色 | 黑 | — | 0 | 2 |

**`linkType` 是关键**：标记不只是颜色，是**可点击的跨实体跳转**（1=药、2=方、3=名词）。

### 4.3 站点现有标记对照（3 错 1 对）

| 现有 `ext_annotation_markers` | 判定 |
| --- | --- |
| `$f 方剂` | ✔ 一致 |
| `$a 中药` | ✘ 源语义是**按语小字** |
| `$u 穴位` | ✘ 源语义是**药物** |
| `$x 西医/检验` | ✘ 源语义是**橙色单字** |

### 4.4 ⛔ 公开站目前不解析标记

`src/shared/BodyFormat.ts` 的 `bodyToHtml()` 对 HTML **原样透传**，主题 mustache 直出 `content_html`；全仓只有编辑器侧 `registerMarkerMenus.ts` 用标记（插入纯文本）。
⇒ **必须先加渲染器，否则读者看到满屏字面 `$u{桂枝}$w{三两}`。**

---

## 5. 目标数据模型（方案 E）

### 5.1 架构（单向派生，无双向同步）

```
ctwh/*.sql（源快照，一次性）
        ↓ 导入脚本（可重跑）
channels + items（SSOT，含 _microfeed 口袋 + tcm_* 索引列）
        ↓ ① App 端点直接读        ② 主题 / 搜索 / 后台
/api/AppBookRequest/*            Web 展示（零新增页面）
```

### 5.2 映射表

| 源实体 | 落点 | `tcm_kind` | 关联落点（**全用当前项目 11 位 id**） | `_microfeed` 口袋字段 |
| --- | --- | --- | --- | --- |
| WorkInfo 书 | `channels` | — | — | `author` `chengShu` `chapterCount` `hot` `comment` `sourceImagePath` `case`（源 Case 原值，App 按 caseTag 区分行为） |
| Book 篇章 | `items` | `chapter` | **频道** → `_microfeed.bookId`（保存时镜像进 `book_id` 索引列） | `section`（源章序号，排序键） |
| BookBody 条文 | `items` | `section` | **频道** → `_microfeed.bookId`；**父篇章条目** → `tcm_parent_id` **列**（已建索引） | `receiptNo`（源节序号，排序键） `note` `videoMemo` `fangList` `bieMing`（源 BieMing，别名接口第三源） |
| Fang 方剂 | `items` | `fang` | **容器频道** → `_microfeed.bookId`；组成药味 → **内嵌** `fangYaoList[].yaoId` | `yaoCount` `drinkNum` `yaoList` `fangList` |
| Yao 中药 | `items` | `yao` | **容器频道** → `_microfeed.bookId`；别名 → **内嵌** `aliases[]` | `bieMing`（源 YaoBieMing 原文） `yaoNames`（源 YaoList 原文，别名接口第二源） |
| MingCi 名词 | `items` | `term` | **容器频道** → `_microfeed.bookId` | `beiMing` `type` `mingCiList`（源列原文） `sourceImagePath` |

> **两条规则，各管一类，不重叠**（详见 §16）：① **频道归属**永远走 `_microfeed.bookId`（保存路径自动镜像到已有的索引列 `book_id`）；② **父子条目层级**（只有「条文→篇章」这一条）永远走 `tcm_parent_id` 列。同一个关系绝不两处写。
>
> **所有关联一律用当前项目 11 位 id（以当前项目为主）**：条文→篇章用 `tcm_parent_id`、各实体→频道用 `bookId`、组成→中药用 `yaoId`、别名→中药条目 id。**源 int64 主键与编号（BookNo/FangNo/YaoNo/Case 码等）只在导入脚本内存里消费**（分类码映射、行数对账），**不落库、不设列、不出现在任何响应**；`section` / `receiptNo` 是源序号，仅作同书/同章内的排序键（App 响应里 `receiptNo` 也是这个用途）。

- **三个容器频道**：方剂 / 中药 / 名词各自挂在一个容器频道（「方剂」「本草」「名词」）下——否则主题页面看不到它们，linkType 1/2/3 的跳转也没有落点。容器随典籍一起导入，不进分类导航（避免污染分类页）。
- 方剂组成（FangBody 2023 行）内嵌为 `fangYaoList[]`：`{yaoId(中药条目 11 位 id), amount, weight, suffix, showName, extraProcess}`
- 药别名（yaoAlias 47 行）内嵌为 `aliases[]`
- **篇章条目的 `description` = 该篇章全部条文正文按 `receiptNo` 序拼接**（用户拍板保留，2026-09-28）：PC 章节页直读该 description；App 端仍按 `tcm_parent_id` 实时读条文，不消费这个聚合。与 8066 条 unlisted 条文的重复存储是已知代价。
- `channels` 与分类：`data._microfeed.genre` = `ext_category.id`（沿用 novel-cms 既有约定）

### 5.3 Schema 变更

**迁移 0070** —— `items` 加 2 列 2 索引：

```sql
ALTER TABLE items ADD COLUMN tcm_kind TEXT;
ALTER TABLE items ADD COLUMN tcm_parent_id TEXT;

CREATE INDEX IF NOT EXISTS items_tcm_kind_name
  ON items (tcm_kind, json_extract(data, '$.title'));

CREATE INDEX IF NOT EXISTS items_tcm_kind_parent
  ON items (tcm_kind, tcm_parent_id);
```

> `tcm_kind` / `tcm_parent_id` 提为真实列的理由：`src/server/feed/FeedDb.ts:596` 的 `_putItemToContentStatement()` 只写 8 个已知列，**真实列不会被后台保存覆盖**；而 JSON 路径上的条件无法走索引。`items_tcm_kind_name` 的最左前缀同时覆盖「按 kind 过滤」与「(kind, 标题) 名字跳转」；`items_tcm_kind_parent` 专供「某篇章的条文」——**没有它就是 8066 行全表扫描**（这是 App 最主要的读取路径）。**不设任何源 id 列**（以当前项目为主）。

**迁移 0071** —— `ext_annotation_markers` 加 3 列并重种：

```sql
ALTER TABLE ext_annotation_markers ADD COLUMN color TEXT;
ALTER TABLE ext_annotation_markers ADD COLUMN small_font INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ext_annotation_markers ADD COLUMN link_type INTEGER NOT NULL DEFAULT 0;
```

重种 13 项（f/a/u/w/q/r/g/m/n/v/x/y/h），并修正现有 3 枚 title。

**迁移 0072** —— 新建两个 `ext_category`：「针灸」「人纪」（id 11 位），外加三个容器频道（方剂 / 本草 / 名词，固定 11 位 id + `_microfeed.tcmContainer` 标识）。

---

## 6. API 移植清单

落点：`src/pages/api/AppBookRequest/*.ts`（路由）+ `src/server/tcm/*.ts`（读函数）+ `src/shared/Tcm.ts`（类型）。

> 全部公开读、无鉴权；**不进 OpenAPI 契约**（App 专用，非公共 API）。
>
> **⚠️ 响应信封与字段名以 golden 实测为准（2026-09-28 工单 15）**：旧后端框架把每个返回包成
> `{code:200, data:<载荷>, msg:"请求成功"}`，载荷字段名**全小驼峰**（spec 初稿按 .NET C# 属性名写成的
> PascalCase 是错的）；部分数值字段旧后端序列化为**字符串**（如方剂行的 `yaoCount:"5"`、`height:"0"`、
> `weight:"300"`）；空值发 `null`。新端点已逐字节对齐（`src/server/tcm/envelope.ts` 的 `appEnvelope` 包装）。

| 端点 | 参数 | 响应载荷（信封内 `data`；小驼峰，id 值按 §6.0 换成当前项目 id） |
| --- | --- | --- |
| `GET GetNav` | — | `[{caseId(分类 11 位 id，拍板改造；旧为 Case 码数字), name, navList:[{bookNo(频道 11 位 id), imageUrl, bookName, chengShu, author, caseTag, desc:null, chapterCount:0}]}]`——`desc`/`chapterCount` 旧后端注释掉了恒 null/0，照抄 |
| `GET GetBookChapter` | `bookId`（**当前项目 11 位 channel id**） | `[{bookId, chapterSection, chapterHeader, signatureId}]`——`signatureId` 字段名沿用旧后端（App 解析键），**值 = 篇章条目 11 位 id**（App 端后续把 long 改 String，见 §6.0 #3）；每本书独立，无合并特例 |
| `GET GetChapterContent` | `chapterId`（**篇章 item 的 11 位 id**） | `[{section, header, signatureId(=篇章条目 id), data:[{id(条文 11 位 id), text, note(null 可空), sectionvideo(null 可空), height:0, fangList[]}]}]`；按篇章 id 取其下条文，按 `receiptNo` 排序；条文行内的旧 `signature`/`signatureId` 签名字段已移除 |
| `GET GetBookIdFang` | `bookId`（**当前项目 11 位 channel id**） | `[{yaoCount(字符串), height:"0", name, ID(方剂 11 位 id), drinkNum(字符串), text, fangList[], yaoList[], standardYaoList:[{suffix(null 可空), amount, yaoID(中药 11 位 id 或 null), weight(字符串), showName, extraProcess}]}]`——旧后端把这几个数值字段序列化成字符串，照抄；行内旧 `signature`/`signatureId` 已移除；按源 `FangNo` 排序（`_microfeed.no`） |
| `GET GetAllZhongYao` | — | `[{name, text}]`——**实测只有这两个字段**（spec 初稿的 YaoName/YaoText/AllYaoText/YaoEnum 是错的）；旧按本草书逐本拼接（同名药重复），新为容器频道去重 + 按源 `YaoNo` 排序 |
| `GET GetAliaZhongYao` | — | `[{bieming, name}]`（三源合并，照抄旧后端 `ZhongYaoService.GetAliaZhongYao`：① `yaoAlias` 表 ② 源 `Yao.YaoList` 切分（每 token→药名）③ 源 `BookBody.BieMing` 切分（result[0]=正名，其余→别名）；切分符 `[,,；; 。.、]+`；重复别名后者覆盖前者，处理顺序 ①→②→③；空 token 丢弃） |
| `GET GetAllMingCi` | — | `[{id, mingCiList[], name(源列原样，不 trim), imageUrl, text}]`——`mingCiList` = 源 `MingCiList` 列按英文逗号劈成的数组，空白→`[]`；按源 `MingCiNo` 排序 |
| `GET GetTipsStyleConfig` | `version=0` | `{styles:[{marker, color, isSmallFont, linkType}]}`——**旧后端从未实现此端点**（App 端本地兜底），属新增端点，无 golden 可比。**故意不包信封**：App 的 `StyleConfigApiBean` 直接反序列化顶层 `styles` 字段，且 `RequestHandler` 只对 `HttpData` 类型做信封拆包，所以此处发裸 `{styles}`，否则 App 会拿到 `null`（`code-review` 曾误报为"未包信封的接口规范破坏"，实为 App 契约要求） |
| `POST login` | `LoginInfo` | `{Account, Name, …}` + 签发的 API Key 凭证（**不再有 `AccessKeyId/Secret`**，见 §6.1） |
| `POST replaceToken` | — | 新 Token |
| `GET GetProjectInfo` | — | 字典 `ProjectInfo` |
| `GET GetLoginInfo` | — | 字典 `LoginInfo` |
| `GET getAboutInfo` | — | `[{text, name}]`（配置 `APP_BASE/APP_ABOUT`） |
| `GET getPicCaptcha` | — | 图片验证码 |

### 6.0 id 语义变更（用户拍板：不用源 id，改用当前项目 id）

**响应字段名保持不变**（App 改动最小），但 **id 字段的值全部换成当前项目的 11 位 id**：

| 字段（实测 wire 小驼峰） | 原语义（源系统） | 新语义（当前项目） |
| --- | --- | --- |
| `bookId` | 源 `BookNo`（如 10001） | `channels` 的 11 位 id |
| `data[].id` | 源 `ReceiptNo` | **条文 `items` 的 11 位 id**（另附 `receiptNo` 保留排序语义） |
| `ID`（方剂） | 源响应内行序号（0..n） | 方剂 `items` 的 11 位 id |
| `yaoID` | 源 `YaoId`（`"0"` 表示无对应药） | 中药 `items` 的 11 位 id（无对应药发 `null`） |
| `id`（名词） | 源 `MingCiId` | 名词 `items` 的 11 位 id |

由此三点：

1. **「`bookId==10001` 并上 10002」的合并特例整体取消**——那是源系统把两本书当一本处理的怪癖；迁移后 5 本书各自独立，App 按 channel id 逐本请求。
2. **不设任何源 id 列**：源 int64 主键只在导入脚本内存里用于对账，**不落库**；所有关联（条文→篇章、组成→中药、实体→容器频道、别名→中药）都用当前项目 11 位 id。
3. **源系统的 `Signature` 签名字段整体不要**（用户拍板）；`SignatureId` **字段名保留但值换语义**（用户拍板修正，2026-09-28）：App 全链路用 `signatureId`（Gson long）做章节内容定位键（`DataRepository` 按 SignatureId 查内容 + `SparseArray` 索引），删字段或改名都会让 App 拿不到定位键——后端保留字段名，**值 = 篇章条目 11 位 id**（GetBookChapter / GetChapterContent 两处）；**App 端后续把这些字段从 long 改 String**（签名机制本身已废，11 位 id 无法装入 long，Gson 按 long 解析字符串会抛异常）。

### 6.1 登录：复用现有鉴权与防重放（用户拍板，不移植 AccessKey 体系）

旧后端是「登录下发 `AccessKeyId/AccessKeySecret` → 每请求 HMAC 五段签名 + nonce 防重放」的**第三方开放接口**体系（`openapi/anti-replay-*.md`）。**本项目已有等价能力，不照抄**：

| 旧体系 | 本项目现状 | 适配 |
| --- | --- | --- |
| `AccessKeyId/Secret`（`SysAccessKey`） | `api_keys`（迁移 0006）+ scopes（0018）+ owners（0032），Bearer 形式 | 登录校验通过后**签发现有 API Key**，App 用 `Authorization: Bearer <key>` |
| HMAC 五段签名 | 无此要求 | **不做**，除非后续确认有第三方接入需求 |
| nonce 防重放 | `ext_replay_nonces`（迁移 0030）已在用 | **复用**，零变更 |
| `replaceToken` | better-auth 会话体系 | 复用现有会话刷新 |

- `login` 端点：复用 better-auth 校验账号口令，通过后签发 API Key，返回形状尽量贴近旧响应（`{Account, Name, …}`，不再有 `AccessKeyId/Secret`）。
- `GetProjectInfo` / `GetLoginInfo` / `getAboutInfo`：旧后端来自字典表与配置表，本项目适配到 `settings` 配置存储，对外形状一致。
- `getPicCaptcha`：本项目无图形验证码能力；先确认 App 是否必调，不必调则返回空。
- 仍待确认：`LoginInfo` 的具体字段名（定义在 SimpleAdmin 包内，本仓未包含）。

- `GetNav` 层级：`WorkInfo.ParentId` 13 行全是 `'0'`，照抄会得到 13 个空 tab ⇒ **改用分类**：父 = `ext_category`，子 = 该分类下的 `channels`。
- 缓存：旧后端用 `SimpleCacheService`；Workers 侧用 `caches.default` + `Cache-Control`，key 沿用 `bookid_{id}` 语义。
- `Case` → 分类映射：1=针灸、2=内经类、3=本草、5=伤寒、9=人纪。

### 6.2 golden 逐字段比对结果（工单 15 · 2026-09-28）

工具：`.scratch/tcm-import/golden/capture.mts`（抓取）+ `compare.mts`（分类比对）+ `tests/unit/tcm-golden.test.ts`（回归报警）。
旧后端：`http://192.168.2.158:9991`（需启动）；鉴权 = App 内置默认设备密钥（`SecurityConfig` 硬编码 AccessKeyId/Secret）+ HMAC 五段签名（`{METHOD}\n{host}\n{path}\n{timestampMs}\n{nonce}` → Base64(HMAC-SHA256(·, Secret))）。
固定参数：书 `BookNo=10001`（伤寒论宋版）第一章。

**结果：8 个内容端点全部零 MISMATCH**（`report.json` 有逐条分类）。已知可接受差异分类：

| 分类 | 含义 | 落点 |
| --- | --- | --- |
| known-id | id 值换 11 位新 id（库中存在性已校验） | 全部端点的 id 字段 |
| known-signature-removed | 签名字段移除（含条文项/方剂行内 `signatureId`） | GetChapterContent、GetBookIdFang |
| known-merge | 旧 `bookId==10001` 并上 10002 合并特例（拍板取消） | GetBookChapter（旧 49/新 27）、GetBookIdFang（旧 315/新 113） |
| known-adaptation | 数据模型改造 | GetAllZhongYao 旧 601（本草书×药重复）/新 172（容器去重）；GetNav 分类化 |
| known-order | 成员相同仅顺序（yaoList 旧按组成序；别名插入序） | GetBookIdFang、GetAliaZhongYao |
| known-null-to-empty | 源 `YaoId=0` 哨兵（无对应药）→ `null` | GetBookIdFang.standardYaoList |
| known-data-drift | dump 与旧后端活动库的少量数据出入（dump 为迁移事实源） | 神农本草经疏 chengShu、个别 fangList、别名 ±2 条 |

回归方式：改动 App 端点代码后重跑 `capture.mts` + `compare.mts`，出现任何 MISMATCH 即回退修复；无服务器环境下 `tests/unit/tcm-golden.test.ts` 对 new 快照做信封/字段名/形状断言。

---

## 7. 标记渲染器规格

> **⚠️ 状态（2026-09-28 用户拍板）：已实现但未接入公开管线。** PC Web **暂时原样输出** `$X{}`（`FeedPublicJsonBuilder` 直出原文）；移动端 App 自己渲染（linkType 语义由 `GetTipsStyleConfig` 下发，App 侧 TipsTextRenderer 消费）。渲染器模块 `src/shared/TcmMarkers.ts` 与单测保留，将来 PC 端要上样式时从 §7 的接入点（`FeedPublicJsonBuilder` 的 `content_html` 出口）接回即可。

新文件：`src/shared/TcmMarkers.ts`（运行时中立，不放 `src/server/`）

```ts
export interface TcmMarkerStyle {
  code: string; color: string; smallFont: boolean; linkType: number;
}

/** 递归解析 $X{...}，返回 HTML。未知 marker 退化为纯文本；解析失败绝不丢段。 */
export function renderTcmMarkers(body: string, styles: TcmMarkerStyle[]): string;
```

规则：

1. `\$([a-zA-Z]{1,10})\{` 起始，**递归下钻** content（修掉旧 App 的嵌套 bug）。
2. 输出 `<span class="mf-mk mf-mk-{code}" style="color:#RRGGBB">…</span>`；`smallFont` 加 `font-size:0.7em`。
3. `linkType` 1/2/3 → 外层再包 `<a href="…">`，目标由 `tcm_kind` + 名字索引查得：
   - 1 → 中药条目、`2` → 方剂条目、`3` → 名词条目
4. `$m{{虚者}` 这类**内容以 `{` 开头**的脏数据，不匹配就原样输出。
5. 未知 marker → 去掉 `$x{}` 外壳，输出纯文本（灰色降级）。
6. 只作用于 HTML **文本节点**，不得破坏标签属性。

接入点：`src/shared/BodyFormat.ts` 的 `bodyToHtml()` HTML 分支（编辑器读 `data.description` 原值，不受影响）。CSS 类需进主题/全局样式。

---

## 8. 导入管线

落点：`scripts/import-ctwh/`（**不进 `src/`**）

1. **转译**：MySQL 反引号 → 去掉；`\r\n` / `\'` / `\\` → 真实字符；按 `;` 切分语句并逐条解析 VALUES 元组（注意字符串内的 `;`）。
2. **生成 11 位 id**（`items` / `channels` 主键是 `VARCHAR(11)`）；所有关联按 §5.2 用当前项目 id；**源 int64 主键只在内存中对账，不落库**。
   - ⚠️ **id 必须由 (内容类型 + 源 int64 主键) 确定性推导**（哈希 → base62 截 11 位，碰撞则加盐重算）。因为库里不再存源 id，只有确定性的 id 才能让**重跑覆盖同一批行**——否则二次导入会整库翻倍。
3. **拼 `data` JSON**：`title` / `description`（正文 HTML）/ `image` / `content_format:"html"` / `_microfeed{...}`；`pub_date` 取源 `CreateDate`；`status=1`。
4. **本地验证（小批量先行，用户拍板）**：先写 miniflare 副本（`.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/*.sqlite`）。**先导小批量**——每个 kind 只转前 20 行 + 书 13 本全量，人工与脚本核对（转义/标记/关联/索引命中）**全绿后才放全量**；小批量发现的问题修在脚本里，绝不带病全量。
5. **远程写入**：`wrangler d1 execute --remote --file`，**分批 ≤ 数百 KB**（10MB 单文件必超时）；脚本支持 `--resume`。
   ⚠️ **必须先 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy`**，否则报 `code: 7403`。

---

## 9. 错误处理策略

| 场景 | 行为 |
| --- | --- |
| 未知 `bookId` / `chapterId` | 返回 `[]`（旧后端形状），**不报 404**，避免 App 崩 |
| 参数缺失 / 非数字 | 400 + 稳定错误码 |
| 缓存 miss / D1 异常 | 回源 D1；失败返回 `[]` 并 `console.error` |
| 标记解析异常 | 原样输出原文，**绝不丢段** |
| 导入批次失败 | 记录已写入批次号，支持 `--resume` |
| 11 位 id 冲突 | 确定性推导：同一条源记录必然得到同一 id，重跑覆盖而非新增；推导碰撞加盐重算，上限后报错而非静默覆盖 |

---

## 10. 依赖管理

**不新增 npm 依赖。** 导入脚本用 Node 22 内置能力 + 项目已有的 `tsx`（`node --import tsx`）+ `wrangler d1 execute`。渲染器用纯 TS 字符串解析，不引第三方 HTML 解析器。

> **豁免记录（用户拍板 2026-09-28）**：`scripts/import-ctwh/parse.ts` 手写 MySQL dump 解析器，形式上触及 AGENTS.md「禁止手写 parser 解析成熟文件格式」的绝对规则。**豁免理由**：一次性离线脚本（不进运行时）、node 生态无成熟的 mysqldump 行解析库、换库需重做全量验证；且已有 `verify-fidelity.mts` 全量保真审计（85601 字段逐字段比对 0 不一致）兜底。仅限本脚本豁免，不构成对规则的一般性放宽。

---

## 11. 验证方法

1. **Golden 对比（最强证据）**：从运行中的 .NET 后端抓 8 个端点真实响应，存 `.scratch/tcm-import/golden/*.json`，新端点**逐字段比对形状与内容**。两类已知差异（记录、不照抄）：**id 字段按 §6.0 换成当前项目 id**；旧渲染器把嵌套标记显示成字面文本。
2. **渲染器单测**：嵌套 `$a{$q{}}`、脏括号 `$m{{`、未知 marker、HTML 属性不被误伤、空串。
3. **端点单测**（worker）：每端点 3 例（正常 / 空 / 异常参数）。
4. **数据核对**：导入后 `SELECT tcm_kind, COUNT(*) FROM items GROUP BY tcm_kind` 与源行数一致。
5. **门禁**：`yarn typecheck`、`git diff --check`、`yarn i18n:check`。
6. **存活探针**：curl `/`、`.well-known/microfeed.json`、各 App 端点。

---

## 12. 实施边界

**改动范围**

- 新增迁移 `0070` / `0071` / `0072`
- 新增 `src/shared/TcmMarkers.ts`、`src/shared/Tcm.ts`、`src/server/tcm/*.ts`、`src/pages/api/AppBookRequest/*.ts`
- `src/shared/TcmMarkers.ts` 渲染器**保留但不接入公开管线**（用户拍板：PC 暂时原样输出，App 自渲染）
- 新增 `scripts/import-ctwh/`（不入 `src/`）
- 后台内容列表加 `tcm_kind` 筛选（唯一 UI 改动）

**排除范围**

- 不动 `auth_*` 表、不动 RBAC 决策链
- 不动现有主题文件（`themes/feed-zh/`）与页面模板
- 不动 OpenAPI 契约（`src/shared/OpenApiDocument.ts`）
- 不迁问诊 / AI 对话、不改 Android App 代码
- **不碰生产**：先本地 miniflare，确认后 `d1 export` 备份再写远程

**文档同步**：落地后在 `docs/tcm/` 补三份 ADR（源模型映射 / 端点契约 / 标记协议）。

---

## 13. 实施清单（原子化，按序执行）

1. ✅ 读 .NET 契约并回填第 6 节（`GetBookIdFang`/`GetAliaZhongYao` 形状已实测；`LoginInfo` 字段名在 SimpleAdmin 包内，实施登录端点时读）
2. 从运行中的 .NET 抓 8 个端点 golden 响应 → `.scratch/tcm-import/golden/`（工单 15）
3. ✅ 迁移 `0070`：`items` 加 `tcm_kind` + `tcm_parent_id` + 2 索引（**无源 id 列**）
4. ✅ 迁移 `0071`：`ext_annotation_markers` 加 3 列 + 重种 13 项 + 修正 3 枚 title
5. ✅ 迁移 `0072`：建「针灸」「人纪」两个 `ext_category` 与三个容器频道（方剂 / 本草 / 名词）
6. ✅ `src/shared/TcmMarkers.ts` 渲染器 + 单测 10 例（**按拍板保留、不接入公开管线**）
7. ~~`BodyFormat.ts` 接入点~~ → **已按用户拍板取消**：PC 暂时原样输出标记，App 自渲染
8. ✅ `scripts/import-ctwh/` 转译脚本（确定性 11 位 id、关系按 §16 分流）
9. ✅ 本地 miniflare 导入 + 全量保真审计（85601 字段 0 不一致，见工单 07）
10. 写 `src/server/tcm/` 八个读函数 + `src/pages/api/AppBookRequest/` 路由（含 `login` / `replaceToken`）
11. 与 golden 逐字段 diff + worker 单测
12. 后台内容列表加 `tcm_kind` 筛选
13. `d1 export` 备份 → 分批写远程 D1 → D1 直查 + curl 验证
14. 图片回填（用户提供源文件目录后）
15. 跑完整门禁（`yarn typecheck` / `git diff --check` / `yarn i18n:check`）
16. 写 `docs/tcm/` 三份 ADR

---

## 14. 待补查 / 待提供

> 2026-09-28 更新：源契约已从 .NET 源码查清并回填第 6 节；登录按拍板改为**复用现有鉴权与防重放**（§6.1），不再移植 AccessKey/HMAC 体系。

| # | 项 | 阻塞步骤 |
| --- | --- | --- |
| 1 | `LoginInfo` 的**具体字段名**（定义在 SimpleAdmin 包内，本仓未包含） | 登录工单 |
| 2 | App 登录页是否**必调** `getPicCaptcha` | 登录工单 |
| 3 | 封面图源文件目录（`Upload/Images/...`） | 图片回填 |
| 4 | `Enable` 字段在源系统的真实语义 | 导入（当前策略：全量导入，不过滤） |
| 5 | 后台列表加 `tcm_kind` 筛选的具体 UI 形态 | 列表筛选工单 |

---

## 15. 差异清单与解决方案（原 .NET/Android ↔ 当前项目）

> 逐领域核对两边实现后整理。每一条都是"源系统这么做的 → 本项目现状是这样的 → 因此这样解决"。实现时遇到本表未覆盖的差异，先查本节再动手，新差异回填到这里。

| # | 领域 | 原 .NET / Android 做法 | 当前项目现状 | 解决方案 |
| --- | --- | --- | --- | --- |
| 1 | 存储引擎 | MySQL + SqlSugar（lambda 查询、`Includes` 预载子表） | D1 / SQLite（手写 SQL、`json_extract`） | 导入脚本做方言转译（反引号、`\r\n`/`\'` 反斜杠转义）；端点读函数手写 SQL，子表明细靠口袋内嵌、不做 join |
| 2 | 数据模型 | 8 张关系表 + 硬外键（`FangBody.YaoID → Yao`，源侧全是 int64） | `channels` + `items` + `_microfeed` JSON 口袋（方案 E，§5.2） | 关系内嵌（`fangYaoList[]` / `aliases[]`），**关联一律用当前项目 11 位 id**；源 int64 只在导入脚本内存里消费，**不落库、不设列**（§6.0 第 2 条） |
| 3 | 主键 | 自增 `int` / `long` | `VARCHAR(11)` 随机 id | 导入时生成 11 位 id；**响应字段名不变、id 值全换新**（§6.0）；源 id 不出现在任何响应 |
| 4 | 缓存 | Redis（`SimpleCacheService`，key 如 `bookid_{id}`） | Workers `caches.default` + `Cache-Control` 头 | 端点自带缓存头，key 语义沿用；不引入 Redis/ KV |
| 5 | 鉴权 | `SysAccessKey` ak/sk + HMAC 五段签名 + JWT（`openapi/anti-replay-*.md`） | better-auth + `api_keys` Bearer + `ext_replay_nonces` 防重放（0030 已在用） | **复用**（§6.1）：登录校验后签发现有 API Key；不做 HMAC；防重放零变更；不新建表 |
| 6 | 书籍可见性 | `SysOrg` 组织（`BOOK_PUBLIC` / 私有）+ `IsEnable` 控制导航与方剂查询范围 | `channels.status`（public/headless/offline/passcode） | 源数据无 OrgId ⇒ **全部导入为公开**；组织/私有概念丢弃，不做映射 |
| 7 | 启用标记 | `Enable` / `IsEnable`（`Status.ENABLE` 过滤 everywhere） | `STATUSES`：1 published / 2 unpublished / 3 deleted / 4 unlisted | 映射：书与篇章 → **1**；条文 → **4 unlisted**（不进 web/rss/json feed，但可直链访问、后台可管理，App 端点照读）；**导入时不按 Enable 过滤**（条文表全 0，过滤=一条不剩） |
| 8 | 字典与配置 | `Sys_Dictionary`（`GetVueDictionary`）+ `DevConfig`（`APP_BASE/APP_ABOUT`） | `settings` 表（category + JSON） | 三个配置端点（`GetProjectInfo`/`GetLoginInfo`/`getAboutInfo`）适配到 `settings`，对外形状不变 |
| 9 | 图形验证码 | `getPicCaptcha` 自绘验证码 | 无此能力 | 先确认 App 是否必调；不必调则端点返回空，不阻塞登录链路 |
| 10 | 时间 | MySQL `datetime`（`CreateDate`） | `pub_date` RFC3339（`msToRFC3339`） | `pub_date` = 源 `CreateDate`；展示排序沿用 |
| 11 | 图片 | 本地相对路径 `Upload/Images/...`（无源文件导出） | R2 媒体库 + 永久 `media_url` | 走 `yarn microfeed media upload` 回填；导入期置空，原始路径存 `_microfeed.sourceImagePath` |
| 12 | 标记渲染 | Android `TipsTextRenderer`：正则单遍、**不支持嵌套**（`$a{$q{}}` 渲染成字面文本）、SpannableString | 公开站**完全不解析**标记（`bodyToHtml` 原样透传） | **PC 暂时原样输出（用户拍板 2026-09-28）**；递归渲染器已实现保留（§7），App 端自渲染、样式由 `GetTipsStyleConfig` 下发；golden 比对时"嵌套字面文本"与"签名字段移除"同属已知差异 |
| 13 | 内容审核 / 审计 / webhook | 无 | `ext_content_review` + `ext_content_audit` + webhook 发射 | **后台编辑条文走既有审核流与审计，保留不关**；批量导入直写 D1 **有意绕过** webhook/审计（一次性、可重跑，符合预期） |
| 14 | 分页 | `HttpListData` 分页封装 | 现有端点多为全量返回 | 维持全量（中药 172 / 方剂 804 量级小）；书目录列表按篇章序号全量返回 |
| 15 | API 框架 | ASP.NET Controller（返回 `dynamic` / `IActionResult`） | Astro 路由（`src/pages/api/**`）+ `jsonResponse` | 路径 1:1（`/api/AppBookRequest/*`），GET/POST 方法对齐；**不进 OpenAPI 契约**（App 专用，非公共 API） |
| 16 | 问诊 / AI | `WenZhen` 四表 + `AiConfigService` 流式会话 | 无对应能力 | **不迁**（已拍板）；范围内仅典籍 / 方剂 / 中药 / 名词 |
| 17 | 搜索 | 无 | 全站搜索（items 索引） | 条文 unlisted 后是否进搜索需实测；**进搜索是增益**（读者可搜条文），不做屏蔽 |
| 18 | 权限体系 | 后台用 VOL 框架菜单/角色；App 端点全匿名 | RBAC（`ext_roles` / `ext_permissions`），内容编辑需 `content:*:*` 码 | App 读端点保持匿名（与源一致）；后台管理条文复用现有 `content:chapter:*` 守卫，**不新增权限码** |

---

## 16. 关系模型与索引策略（实现前确认 · 2026-09-28）

> 本节的用途：转译脚本动手前，先把「谁和谁有关系、关系存在哪里、哪个索引支撑」一次说清，避免实现时关系混乱或退化成全表扫描。

### 16.1 关系清单 —— 每条关系只有一个载体

| # | 关系 | 载体 | 索引 | 谁在用 |
| --- | --- | --- | --- | --- |
| 1 | 典籍频道 → 篇章 | `items._microfeed.bookId` → 镜像进 `items.book_id` | `book_id`（已有） | 主题书页目录、`GetBookChapter` |
| 2 | **篇章 → 条文** | `items.tcm_parent_id` **列** | `items_tcm_kind_parent`（本次新增） | `GetChapterContent` |
| 3 | 典籍频道 → 方剂 | `items._microfeed.bookId` → `book_id` | `book_id` | `GetBookIdFang`、主题 |
| 4 | 方剂 → 药味明细 | **内嵌** `_microfeed.fangYaoList[].yaoId`（中药条目 id） | 无（随方剂一次读出） | `GetBookIdFang.standardYaoList` |
| 5 | 中药 → 别名 | **内嵌** `_microfeed.aliases[]` | 无 | `GetAliaZhongYao` |
| 6 | 容器频道 → 方剂 / 中药 / 名词 | `items._microfeed.bookId` → `book_id` | `book_id` | 主题、`GetAllZhongYao` / `GetAllMingCi` |
| 7 | 标记 → 实体条目（点药名跳转） | 名字 → `(tcm_kind, title)` | `items_tcm_kind_name`（新增） | 渲染器 linkType 1/2/3 |
| 8 | 分类 → 书 | `channels._microfeed.genre` = 分类 id（既有约定） | `channels_genre`（已有） | `GetNav`、分类页 |

### 16.2 三条不变量（防止关系混乱）

1. **一个关系只有一个载体**：频道归属**永远**走 `_microfeed.bookId`（保存时自动镜像到 `book_id` 列）；父子条目层级**永远**走 `tcm_parent_id` 列。禁止同一关系两处写。
2. **`tcm_parent_id` 只用于「父子条目」这一种语义**，目前唯一的用例是条文 → 篇章。频道关系不许用它（否则与 `book_id` 重复、且会污染 novel-cms 的「某书的章节」查询）。
3. **源 int64 不落库**：只在脚本内存里做映射与对账；长整数字段只允许是**排序序号**（`section` 章序号、`receiptNo` 节序号），不是关联。

### 16.3 每个端点的查询形态（逐条都走索引，无全表扫描）

| 端点 | 查询 | 命中的索引 |
| --- | --- | --- |
| `GetBookChapter(bookId)` | `WHERE tcm_kind='chapter' AND book_id=?` | `book_id` |
| `GetChapterContent(bookId, chapterId)` | `WHERE tcm_kind='section' AND tcm_parent_id=?` | `items_tcm_kind_parent` |
| `GetBookIdFang(bookId)` | `WHERE tcm_kind='fang' AND json_extract(data,'$._microfeed.sourceBookId')=?` | `items_tcm_kind_name` 最左前缀（`tcm_kind` 范围扫描后 JSON 过滤）。**原因**：方剂的 `book_id` 是容器频道而非来源典籍，字面 `book_id=?` 无法按来源书拆分；候选集仅 804 行，可接受 |
| `GetAllZhongYao()` | `WHERE tcm_kind='yao'`（可按容器频道再收窄） | `items_tcm_kind_name` 最左前缀 |
| `GetAllMingCi()` | `WHERE tcm_kind='term'` | 同上 |
| `GetAliaZhongYao()` | `WHERE tcm_kind='yao'` 全量 + `WHERE tcm_kind='section' AND json_extract(data,'$._microfeed.bieMing')!=''`（条文第三源过滤） | 最左前缀 + JSON 过滤（与旧后端全表扫描同级，App 全量同步场景） |
| `GetNav()` | 分类 → 该分类下已发布 `channels` | `channels_genre` + `channels_status` |
| `GetTipsStyleConfig()` | `ext_annotation_markers` 全表 13 行 | 无需（表极小） |

> 排序说明：条文按 `receiptNo`、篇章按 `section` 排序，二者是口袋里的**序号**而非关联；单章/单书的候选集只有几十到几百行，索引取回后内存排序即可，不必为排序再建表达式索引。

---

## 决策记录（ADR）

本迁移有三个"以后一定会再问一遍"的决定，已沉淀为独立 ADR，与本文档互相引用、不重复维护同一事实：

- [ADR-01 源模型映射](./adr-01-source-model.md) — 为什么不建表、`tcm_kind`/`tcm_parent_id` 两列索引列的取舍、派生关系与源 int64 不落库。
- [ADR-02 App 端点契约](./adr-02-endpoint-contract.md) — 响应形状来源、两处反直觉特例（`GetTipsStyleConfig` 不包信封、`GetBookIdFang` 按 `sourceBookId` 过滤）、golden 比对策略。
- [ADR-03 标记协议](./adr-03-marker-protocol.md) — 13 枚标记的语义/配色/`linkType`、嵌套与脏括号两个坑、当前渲染状态。
