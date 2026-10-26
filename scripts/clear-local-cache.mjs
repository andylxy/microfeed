import {readdir, rm} from "node:fs/promises";
import path from "node:path";

/**
 * 清空本地实例的 Worker 缓存目录。
 *
 * `caches.default` 在 miniflare 下持久化到
 * `.microfeed/instances/<实例>/local-state/v3/cache/`，重启 dev server 不清空；
 * 绕过写函数直接改本地 D1 时，App 内容端点会继续返回旧响应，直到该桶 TTL 结束。
 *
 * 用法：node scripts/clear-local-cache.mjs <实例>
 * 该目录常有上百个文件，删除会撞 safe-delete 闸，运行时带前缀：
 *   CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/clear-local-cache.mjs <实例>
 */

const instance = process.argv[2];
if (!instance) {
  console.error("用法：node scripts/clear-local-cache.mjs <实例>");
  process.exit(1);
}

const root = path.resolve(
  ".microfeed/instances",
  instance,
  "local-state/v3/cache",
);
const entries = await readdir(root);
for (const entry of entries) {
  await rm(path.join(root, entry), {recursive: true, force: true});
}
console.log(`已清空 ${entries.length} 项：${root}`);
