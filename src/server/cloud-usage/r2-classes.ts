/**
 * R2 操作的官方分级（https://developers.cloudflare.com/r2/pricing/）。
 *
 * 计费只认这三份清单：Class A、Class B，以及不计费的免费操作。清单之外的
 * actionType 归 `other` 并原样透传——不猜分类，因为猜错会把一笔真实操作记到
 * 另一档额度上，比显示「其他 N 次」更难发现。
 */

/** Class A：写与列举类操作。 */
const CLASS_A_ACTIONS: ReadonlySet<string> = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);

/** Class B：读与元数据查询类操作。 */
const CLASS_B_ACTIONS: ReadonlySet<string> = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

/** 官方标注的免费操作：不计入 Class A / Class B。 */
const FREE_ACTIONS: ReadonlySet<string> = new Set([
  "DeleteObject",
  "DeleteBucket",
  "AbortMultipartUpload",
]);

export type R2ActionClass = "A" | "B" | "free" | "other";

/** 把一个 actionType 归到官方分级；清单外一律 `other`。 */
export function classifyR2Action(actionType: string): R2ActionClass {
  if (CLASS_A_ACTIONS.has(actionType)) return "A";
  if (CLASS_B_ACTIONS.has(actionType)) return "B";
  if (FREE_ACTIONS.has(actionType)) return "free";
  return "other";
}
