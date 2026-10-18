import {describe, expect, it} from "vitest";

import {classifyR2Action} from "@/server/cloud-usage/r2-classes";

/**
 * R2 操作分级的官方清单（https://developers.cloudflare.com/r2/pricing/）。
 *
 * 这些断言守的是「清单没被抄错」：少一项会把一笔真实操作算到 `other`，
 * 多一项会把免费操作算进计费额度。两边的差误都不会报错，只会在看板上
 * 显示一个没人能解释的数字。
 */
describe("R2 action classification", () => {
  it("classifies every Class A action as A", () => {
    for (const action of [
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
    ]) {
      expect(classifyR2Action(action), action).toBe("A");
    }
  });

  it("classifies every Class B action as B", () => {
    for (const action of [
      "HeadBucket",
      "HeadObject",
      "GetObject",
      "UsageSummary",
      "GetBucketEncryption",
      "GetBucketLocation",
      "GetBucketCors",
      "GetBucketLifecycleConfiguration",
    ]) {
      expect(classifyR2Action(action), action).toBe("B");
    }
  });

  it("classifies the free operations as free", () => {
    for (const action of [
      "DeleteObject",
      "DeleteBucket",
      "AbortMultipartUpload",
    ]) {
      expect(classifyR2Action(action), action).toBe("free");
    }
  });

  it("keeps unknown actions in their own bucket", () => {
    expect(classifyR2Action("SomeFutureAction")).toBe("other");
    expect(classifyR2Action("")).toBe("other");
  });
});
