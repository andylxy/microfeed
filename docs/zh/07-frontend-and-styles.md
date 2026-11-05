---
title: 07 前端组件与交互样式
description: microfeed 前端组件规范（shadcn/ui、cn、渐进迁移）与交互样式（指针/禁用光标）。
---

# 07 前端组件与交互样式

> **用途**：新增或大改前端界面时遵循组件与交互规范。
> **触发词**：前端、组件、UI、shadcn、样式、光标、禁用、无障碍、组件库、分组树、AdminGroupTree。
> **加载时机**：改动 `src/components/**`、`src/pages/**/*.astro` 或全局样式时读取本册。

- 新前端工作或大幅修订既有界面时，优先用 `src/components/ui/` 里仓库自有的 shadcn/ui 组件。
- 当 shadcn/ui 提供时，一律使用 `components.json` 里选定的 Base UI 变体；优先扩展共享 shadcn/ui 组件，而不是新建一次性控件或引入另一个基础组件库。
- 用共享组件与设计令牌组合界面，用 `cn` 辅助函数合并类名；保留 Base UI 提供的无障碍行为。
- 只在**已经在改**的遗留界面**渐进式**迁移到 shadcn/ui；不要为了采用 shadcn/ui 而重写无关的可用屏幕。
- 每个启用的可点击控件都必须用 `pointer` 光标：链接、按钮、单选、复选、开关，以及带 `role="button"` / `role="switch"` 的自定义控件。
- 优先在全局样式表里统一强制共享交互行为，而不是在各组件里重复 cursor 工具类。
- 禁用控件必须用原生 `disabled` 属性或 `aria-disabled="true"`，并显示 `not-allowed` 光标而非 pointer。

## 管理后台卡片间距范式（参考 `/admin/items/new/`）

管理后台所有表单页面的卡片容器、区块标题、字段网格、语义分组分隔**共用同一套 Tailwind class**，
参考源是 `/admin/items/new/`（`src/components/admin/items/EditItemApp/index.tsx`）。
新页面或改既有表单时直接照此执行，不再各页自创间距。

| 用途 | class | 说明 |
|---|---|---|
| **卡片容器** | `rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs` | 全局唯一范式（参考源 `/admin/items/new/` 各卡片容器均不带 `space-y-4` 外层，各语义组靠 `mt-5` 分隔）；禁用 `rounded-lg border p-4` 等旧写法 |
| **区块标题** | `<h2 className="text-lg font-semibold">` | 卡片内节标题；禁 `<h3 className="font-medium">` |
| **字段网格** | `mt-5 grid grid-cols-1 gap-4 md:grid-cols-2` | 两列字段网格（`mt-5` 包外层，与 `/admin/items/new/` 一致）；窄屏一列、`md` 起两列；禁 `sm:grid-cols-2` |
| **每个顶层字段（独立块）** | `<div className="mt-5">…字段…</div>` | **每个顶层字段各包一层 `mt-5`**，拿到统一 20px 节奏（与 `/admin/items/new/` 一致）；`space-y-4` 只用于自包含子块内部（破坏性小卡、弹层列表），不要拿它替代顶层字段的 `mt-5` |
| **破坏性告警小卡** | `rounded-lg border-destructive p-4` | 末组/末状态不可删等破坏性提示，保留小尺寸，**不套**卡片范式 |
| **定义列表 `<dl>`** | `grid gap-x-6 gap-y-3 sm:grid-cols-2` | 详情页专用两列定义项，非表单网格 |

### 完整结构示例

```tsx
{/* 卡片容器：注意不带 space-y-4 外层，节奏靠每字段 mt-5（与 /admin/items/new/ 一致） */}
<div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
  <h2 className="text-lg font-semibold">{title}</h2>

  {/* 第一个字段：mt-5 与标题隔开 */}
  <div className="mt-5">
    <AdminInput label={…} value={…} onChange={…} />
  </div>

  {/* 两列字段网格：mt-5 包外层 */}
  <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
    <AdminInput label={…} value={…} onChange={…} />
    <AdminInput label={…} value={…} onChange={…} />
    <AdminSelect … />
    <AdminSelect … />
  </div>

  {/* 每个顶层字段都独立 mt-5 块：含「展示图」输入、「启用」开关等，节奏统一 */}
  <div className="mt-5">
    <AdminSwitch … />
  </div>
  <div className="mt-5">
    <AdminInput label={…} value={…} onChange={…} />
  </div>

  {/* 操作按钮 */}
  <div className="mt-5 flex gap-2">
    <Button …>保存</Button>
    <Button variant="ghost" …>取消</Button>
  </div>
</div>
```

### 禁用写法

- ❌ `rounded-lg border p-4`（旧卡片，视觉不统一）
- ❌ `<h3 className="font-medium">`（标题层级太浅）
- ❌ `grid gap-4 sm:grid-cols-2`（`sm` 断点太早，平板两列太挤）
- ❌ 用 `space-y-4` 组包顶层字段（与 `/admin/items/new/` 节奏不一致；`space-y-4` 只用于自包含子块内部，如破坏性小卡、弹层列表）

## 附录：组件使用指南

本册正文只放交互规范；成体系的组件使用指南以附录文件维护，按需加载：

- **AdminGroupTree（分组树）**——数据源驱动的分层分组导航（默认两层「分组 → 成员」，分组带
  `subgroups` 时可下钻为三层或更深），接入契约与数据整理示例见
  `docs/zh/admin-group-tree.md`；**三层树完整接入示例（构造好的参数 → 树 → 布局壳）见该文 §10**。
  命中「分组树 / AdminGroupTree」时在加载本册后按需续读该附录。
- **AdminTreeNavLayout（树形导航两栏布局）**——「左树形导航 + 右主区」页面的容器壳，接入契约与
  使用示例见 `docs/zh/admin-tree-nav-layout.md`；  **三层树时它的 `nav` / `children` 两槽契约不变、
  原两层方案完整保留，见该文 §11**；左栏搜索框统一用 `AdminTreeSearchInput`（自带清空），见该文 §12。命中「两栏 / 布局 / 左树右详情 /
  AdminTreeNavLayout」时在加载本册后按需续读该附录。
