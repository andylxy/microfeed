---
name: app-feature-delivery
description: 给 Android App（run.yigou.gxzy + microfeed 后端）新增一个「后端主动下发」类功能的端到端流程：DESIGN 锁决策 → to-tickets 垂直切片 → 逐票实现 → adb × 本地后端联调（logcat 驱动修复）→ 双轴 code-review → 安全提交。以「公告/消息通知」为完整范例。This skill should be used when the user asks to 给 App 加新功能/消息通知/公告/推送/运营位，或要在真机上验证 App 与后端的联动（联调、adb 验证、logcat 排查），或怀疑 App 侧「静默失败/弹窗时序/已读去重」类问题。
agent_created: true
---

# App 端到端功能交付

适用于「后端建表 → 公开只读端点 → 运营管理页 → App 拉取并展示」这一类功能。
公告功能（`.scratch/app-announcements/`）是已走通的范例，工单编号 01–07 可作对照。

## 流程与顺序

```
DESIGN.md  ── 锁决策（§8 决策表 D1–D6、§2 不变量 INV-1..5）
   ↓ /to-tickets
垂直切片票（后端 4 + Android 2 + 联调 1），票间写明阻塞边
   ↓ 逐票实现，每票各自跑门禁
   ↓ 联调：adb × 本地后端，logcat 驱动修复循环   ← 真 bug 只在这里暴露
   ↓ /code-review（双轴并行）
   ↓ 安全提交（见 safe-git-commit 技能）
```

**顺序背后的理由**：权限码必须先落库，后续每票的 `requireRbac` 才成立；数据层先于端点，
端点才能有东西可返回；Android 的纯逻辑先于 UI，UI 才能接上确定的行为。

## 后端四票

| 票 | 内容 | 关键点 |
|---|---|---|
| 01 | 迁移：业务表 + 索引 | 附 `PERMISSION_CODES` 同步 |
| 03 | 权限 + 菜单（**三处镜像**） | `src/shared/Constants.ts` 的 `PERMISSION_CODES` + `src/server/rbac/seed.ts` + `migrations/00xx_*_permissions.sql`（`ext_permissions` 行与菜单行）。三处漏一处就 403 或菜单不出现。`ext_permissions.id` 用 `permissionId()` 推导，手写 id 会让 `bootstrapAdmin` 500 |
| 02 | 公开端点 | 匿名、`no-store`、不写登录日志；与 `updateAt` 无关的字段别下发 |
| 04 | 管理后台页 | 列表 + AJAX + 表单；读/写权限分离，页面只按 `:read` 把关 |

门店闸门由 `tests/unit/admin-page-guards.test.ts` 与 `admin-endpoint-guards.test.ts` 守着
（菜单行码 = 页面 guard 码；所有端点必须有 guard），改动后必须跑。

## Android 两票

- **数据层**（05）：model（纯响应，只读无 setter）+ api + 落盘 store + 挑选/排序逻辑。
  **把纯逻辑与 Android 依赖彻底分开**，否则无法 JVM 单测（见下方坑表）。
- **UI + Manager**（06）：弹窗 + Manager + 接线 + 与其他弹窗的协调。

## 联调手册（这一段是本技能的核心）

### 后端侧

```bash
cd D:/git/AiCode/microfeed
export CODEBUDDY_SAFE_DELETE_ENABLED=0
CFG=".microfeed/instances/ctwh-881019-xyz/wrangler.jsonc"
PERSIST=".microfeed/instances/ctwh-881019-xyz/local-state"   # ← 漏掉它会「迁移成功但服务仍 500」
./node_modules/.bin/wrangler d1 migrations apply FEED_DB --local --config "$CFG" --persist-to "$PERSIST"
./node_modules/.bin/wrangler d1 execute FEED_DB --local --config "$CFG" --persist-to "$PERSIST" --command "SELECT 1;"
curl -s --noproxy '*' http://192.168.2.158:4321/api/<endpoint>
```

- dev server 由**别的进程**提供（`192.168.2.158:4321`），不要动它。
- 查活必须 `unset HTTP_PROXY …` + `--noproxy '*'`，否则 502 假象。
- 迁移默认写到 `<实例>/.wrangler/state`，而 dev server 用 `local-state` → 必须显式
  `--persist-to`。用 `node:sqlite` 直读两边 sqlite 可确认表到底建在哪。

### Android 侧

```bash
cd D:/git/app/AndroidProject-old
export ANDROID_HOME="D:\\Program Files\\Android\\Sdk"
ADB="/d/Program Files/Android/Sdk/platform-tools/adb.exe"
PKG="run.yigou.gxzy.debug"          # applicationIdSuffix '.debug'
./gradlew.bat :app:assembleDebug -PServerType=test
"$ADB" install -r -t build/app/outputs/apk/debug/AndroidProject-old_v1.5_debug.apk
```

- APK 输出在 **`build/app/outputs/apk/debug/`**，不是 `app/build/outputs`。
- **LeakCanary 会抢占 LAUNCHER**（debug 包、多次安装后常见，`monkey` 常停在
  `LeakLauncherActivity`）→ 改用
  `"$ADB" shell am start -n "$PKG/run.yigou.gxzy.ui.main.SplashActivity"`。
- `pm clear` 会把 App 弹到 `PermissionGuideActivity` 并清掉 MMKV；测「已读记忆」正好用它重置。

### 观察手段

```bash
"$ADB" logcat -c
"$ADB" logcat -d | grep -aE "AnnouncementManager|AppModalGate|UpdateManager|FATAL"
"$ADB" shell uiautomator dump /sdcard/x.xml        # 不要 adb pull（模拟器上会失败）
"$ADB" shell cat /sdcard/x.xml | grep -aoE 'text="[^"]*"'
"$ADB" exec-out screencap -p > shot.png
"$ADB" exec-out run-as "$PKG" cat files/mmkv/<mmkv-id>   # 读 App 私有落盘状态
```

**`run-as … cat` 是验证「已读记忆」的利器**：把 MMKV 里的键值打出来，直接确认
`{"1":1,"2":1}` 这类状态是否与预期一致——本轮正是靠它发现「三条全被记已读」。

### logcat 驱动修复循环（本轮靠它找出 3 个真 bug）

真 bug 不会在编译期或单测里出现，它们只在真机时序里暴露。做法是：
造场景 → 跑 → 读 logcat → 定位 → 改 → 重装重跑。三个实例：

1. `宿主不是 LifecycleOwner，跳过公告拉取` —— 冷启动首个前台回调拿到的 Activity 常不是
   `LifecycleOwner`。若代码是「先置一次性闸门、再判宿主」，这次机会就被烧掉，
   **本次启动永远不再拉取**。修法：先判宿主再置位，并让 `registerActivityResumeCallback`
   也作为触发点（resume 必带可用宿主）。
2. `无可用宿主，公告留队等待下次机会` —— 队列若只等「下次机会」而没有任何后续触发点，
   消息就丢了。修法：resume 回调驱动重试 + 单飞标志防重复排队。
3. **`seen_map` 变成 `{"1":1,"2":1,"3":1}`，但用户一条都没点过** —— Activity 切换把 Dialog
   拆掉，`dismiss()` 覆写照样触发 onClose → 未读消息被永久记为已读。
   修法：Dialog 内用 `mUserClosed` 区分「用户主动关闭（按钮/返回键/点外部）」与「宿主销毁」，
   只有前者回调 onClose；Manager 侧宿主销毁时把条目**放回队首**。

### 「同一条连弹 N 次」先怀疑自己的 tap 坐标（本轮白烧半小时）

现象：logcat 反复出现「宿主销毁 → 放回队列 → 重弹同一条」，看起来像死循环。
**先别改代码**——本次的根因是 `adb shell input tap` 用了**渲染图坐标**。
`exec-out screencap` 出的 PNG 是 486×1080，设备实际 **1080×2400**（缩放 2.222×），
按钮在渲染图 y≈632，设备坐标是 **y≈1404**。点 604 落在正文区，点不到按钮，
弹窗不关 → 被系统当作宿主销毁 → 放回队列 → 重弹。

判据：**截图 → 按 `渲染尺寸/实际尺寸` 换算 → 再点**。
另：模拟器上 `uiautomator dump` 可能干脆不生成文件（`/sdcard/x.xml` 不存在），
此时读到的「bounds」其实来自更早的旧 dump，会误导好几轮。取真实位置优先用截图量。

### 怀疑代码 bug 时先加探针，别在代码里空转

一行 `EasyLog.print` 就能把「猜测」变成「事实」。本次两轮排查：
先加探针证明 listener 确实没被调用，才定位到是 tap 坐标错；
改完接线再加探针，确认真的通了。**没有探针时很容易改错地方还以为是框架问题。**

### BaseDialog 点击接线：单参数重载是空实现

`setOnClickListener(View...)` 走 `ClickAction` 的 default 方法，它把 `this` 当
`View.OnClickListener`，而 `onClick(View)` 在**接口里是 default 空实现** ——
Java 派发到接口方法，**不走子类覆写**。必须用带 listener 的重载：

```java
setOnClickListener(new View.OnClickListener() {
    @Override public void onClick(View view) { onCloseViewClicked(); }
}, mCloseView);
```

## 坑表（按类别，都是实际踩过的）

**纯逻辑可测性**
- 类里调 `EasyLog` 就无法 JVM 单测（`android.util.Log not mocked`）。状态机类要单测就别打日志，
  日志放调用点。
- **同名重载陷阱**：`isSeen(Integer,int)`（纯）与 `isSeen(int,int)`（走 MMKV）并存时，
  调用方写 `isSeen(1, 1)` 会静态绑定到后者 → 单测崩。改名 `isSeenVersion` 解决。
- 判定要能注入（`SeenFilter` 之类），否则选择逻辑离线测不了。
- **方法内取 MMKV，不要静态字段 / Holder**：静态初始化先于任何调用执行，
  而 MMKV 需要 native 库，JVM 单测一触发就 `UnsatisfiedLinkError`。

**Android 框架 API**
- `IRequestApi` **没有** `getMethod()`（既有 `UpdateApi` 不写 `@Override` 正是因此）。
- `BaseDialog.Builder` 没有 `cancel()` / `setOnCancelListener`，只有
  `addOnCancelListener(BaseDialog.OnCancelListener)`。
- `setOnClickListener(View...)` 的 `onClick(View)` 是接口 default 空实现，见上面接线那段。
- 卸载 LeakCanary 噪声见 `6ba7305` 提交。

**并发与生命周期**
- 一次性闸门：**先判宿主、再置位**，失败不消耗机会。
- `release()` 必须**先**把 `showing=false` 再执行补弹任务，否则补弹里的 `tryAcquire`
  被自己刚放开的闸门挡回去 → 永久自锁。
- 弹窗协调不能只靠各自的 `AtomicBoolean`（互不相识，跨 Manager 就失效），要有一份共享认知。
- 闸门释放事件要能被订阅：某条提示若走「置 pending 标志 + 等 resume 补弹」，
  而另一个弹窗在屏时**不会产生 resume**，那条提示就永远等不到。
- **退避重试必须单飞**：多条失败分支各自排 `postDelayed`，之后每轮失败再加倍 → 无限膨胀。
  另：重试到点时宿主可能不可用（App 在后台），此时必须**再排下一次**并把链续上，
  否则整条链终止、只能等下次冷启动。判定顺序要**先节流后宿主**——先判宿主会
  在「节流已放行但无宿主」时白白丢掉这次机会。

**数据与时区**
- D1 的 INTEGER 列标成 TS 联合类型是**假类型**（编译器无法校验），用 `number` + 真守卫。
- `datetime-local` 转毫秒要用 `new Date(local)`，不能用 `Date.parse`（后者按 UTC 解析，
  东八区会整体偏移 8 小时，且不报错，只会让公告在该弹的时候不弹）。
- 「每天一次」按**本地自然日**判定（年 + 年内第几天）时，**跨日优先于失败退避**：
  23:55 成功、00:20 打开时距上次尝试只有 25 分钟，若先判退避就与「超过 23:59:59
  就算第二天」冲突。判定顺序：先问「是不是新的一天」，是则放行，再判退避。
- **时钟回拨**（用户把系统时间往前调）会让「距上次 < 间隔」恒为真 → 永久饿死拉取。
  两道规则都要放行 `now < lastXxx`；自然日判定天然覆盖其中一道。
- 造带换行的测试数据时 `wrangler d1 execute --command "...\n..."` 里的 `\n`
  **不会**变成换行（shell 与 SQL 都不解释），存进去的是字面反斜杠+n。用 `char(10)`。

**门禁盲区**
- `yarn lint:openapi` 只校验文档自身形状，**不检查路由是否漏注册** → 漏注册不会红门禁。
- `yarn check` 不含 `yarn test`；且 Android 全量 `clean` 会杀掉 Gradle 守护进程，
  只跑定向 `:app:testDebugUnitTest --tests ...`。
- **`git diff --check` 必须放在全部编辑之后跑**。跑一次就当全绿会漏：本轮评审报出
  4 处 trailing whitespace，而我此前每次都跑过且 CLEAN——因为那些编辑发生在
  上一次检查之后。
- 注释里写「提取出来便于单测」时，确认真的**有测试引用它**；grep 一下。
  没有就是注释失真（评审会当硬违规报），不是「顺手一提」。

## 完成判据

- 后端：`yarn typecheck` 0 error、`yarn i18n:check` 通过、`git diff --check` 无输出、
  新增测试 + `admin-page-guards` / `admin-endpoint-guards` / `admin-menu` 全绿。
- Android：定向单测绿、`:app:assembleDebug -PServerType=test` 成功。
- 真机：多条目按优先级逐条弹出、已读不重弹、内容改动后重弹、失败全程静默、强制升级等
  阻断性弹窗不被本功能挤掉。
- 联调数据清理干净（造的公告、抬高的地板要还原）。
