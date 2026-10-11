# ADR-0013: 响应式断点体系

## 状态

已采纳

## 背景

`feed-zh` 主题在多个页面使用了 **6 个不同断点值**（`400px`, `480px`, `600px`, `768px`, `800px`, `900px`），而代码注释引用 `ADR-0013` 声明断点为 "site-wide 768px"，但实际只有 1/6 个断点符合。`default` 主题独立使用 `600px`。这种碎片化导致：

1. 新增页面无法判断该用哪个断点
2. 相邻页面在 600-800px 窗口出现布局不连续
3. ADR-0013 本身不存在，决策依据断裂

## 决策

采用 **2 个断点**（1 个全局 + 1 个网格专属）：

| 断点 | 命名 | 含义 |
|------|------|------|
| `768px` | 全局 | 移动/桌面分界。≤768px 为移动层，≥768px 为桌面层。 |
| `1024px` | 网格专属 | 仅用于首页 `.mf-home-grid` 的 2→3 列切换。 |

> `1280px` 原计划作为桌面增强断点，当前未启用（无页面依赖它）。待未来有 3→4 列需求时再加。

### 各页面网格列数规则

| 页面 | ≤768px | 768–1024px | >1024px |
|------|--------|------------|---------|
| 首页 `.mf-home-grid` | 1 列 | 2 列 | 3 列 |
| 书详情 `.mf-book-header-card` | 1 列 | 2 列 | 3 列 |
| 书库 `.mf-library-grid` | 1 列 | 3 列 | 3 列 |
| 书首页 `.mf-book-hero` | 1 列 | 2 列 | 2 列 |

> 书详情 `.mf-book-header-card` 基础样式为 3 列，无 1024px 中间态。书库 `.mf-library-grid` 基础样式为 3 列，≤768px 降为 1 列。

### 导航栏行为

导航栏（`.fq-header`）在 `768px` 折叠搜索框为图标按钮，不保留 `600px` 独立断点。

### 阅读器工具栏

阅读器工具栏（`.mf-reader-tools`）在 `768px` 从固定右栏切换为底部横条。

### 管理后台

管理后台（`/admin/*`）**不做移动端响应式适配**。管理操作仅在 PC 端提供。

## 后果

### 正面

- 新增页面只需判断"移动层/桌面层"，无需猜测中间断点
- ADR-0013 作为唯一事实来源，消除注释与代码不一致
- 6 个断点值收敛为 1 个全局 + 1 个网格专属，维护成本降低 67%
- `.mf-detail-chapter-grid` 原 768px 两列 + 400px 单列的三级断点简化为 768px 单列（消除 400px 冗余）

### 负面

- `600–768px` 窗口（如 iPad 竖屏）导航栏不再单独折叠搜索框，间距稍紧
- 首页 `900px` 的 3→2 列中间态改为 `1024px`，600–900px 的平板从 1 列跳为 2 列
- `.mf-detail-chapter-grid` 在 768–400px 窗口由两列降为单列（原 400px 断点被消除）

### 迁移范围

- `themes/default/src/theme.css`：`600px` → `768px`（2 处）
- `themes/default/src/main.ts`：`matchMedia("(max-width: 600px)")` → `768px`
- `themes/feed-zh/web-header.mustache`：自定义 CSS 中 `480px`, `800px`, `400px`, `600px` → `768px`
- `themes/feed-zh/web-home.mustache`：`900px` → `1024px`
- `themes/default/web-header.mustache`、`themes/feed-zh/web-header.mustache`：编译输出同步

## 与 ADR 的关联

本 ADR 被以下代码注释引用：

- `themes/feed-zh/web-header.mustache`（第 5、789、1275 行）
- `themes/feed-zh/web-home.mustache`（第 2 行）
- `themes/feed-zh/web-header.mustache` 中 `--mf-page-bg` 与 `--mf-background` 的表面区分由 ADR-0010（设计 token 统一）定义；断点体系由本 ADR（ADR-0013）定义
