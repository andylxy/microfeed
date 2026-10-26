/**
 * Workers Cache Storage 的最小适配层。
 *
 * `caches.default` 的接口形状、判空与按 URL 存取收在这一份里，键的 origin 与
 * 后缀拼法由调用方给出。
 *
 * 三个约定：
 *  - 运行时没有 Cache Storage（本地 dev 的受限环境）时一律静默跳过，读当作未命中、
 *    写与删除当作成功——缓存不可用不该让请求失败。
 *  - 删除是各数据中心本地操作，不跨机房传播。需要跨机房生效的失效走
 *    `cache.purge({tags})`（`public-cache.ts` 已有先例）。
 *  - 键是完整 URL，不含调用者身份；需要按参数分份时把参数拼进路径。
 */

/** Workers 运行时 Cache Storage 的最小接口（`caches.default`，按 URL 存取）。 */
export interface WorkerCache {
  delete(key: URL): Promise<boolean>;
  match(request: URL | Request): Promise<Response | undefined>;
  put(request: URL | Request, response: Response): Promise<void>;
}

export function workerCacheOrNull(): WorkerCache | null {
  const storage = (globalThis as {caches?: {default?: WorkerCache}}).caches;
  return storage?.default ?? null;
}

export function workerCache(): WorkerCache {
  const storage = workerCacheOrNull();
  if (!storage) {
    throw new Error("Cache Storage unavailable in this runtime");
  }
  return storage;
}

/** 键的拼法：`path` 挂在 `origin` 下。同一 origin 下的读写与清理共用这一处。 */
export function workerCacheKey(origin: string, path: string): URL {
  return new URL(path, origin);
}

/**
 * 静默删一批缓存键：没有 Cache Storage 时跳过；单个键删不掉也不影响正确性，
 * 下一次未命中会重写。删除是各机房本地操作，互不依赖，并行收束串行往返。
 */
export async function deleteWorkerCacheKeys(keys: URL[]): Promise<void> {
  const storage = workerCacheOrNull();
  if (!storage) return;
  await Promise.all(keys.map(async (key) => {
    try {
      await storage.delete(key);
    } catch {
      // 删不掉不影响正确性：下一次未命中会重写。
    }
  }));
}

/** 读一条 JSON 条目；缺失、读失败、内容不是合法 JSON 一律返回 null（按未命中处理）。 */
export async function readJsonEntry<T>(key: URL): Promise<T | null> {
  const storage = workerCacheOrNull();
  if (!storage) return null;
  let text: string | null = null;
  try {
    const hit = await storage.match(key);
    if (hit) text = await hit.text();
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 坏条目按未命中处理，回源重写。
    return null;
  }
}

/**
 * 写一条 JSON 条目；写失败静默（退化为直读，下一次未命中重写）。
 * `tags` 会写进 `Cache-Tag`，供 `cache.purge({tags})` 跨机房清空。
 */
export async function writeJsonEntry(
  key: URL,
  value: unknown,
  ttlSeconds: number,
  tags: readonly string[] = [],
): Promise<void> {
  const storage = workerCacheOrNull();
  if (!storage) return;
  const headers: Record<string, string> = {
    "cache-control": `public, max-age=${ttlSeconds}`,
  };
  if (tags.length > 0) headers["cache-tag"] = tags.join(", ");
  try {
    await storage.put(key, new Response(JSON.stringify(value), {headers}));
  } catch {
    // 写失败退化为直读，下一次未命中重写。
  }
}
