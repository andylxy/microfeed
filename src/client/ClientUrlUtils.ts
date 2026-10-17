export function getPublicBaseUrl() {
  const {location} = window;
  let baseUrl = `${location.protocol}//${location.hostname}`;
  if (location.port !== '') {
    baseUrl = `${baseUrl}:${location.port}`;
  }
  return baseUrl;
}

/**
 * 后台看板把自己的状态存在地址上（`?bookId=…&volume=…`），刷新、后退、把链接
 * 发给同事都回到同一屏；条目编辑页的返回链接也靠这几个参数还原（ADR-0036）。
 * 看板用这两个函数读写，不要各自再写一份。
 */
export function readBoardParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

/** 一次写回多个参数，不新增历史记录；空值表示删掉该参数。 */
export function writeBoardParams(params: Record<string, string>): void {
  if (typeof window === "undefined") return;
  const search = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(params)) {
    if (value) search.set(name, value);
    else search.delete(name);
  }
  const query = search.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
}
