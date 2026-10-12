# ADR-0019: 版本强制使用整数码而非语义化版本

**状态**: 已接受
**日期**: 2026-09-20
**来源**: 提升自 `.scratch/microfeed-rbac/adr/0002-version-enforcement-integer-code.md`
**关联**: `0020` `0021` `0022`

## 背景

微阅读 Android 客户端需要"最低版本强制"机制：当服务端检测到客户端版本过低时返回 `MIN_VERSION_ENFORCED`（1006），引导 App 弹升级提示。

## 决策

- 采用整数码 `int` 作为版本号字段（如 `10102` = 1.0.10.2）
- 放弃语义化版本字符串 `"1.0.10.2"`
- App 端与后端均按 `int` 类型比较

## 理由

- App 端用 Kotlin/Java `int` 类型，语义化字符串需额外解析
- 整数码比较 `10102 < 10103` 语义清晰，无版本比较库依赖
- 与 `versionCode`（APK 构建码）区分：`versionCode` 是构建序列，`versionInt` 是产品版本

## 后果

- App 发版时人工保证整数码递增
- 后端比较用 `<` 即可，无需引入 semver 库
