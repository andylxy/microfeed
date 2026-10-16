# ADR-0028: 标注标记的两端口径与 App 侧配置链路

- 状态：Accepted
- 日期：2026-10-16
- 决策人：用户 + 设计评审
- 关联设计：ADR-0012（物化 + 触发器失效）、ADR-0025（卷按需读取）、ADR-0016（公开读路径缓存 TTL）
- 本次实测：adb 联调（`emulator-5554`，`run.yigou.gxzy.debug`）、`docs/novel-cms/xinghe-book-structure.md` 之外的相关源码
- 关联迁移：0117（title 去前缀）、0118（DROP COLUMN multi）

## 背景

标注标记（`$X{…}`）是中医正文里的行内语义：`$f{桂枝汤}` 是方剂、`$u{桂枝}` 是中药、`$g{…}` 是名词解释，
另有 `$a` 按语 / `$w` 剂量 / `$m` 强调等纯样式码。目录存在 `ext_annotation_markers`，由后台
`/admin/annotation-markers/` 维护，web 与 App 各自消费。

2026-10-16 的联调（web 侧改造 + App 侧 ADB 实测）暴露出**两端口径不一致**与**App 侧配置链路长期空转**
两件事。两者都难回头、且后人一定会问「为什么两边不一样」，故立此 ADR。

## 决策

### D1：`linkType 3`（名词）在两端口径**不同**，且明确保留

| | linkType 1（中药） | linkType 2（方剂） | **linkType 3（名词）** |
|---|---|---|---|
| web 公开页 | 链接到 `/i/<id>/` + 弹层 | 链接 + 弹层 | **只上色，不生成链接、不进弹层** |
| App | 点击 → 中药弹窗 | 点击 → 方剂弹窗 | **点击 → 名词弹窗**（`ContentTypes.MING_CI = 3`） |

web 侧的判据是「linkType > 0 才有 `data-tcm-kind`，但只有 1/2 能解析出 href」（`src/server/tcm/markerPopover.ts`）。
App 侧的判据是「**linkType ≠ 0 就挂点击**」（`TipsTextRenderer`），把 linkType 直接当 contentType 路由到
`TipsClickHandler`，3 → `searchMingCiContent` → 名词弹窗。

**保留分叉的理由**：两端的**数据源不同**。App 有 `GetAllMingCi` 全量名词表（`GlobalDataHolder` 内存持有），
web 公开页没有等价物。硬统一只有两条路，都不可取：
- 统一到 App 语义 ⇒ web 要新造一条名词数据管道（新端点 + 新索引 + 新缓存），为一个只有 App 在用的功能付全价；
- 统一到 web 语义 ⇒ 把 App 现网的 `$g` 点击**砍掉**，是功能倒退。

### D2：App 的「加码即生效」必须真的成立，靠**两道修复**而非一个开关

原以为只差 `enableStyleConfig` 一个默认值。实测证明是**两道锁叠在一起**：

1. `AppApplication.enableStyleConfig` 恒为 `false`，全仓无处置 `true` ⇒ `AppStyleConfigProvider.loadConfig()`
   第一行就 `return false`，服务端样式根本拉不下来。
2. **更隐蔽的一道**：`AppStyleConfigProvider.loadCacheConfig()` 原来返回 `boolean`，而**两条分支都返回 `true`**
   —— 命中缓存 `true`，「无缓存 → 加载内置默认值」**也** `true`。调用方
   `HomeFragment.loadStyleConfig()` 于是把「回落默认值」当成「缓存命中」，直接不再请求后端。
   日志还一直在说谎：无论哪条路径都打「样式配置已从缓存加载（不请求后端）」。

⇒ 决策：`loadCacheConfig()` 改为返回三态 `CacheState {HIT, MISS, FAILED}`，调用方只有 `HIT` 才跳过请求；
`MISS` / `FAILED` 都要去请求后端（有内置默认值兜底，失败不致命）。

### D3：配置版本号由**服务端**下发，客户端落盘并比较

`version` = `ext_annotation_markers` 的 `MAX(updated_at_ms)`，即「目录最后一次被**新增或编辑**的时间」，
随 `GetTipsStyleConfig` 与样式目录一起下发。App 把它连同缓存一起落盘（`StyleConfigCache {version, configs}`）。

**已知边界**：**删除**一个标记不会推高这个版本号（`DELETE` 不碰任何行的 `updated_at_ms`）
⇒ 删除在 App 端不可见，只有新增/编辑会触发客户端刷新。要补得让删除也写一个时间戳，
代价大于收益，故按文档措辞处理（评审第 11 轮）。

**同时作废一个假语义**：请求参数里的 `version` 是 App 本地自增计数器，服务端既不读也不回；
App 侧 `StyleConfigApi` 的类注释曾宣称「版本控制（增量更新）」—— 那是**假的**，已改写。

### D4：`GetTipsStyleConfig` 与其余 App 端点**同形**（走 `{code, data, msg}` 信封）

该端点曾按「旧后端从未实现它、App 用本地兜底」的注释发**裸** `{styles:[...]}`。
但 App 的声明是 `HttpCallback<HttpData<StyleConfigApiBean>>` —— 它要信封、会拆包。两边对不上，
联调实测 `Http request fail`。改为 `appEnvelope({styles, version})`。

## 备选与为什么没选

- **只改 `enableStyleConfig` 就宣布完成**：不成立。第二道锁（`loadCacheConfig` 的布尔）会让请求永不触发，
  开关打开也没用 —— 这正是本次联调第一轮就撞到的。
- **App 端为小字号比例另发一次版**（`smallFontScale`）：服务端**一直**在下发这个字段，是 App 的
  `StyleItem` 没有它、`TipsTextRenderer` 硬编码 `0.7f`。加字段即可，不需要新协议。
- **给 web 也做名词弹层**：见 D1，数据源不存在。

## 实测数据（2026-10-16，`emulator-5554`）

- `GET /api/AppBookRequest/GetTipsStyleConfig/`（带 App 的 `mflc_` Bearer）→ **200**，
  `{"code":200,"data":{"styles":[…15 条…],"version":1791945231000}}`；`smallFontScale` 一直在其中。
- **首次启动（无缓存）**：`无样式配置缓存，使用默认配置（HomeFragment 会去请求后端）`
  → `已触发样式配置加载（从后端）` → 请求发出且不失败 → **`files/style_config_cache` 生成（655 字节）**
  （该文件在修复前从未出现过 —— `StyleConfig` 没实现 `Serializable`，写盘必然抛 `NotSerializableException`，
  被 `catch` 只打日志）。
- **第二次启动（有缓存）**：`样式配置已从缓存加载` → `不请求后端` → `StyleConfigApi` 请求计数 **0**，无异常。

## 后果

- **正面**：后台 `/admin/annotation-markers/` 新增一个标记，App 下次启动即可拿到（不需要发版）；
  web 侧同理（`MARKER_CODE_BODY` 单一来源 + `extractMarkerNames` 按表推导可链接码）。
- **代价**：App 每次冷启动一次 `GetTipsStyleConfig` 请求（15 行量级）。命中缓存时这次请求是**后台校验**：
  服务端版本号没变则既不重新应用、也不重写缓存，只有版本变了才落盘。
- **已知不一致，需长期记住**：`linkType 3` 两端口径不同（D1）；App 端 `smallFontScale` 缺失时回落 `0.7`
  （与老包一致），web 端可在 0.3–1.0 内配置。
- **回归保护**：`tests/unit/tcm-markers.test.ts`（码语法与解析器一致）、
  `tests/unit/server/tcm-marker-popover.test.ts`（非 `f`/`u` 的可链接码）、
  `tests/worker/annotation-markers.test.ts`（迁移 0117/0118 对真实库的效果）。

## 事后修正（同日，代码评审发现）

第一版实现漏了 D3 的**比较**那一半：版本号只落盘、从不读（`serverVersion` 是死字段），
`HomeFragment` 在 `HIT` 上直接返回 ⇒ 缓存一旦存在就永远命中，**后台新增的标记永远到不了 App**，
本 ADR 那句「下次启动即可拿到」当时是假的。已补：`loadConfig()` 拿到响应后先比版本，
相同则跳过应用与落盘；`HomeFragment` 两条路都发请求（命中缓存时是后台校验）。
上面「实测数据」里那条「第二次启动请求计数 0」正是暴露这个缺口的现象，保留原文以记录发现过程。
