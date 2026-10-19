/**
 * 后台菜单树的展开态（按账号记在 localStorage）。
 *
 * 为什么需要这么一个模块：展开态要跨节点协调——顶层（分组）同时只允许展开
 * 一个，而每一行菜单原本各读各写 localStorage，兄弟节点互不知情，做不出
 * 手风琴。这里把状态收成一份，组件用 `useSyncExternalStore` 订阅，兄弟节点
 * 能在同一次点击里同时收到通知。
 *
 * 顶层互斥与「当前页祖先链必须可见」不冲突，靠调用时机区分：
 *   - 用户点击行 → `toggleMenuCode`：顶层互斥（展开一个即收起其他顶层）；
 *   - 换页（当前页所在的顶层变化）→ `syncMenuTopLevel`：改由新页面所在的
 *     顶层展开，用户在这之前的手动选择随页面一起翻篇。
 * 两条路径都不动更深层的展开态（三级分区各自展开不受影响）。
 */

const STORAGE_KEY_PREFIX = "microfeed-admin-menu-open";

let bound = false;
let activeAccountKey: string | undefined;
let openCodes: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function keyOf(accountKey: string | undefined): string {
  return accountKey
    ? `${STORAGE_KEY_PREFIX}:${accountKey}`
    : STORAGE_KEY_PREFIX;
}

function persist(): void {
  try {
    window.localStorage.setItem(
      keyOf(activeAccountKey),
      JSON.stringify([...openCodes]),
    );
  } catch {
    // 隐私模式或配额写满：展开态不写入本地存储，本次会话照常可用。
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 载入某个账号的展开态；账号切换或首次挂载时调用。 */
export function bindMenuAccount(accountKey: string | undefined): void {
  if (bound && accountKey === activeAccountKey) return;
  bound = true;
  activeAccountKey = accountKey;
  try {
    const raw = window.localStorage.getItem(keyOf(accountKey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    openCodes = new Set(
      Array.isArray(parsed)
        ? parsed.filter((code): code is string => typeof code === "string")
        : [],
    );
  } catch {
    openCodes = new Set();
  }
  notify();
}

export function subscribeMenuState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isMenuCodeOpen(code: string): boolean {
  return openCodes.has(code);
}

/** 只加不减：当前页的祖先链必须可见，这一路不参与互斥。 */
export function openMenuCode(code: string): void {
  if (openCodes.has(code)) return;
  openCodes = new Set(openCodes).add(code);
  persist();
  notify();
}

/** 用户点击某一行。顶层（depth 0）展开时收起其余顶层。 */
export function toggleMenuCode(
  code: string,
  depth: number,
  topLevelCodes: readonly string[],
): void {
  const next = new Set(openCodes);
  if (next.has(code)) {
    next.delete(code);
  } else {
    next.add(code);
    if (depth === 0) {
      for (const top of topLevelCodes) {
        if (top !== code) next.delete(top);
      }
    }
  }
  openCodes = next;
  persist();
  notify();
}

/**
 * 换页后改由当前页所在的顶层展开，只留 `activeTop` 一个。
 *
 * `activeTop` 为 null（当前页不在任何分组下）时保留已展开的第一个，兼容
 * 过去允许多个顶层同时展开时留下的老数据——否则老用户会看到两个分组都开着。
 */
export function syncMenuTopLevel(
  activeTop: string | null,
  topLevelCodes: readonly string[],
): void {
  const openTops = topLevelCodes.filter((code) => openCodes.has(code));
  const keep = activeTop ?? openTops[0] ?? null;
  const next = new Set(openCodes);
  for (const top of topLevelCodes) {
    if (top === keep) {
      next.add(top);
    } else {
      next.delete(top);
    }
  }
  openCodes = next;
  persist();
  notify();
}
