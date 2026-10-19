/**
 * 设置页「当前所在分区」的共享状态。
 *
 * 侧栏与正文是两个岛：分区高亮画在侧栏，滚动发生在正文。侧栏原来只认 URL
 * hash，那在整页加载时管用，滚动过程中的跟随必须有个两边都能读的地方——
 * 何况 `replaceState` 不触发 hashchange，光改 URL 侧栏收不到通知。于是有
 * 了这个模块级 store：正文写、侧栏读。
 *
 * 与 menu-open-state 同构（订阅制、渲染前可读），区别是不做持久化：
 * 当前分区是「这一刻眼睛在哪」，不是偏好，刷新后交给 URL hash 与滚动位置。
 */

let currentSectionId = "";

const listeners = new Set<() => void>();

/** 订阅当前分区变化，返回退订函数（`useSyncExternalStore` 直接收）。 */
export function subscribeSettingsSection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSettingsSection(): string {
  return currentSectionId;
}

export function setSettingsSection(sectionId: string): void {
  if (currentSectionId === sectionId) return;
  currentSectionId = sectionId;
  for (const listener of listeners) listener();
}
