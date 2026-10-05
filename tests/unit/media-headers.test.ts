import {describe, expect, it} from "vitest";
import {
  ALLOWED_MEDIA_UPLOAD_TYPES,
  isAllowedMediaUploadType,
  isInlineSafeMediaType,
  MAX_MEDIA_UPLOAD_BYTES,
  mediaContentDisposition,
} from "@/shared/MediaFileUtils";

describe("A4 media upload allowlist", () => {
  it("includes the common CLI media types", () => {
    for (const type of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/avif",
      "audio/mpeg",
      "video/mp4",
      "application/pdf",
      "application/msword",
      "text/plain",
    ]) {
      expect(ALLOWED_MEDIA_UPLOAD_TYPES.has(type)).toBe(true);
    }
  });

  it("excludes scriptable types that would be a stored-XSS vector", () => {
    for (const dangerous of ["image/svg+xml", "text/html", "application/javascript"]) {
      expect(ALLOWED_MEDIA_UPLOAD_TYPES.has(dangerous)).toBe(false);
    }
  });

  it("caps uploads at the R2 single-PUT ceiling", () => {
    expect(MAX_MEDIA_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe("upload allowlist with the object key (APK exception)", () => {
  it("accepts the APK types for a *.apk key", () => {
    // 浏览器对 .apk 常报前者，识别不出时退化成后者。
    expect(
      isAllowedMediaUploadType("application/vnd.android.package-archive", "development/app/x.apk"),
    ).toBe(true);
    expect(
      isAllowedMediaUploadType("application/octet-stream", "development/app/x.apk"),
    ).toBe(true);
    // 大小写不敏感（签名与 PUT 两处共用，规则必须一致）。
    expect(isAllowedMediaUploadType("APPLICATION/OCTET-STREAM", "APP/X.APK")).toBe(true);
  });

  it("does NOT let octet-stream become a universal pass", () => {
    // 这是关键回归点：若把 octet-stream 直接塞进白名单，A4 的整套白名单就废了。
    expect(isAllowedMediaUploadType("application/octet-stream", "media/x.bin")).toBe(false);
    expect(
      isAllowedMediaUploadType("application/vnd.android.package-archive", "media/x.zip"),
    ).toBe(false);
  });

  it("keeps the existing behaviour for the plain allowlist", () => {
    expect(isAllowedMediaUploadType("image/png", "media/x.png")).toBe(true);
    expect(isAllowedMediaUploadType("text/html", "media/x.html")).toBe(false);
    // 空 content-type 仍然放行（服务端会以 attachment 下发）。
    expect(isAllowedMediaUploadType("", "media/x")).toBe(true);
  });
});

describe("A4 inline-safe media classification", () => {
  it("treats image/pdf as inline-safe", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf"]) {
      expect(isInlineSafeMediaType(type)).toBe(true);
    }
  });

  it("treats any video/* or audio/* as inline-safe", () => {
    expect(isInlineSafeMediaType("video/mp4")).toBe(true);
    expect(isInlineSafeMediaType("audio/mpeg")).toBe(true);
    expect(isInlineSafeMediaType("video/webm")).toBe(true);
  });

  it("treats scriptable types as NOT inline-safe", () => {
    for (const type of ["image/svg+xml", "text/html", "application/javascript", "application/octet-stream"]) {
      expect(isInlineSafeMediaType(type)).toBe(false);
    }
  });

  it("returns attachment disposition only for non-inline-safe types", () => {
    expect(mediaContentDisposition("image/png")).toBeNull();
    expect(mediaContentDisposition("image/jpeg")).toBeNull();
    expect(mediaContentDisposition("video/mp4")).toBeNull();
    expect(mediaContentDisposition("image/svg+xml")).toBe("attachment");
    expect(mediaContentDisposition("text/html")).toBe("attachment");
    expect(mediaContentDisposition("")).toBe("attachment");
  });
});
