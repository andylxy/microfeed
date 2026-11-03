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

## 附录：组件使用指南

本册正文只放交互规范；成体系的组件使用指南以附录文件维护，按需加载：

- **AdminGroupTree（分组树）**——数据源驱动的两层分组导航，接入契约与数据整理示例见
  `docs/zh/admin-group-tree.md`；命中「分组树 / AdminGroupTree」时在加载本册后按需续读该附录。
- **AdminTreeNavLayout（树形导航两栏布局）**——「左树形导航 + 右主区」页面的容器壳，接入契约与
  使用示例见 `docs/zh/admin-tree-nav-layout.md`；命中「两栏 / 布局 / 左树右详情 /
  AdminTreeNavLayout」时在加载本册后按需续读该附录。
