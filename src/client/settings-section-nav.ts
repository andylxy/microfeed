import {
  ADMIN_SETTINGS_SECTIONS,
  settingsSectionFromHash,
} from "@/shared/AdminSettingsNavigation";
import {
  activeAnchorSectionId,
  observeScrollAndResize,
  scrollToAdminSettingsSection,
} from "@/client/AdminSettingsScroll";
import {setSettingsSection} from "@/client/settings-section-state";

const SCROLL_ROOT_ID = "admin-page-content";

function stripTrailingSlash(pathname: string): string {
  return pathname.replace(/\/+$/u, "");
}

/**
 * 链接指向的「当前页设置分区」；指向别的页、或 hash 不是设置分区时返回 null。
 *
 * 尾斜杠要容错：菜单数据里的设置页路径与浏览器地址栏可能差一个 `/`
 * （Astro 会把无尾斜杠的地址 308 到带尾斜杠的），严格比较会让拦截静默失效。
 */
export function settingsSectionIdFromHref(
  href: string,
  pathname: string,
): string | null {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (stripTrailingSlash(url.pathname) !== stripTrailingSlash(pathname)) {
    return null;
  }
  const id = decodeURIComponent(url.hash.slice(1));
  return ADMIN_SETTINGS_SECTIONS.some((section) => section.id === id) ? id : null;
}

/**
 * 跳到指定分区：平滑滚动，并用 replaceState 把当前位置记进 URL——点一次分区
 * 就往浏览器的历史里压一条的话，连点十次要按十次返回才离开本页。滚动不到
 * （分区不在文档里）时返回 false，调用方自行退回整页导航。
 */
export function jumpToSettingsSection(sectionId: string): boolean {
  if (!scrollToAdminSettingsSection(sectionId, {behavior: "smooth"})) {
    return false;
  }
  window.history.replaceState(null, "", `#${sectionId}`);
  setSettingsSection(sectionId);
  return true;
}

function onDocumentClick(event: MouseEvent): void {
  // 修饰键交给浏览器（新标签页打开等）；已被 preventDefault 的不重复处理。
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)
    ?.closest<HTMLAnchorElement>("a[href]");
  if (!anchor?.href) return;
  const sectionId = settingsSectionIdFromHref(
    anchor.href,
    window.location.pathname,
  );
  if (!sectionId) return;
  event.preventDefault();
  if (!jumpToSettingsSection(sectionId)) {
    window.location.assign(anchor.href);
  }
}

/**
 * 给设置页装上分区导航：正文滚动 → 高亮跟随；点分区链接（侧栏第三级子项、
 * 移动端抽屉里的同一批链接）→ 平滑滚动 + replaceState。
 *
 * 返回卸载函数：岛屿销毁时调用，顺手清掉共享状态，免得别的页面读到上一个
 * 页面残留的分区。
 */
export function installSettingsSectionNav(): () => void {
  const root = document.getElementById(SCROLL_ROOT_ID);
  // 初值先看 URL hash：带 #hash 进来时正文还没滚，直接读滚动位置会先高亮
  // 第一块，等 rAF 把页面滚过去再跳回来，闪一下。
  setSettingsSection(
    settingsSectionFromHash(window.location.hash) ??
      (root ? activeAnchorSectionId(ADMIN_SETTINGS_SECTIONS, root) : ""),
  );

  document.addEventListener("click", onDocumentClick, true);
  const stopObserving = root
    ? observeScrollAndResize(root, () =>
        setSettingsSection(activeAnchorSectionId(ADMIN_SETTINGS_SECTIONS, root)),
      )
    : () => {};

  return () => {
    stopObserving();
    document.removeEventListener("click", onDocumentClick, true);
    setSettingsSection("");
  };
}
