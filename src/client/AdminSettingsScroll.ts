import {ADMIN_SETTINGS_SECTIONS} from "@/shared/AdminSettingsNavigation";

interface ScrollToAdminSettingsSectionOptions {
  behavior?: ScrollBehavior;
  offset?: number;
}

export function scrollToAdminSettingsSection(
  sectionId: string,
  {
    behavior = "auto",
    offset = 24,
  }: ScrollToAdminSettingsSectionOptions = {},
): boolean {
  if (!ADMIN_SETTINGS_SECTIONS.some(({id}) => id === sectionId)) {
    return false;
  }

  const element = document.getElementById(sectionId);
  const scrollRoot = document.getElementById("admin-page-content");
  if (!element || !scrollRoot) {
    return false;
  }

  if (scrollRoot.scrollHeight <= scrollRoot.clientHeight) {
    element.scrollIntoView({
      behavior,
      block: "start",
    });
    return true;
  }

  const elementBounds = element.getBoundingClientRect();
  const top = scrollRoot.scrollTop +
    elementBounds.top -
    scrollRoot.getBoundingClientRect().top -
    offset;
  scrollRoot.scrollTo({behavior, top});
  return true;
}

export function scrollToAdminSettingsHash(
  hash = window.location.hash,
  options?: ScrollToAdminSettingsSectionOptions,
): boolean {
  if (!hash.startsWith("#")) {
    return false;
  }

  return scrollToAdminSettingsSection(
    decodeURIComponent(hash.slice(1)),
    options,
  );
}

/**
 * 滚动位置对应的分区：取「顶边越过阈值线的最后一个」——阈值是滚动容器顶边
 * 再往下 56px，设置页与账户页同一套手感。滚到底时取最后一个可见分区，否则
 * 正文拉到底时高亮会停在倒数第二块。
 *
 * 隐藏中的分区不参与判定：设置页的搜索过滤用 display:none 藏起不命中的
 * 卡片，其矩形四边皆为 0，混进来会让高亮跳到第一个被藏起的分区；滚到底
 * 时也只认可见的末块。
 *
 * `sections` 传非空的静态清单（ADMIN_SETTINGS_SECTIONS /
 * ADMIN_ACCOUNT_SECTIONS）：空清单没有「当前分区」可言，由调用方保证传入
 * 的清单非空。
 */
export function activeAnchorSectionId<T extends {id: string}>(
  sections: readonly T[],
  scrollRoot: HTMLElement,
): T["id"] {
  let current = sections[0]!.id;
  const atBottom =
    scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop <= 4;
  const threshold = scrollRoot.getBoundingClientRect().top + 56;
  for (const section of sections) {
    const rect = document.getElementById(section.id)?.getBoundingClientRect();
    if (!rect || rect.height <= 0) continue;
    if (atBottom || rect.top <= threshold) current = section.id;
  }
  return current;
}

/**
 * 滚动与窗口尺寸变化时按帧节流调用 onScroll，装载时先调用一次；返回卸载
 * 函数。锚点分区高亮的两处调用方（设置页正文、账户页侧栏）共用这一套观察
 * 形状，各自只提供「重算当前分区」的回调。
 */
export function observeScrollAndResize(
  scrollRoot: HTMLElement,
  onScroll: () => void,
): () => void {
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(onScroll);
  };
  schedule();
  scrollRoot.addEventListener("scroll", schedule, {passive: true});
  window.addEventListener("resize", schedule);
  return () => {
    cancelAnimationFrame(frame);
    scrollRoot.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
  };
}
