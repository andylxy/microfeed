import type {ReactNode} from "react";

interface AdminTreeNavLayoutProps {
  /**
   * 左栏内容（搜索框、工具栏、分组树、软删折叠区……）。分组/计数/过滤全部由调用方
   * 算好，本组件只提供容器，不认识任何业务概念（与 AdminGroupTree 同一分工原则）。
   * 左栏首元素若是带 aria-label 的搜索框，它同时隐式命名了 `<nav>` 地标。
   */
  nav: ReactNode;
  /** 右栏内容（选中项详情 / 表单 / 空态引导……）。宽度自适应，窄屏堆到左栏下方。 */
  children: ReactNode;
}

/**
 * 管理后台「左树形导航 + 右主区」两栏布局壳（CONTEXT.md「分组树」页面的容器形态）。
 *
 * 只管呈现骨架，零业务分支：
 * - 外层 flex，窄屏上下堆叠、`lg` 起左右并排；
 * - 左栏固定宽、`lg` 起冻结在视口顶（`sticky`），树长时栏内自行滚动、不随右栏上滚；
 * - 右栏 `min-w-0 flex-1` 占满剩余宽（`min-w-0` 防长内容把栏撑破）。
 *
 * 搜索过滤、展开/选中、详情/表单切换这些页面语义全留在调用方——本组件不认识
 * 「搜索」「分组」「详情」任何概念，只把 `<nav>` 与主区摆到正确位置。
 */
export function AdminTreeNavLayout({
  nav,
  children,
}: AdminTreeNavLayoutProps) {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <nav className="w-full shrink-0 self-start rounded-[14px] border bg-card p-2 shadow-xs lg:sticky lg:top-4 lg:max-h-[calc(100svh-6rem)] lg:w-72 lg:overflow-y-auto">
        {nav}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
