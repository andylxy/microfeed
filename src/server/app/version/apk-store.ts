/**
 * 「版本管理 → 历史包」：列/删 R2 里上传过的 APK。
 *
 * 为什么另开一个模块而不是复用 `server/media/deletions.ts`：那条链路是
 * 「删图片**顺带清元数据**」的语义（`parseDeleteImageRequest` 要 `imageUrl`，
 * 还可带 `ImageMetadataTarget`），APK 没有元数据。硬套会让那条链路的分支越来越难懂。
 *
 * **零新表**：R2 是唯一事实来源 —— 不建 `ext_app_apk`，就不存在「表里有、桶里没有」的
 * 双写漂移。「当前在用哪个包」由既有 `ext_app_version.download_url` 表达。
 */
import {mediaPrefix} from "@/server/media/R2Utils";
import {mediaBucket} from "@/server/media/storage";
import type {UploadedApk} from "@/shared/AppDeviceVersion";

/** 单页最多列多少个。发版场景量极小，但 R2 `list` 本身按 1000 分页，得显式给个上限。 */
const APK_LIST_LIMIT = 200;

/**
 * 上传的 APK 落在 `<环境前缀>/app/` 下（键的命名见 `AppVersionsApp.uploadApk`）。
 *
 * ⚠️ **必须带环境前缀**：本地写 `development/…`、生产写 `production/…`（`mediaPrefix` 按
 * hostname 判断）。不加前缀过滤的话，本地后台会列到生产的对象（或反过来什么都看不到）。
 */
export function apkKeyPrefix(runtimeEnv: Env, requestUrl: string): string {
  return `${mediaPrefix(runtimeEnv, requestUrl)}/app/`;
}

/** 列出当前环境上传过的 APK，最新在前。R2 未启用时返回空数组（页面据此显示空态）。 */
export async function listUploadedApks(
  runtimeEnv: Env,
  requestUrl: string,
): Promise<UploadedApk[]> {
  const bucket = mediaBucket(runtimeEnv);
  if (!bucket) {
    return [];
  }
  const prefix = apkKeyPrefix(runtimeEnv, requestUrl);
  const listed = await bucket.list({limit: APK_LIST_LIMIT, prefix});
  return listed.objects
    .map((object) => ({
      // 单段 PUT 的 ETag 即内容 MD5，直接用，不读回对象。
      md5: object.etag,
      key: object.key,
      name: object.key.slice(prefix.length),
      size: object.size,
      uploadedAt: object.uploaded.toISOString(),
    }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/**
 * 删除一个上传的 APK。返回 `false` 表示**拒绝**（键不在允许范围内）。
 *
 * ⚠️ 键校验不是可选项：同一个 bucket 里还躺着条目图片、主题资源等。
 * 若这里只做 `bucket.delete(key)`，这个端点就变成「删任意 R2 对象」的万能后门 ——
 * 拿到 `system:app-version:manage` 的人能删掉整站的图。
 */
export async function deleteUploadedApk(
  runtimeEnv: Env,
  requestUrl: string,
  key: string,
): Promise<boolean> {
  const bucket = mediaBucket(runtimeEnv);
  if (!bucket) {
    return false;
  }
  const prefix = apkKeyPrefix(runtimeEnv, requestUrl);
  if (!key.startsWith(prefix) || key.length <= prefix.length) {
    return false;
  }
  // 前缀之内也不允许空段/相对段 —— 与 `normalizeObjectKey` 同口径，避免 `app/../x` 逃逸。
  const rest = key.slice(prefix.length);
  if (
    rest.includes("\\") ||
    rest.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return false;
  }
  await bucket.delete(key);
  return true;
}
