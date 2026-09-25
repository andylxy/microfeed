import {describe, expect, it} from "vitest";
import {
  ALLOWED_MEDIA_UPLOAD_TYPES,
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
