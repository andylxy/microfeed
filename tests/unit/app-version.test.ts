import {describe, expect, it} from "vitest";

import {
  compareVersionCode,
  hashDevicePercent,
  parseAppVersionCode,
  resolveMinVersionForRequest,
} from "@/server/app-version/resolve";

/**
 * Pure-logic tests for the version gate's resolution layer (spec §6.3 / §6.4).
 *
 * `resolveMinVersionForRequest` is exercised against a stub D1 that returns one
 * canned config row and a rule list, so the priority / floor / force rules are
 * pinned without a database. The DB-backed wiring (migrations, route handler,
 * revoked-device signal) lives in `tests/worker/app-version-routes.test.ts`.
 */

interface StubRule {
  scope: string;
  target: string | null;
  minVersionCode: number;
  force: number;
}

/** Minimal D1 stand-in: dispatch on which table the SQL mentions. */
function stubDb(
  minVersionCode: number,
  rules: StubRule[] = [],
): D1Database {
  const config = {
    downloadUrl: "",
    latestVersionCode: 10,
    latestVersionName: "1.5",
    md5: "",
    minVersionCode,
    updateLog: "",
    updatedAt: null,
  };
  const rows = rules.map((rule, index) => ({id: index + 1, ...rule}));
  return {
    prepare(sql: string) {
      const statement = {
        all: async () => ({results: sql.includes("ext_app_rollout") ? rows : []}),
        bind: () => statement,
        first: async () => (sql.includes("ext_app_version") ? config : null),
        run: async () => ({success: true}),
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("compareVersionCode", () => {
  it("orders integers, not dotted strings", () => {
    expect(compareVersionCode(10, 9)).toBe(1);
    expect(compareVersionCode(9, 10)).toBe(-1);
    expect(compareVersionCode(10, 10)).toBe(0);
  });

  it("treats a non-finite input as zero rather than throwing", () => {
    expect(compareVersionCode(Number.NaN, 0)).toBe(0);
    expect(compareVersionCode(1, Number.NaN)).toBe(1);
  });
});

describe("parseAppVersionCode", () => {
  it("parses a plain non-negative integer", () => {
    expect(parseAppVersionCode("10")).toBe(10);
    expect(parseAppVersionCode(" 42 ")).toBe(42);
  });

  it("rejects missing, dotted, signed and non-numeric values", () => {
    expect(parseAppVersionCode(null)).toBeNull();
    expect(parseAppVersionCode("")).toBeNull();
    expect(parseAppVersionCode("1.0.0")).toBeNull();
    expect(parseAppVersionCode("-1")).toBeNull();
    expect(parseAppVersionCode("abc")).toBeNull();
  });
});

describe("hashDevicePercent", () => {
  it("is deterministic and inside 0..99", () => {
    const a = hashDevicePercent("device-abc");
    expect(a).toBe(hashDevicePercent("device-abc"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  it("buckets different devices differently", () => {
    const buckets = new Set(
      ["d1", "d2", "d3", "d4", "d5"].map((id) => hashDevicePercent(id)),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });
});

describe("resolveMinVersionForRequest", () => {
  it("returns no requirement when nothing is configured", async () => {
    expect(await resolveMinVersionForRequest(stubDb(0))).toEqual({
      force: false,
      minVersionCode: 0,
    });
  });

  it("treats the global floor as a hard block", async () => {
    const resolved = await resolveMinVersionForRequest(stubDb(5));
    expect(resolved).toEqual({force: true, minVersionCode: 5});
  });

  it("takes the strictest rule (device > user > percent > all)", async () => {
    const db = stubDb(5, [
      {force: 1, minVersionCode: 10, scope: "all", target: null},
      {force: 1, minVersionCode: 20, scope: "user", target: "u1"},
      {force: 1, minVersionCode: 30, scope: "device", target: "dev-1"},
    ]);
    const resolved = await resolveMinVersionForRequest(db, {
      deviceId: "dev-1",
      userId: "u1",
    });
    expect(resolved).toEqual({force: true, minVersionCode: 30});
  });

  it("ignores a device rule for a different device", async () => {
    const db = stubDb(0, [
      {force: 1, minVersionCode: 30, scope: "device", target: "dev-1"},
    ]);
    const resolved = await resolveMinVersionForRequest(db, {
      deviceId: "dev-other",
    });
    expect(resolved).toEqual({force: false, minVersionCode: 0});
  });

  it("does not let a soft (force=0) rule raise the floor", async () => {
    // A soft rule is a prompt, not a block: it must not raise the floor, because
    // the floor is what the content gate 426s on (ADR-0008 §5).
    const withGlobalFloor = stubDb(5, [
      {force: 0, minVersionCode: 30, scope: "all", target: null},
    ]);
    expect(await resolveMinVersionForRequest(withGlobalFloor)).toEqual({
      force: true,
      minVersionCode: 5,
    });

    const withoutGlobalFloor = stubDb(0, [
      {force: 0, minVersionCode: 30, scope: "all", target: null},
    ]);
    expect(await resolveMinVersionForRequest(withoutGlobalFloor)).toEqual({
      force: false,
      minVersionCode: 0,
    });
  });

  it("takes a hard rule over a higher soft one", async () => {
    const db = stubDb(5, [
      {force: 0, minVersionCode: 40, scope: "all", target: null},
      {force: 1, minVersionCode: 20, scope: "all", target: null},
    ]);
    expect(await resolveMinVersionForRequest(db)).toEqual({
      force: true,
      minVersionCode: 20,
    });
  });

  it("keeps the block hard when the global floor is the strictest", async () => {
    const db = stubDb(40, [
      {force: 0, minVersionCode: 30, scope: "all", target: null},
    ]);
    expect(await resolveMinVersionForRequest(db)).toEqual({
      force: true,
      minVersionCode: 40,
    });
  });

  it("applies a percent rule only inside its bucket", async () => {
    const deviceId = "device-percent";
    const bucket = hashDevicePercent(deviceId);
    const inside = stubDb(0, [
      {
        force: 1,
        minVersionCode: 25,
        scope: "percent",
        target: String(Math.min(100, bucket + 1)),
      },
    ]);
    expect(await resolveMinVersionForRequest(inside, {deviceId})).toEqual({
      force: true,
      minVersionCode: 25,
    });

    const outside = stubDb(0, [
      {
        force: 1,
        minVersionCode: 25,
        scope: "percent",
        target: String(bucket),
      },
    ]);
    expect(await resolveMinVersionForRequest(outside, {deviceId})).toEqual({
      force: false,
      minVersionCode: 0,
    });
  });

  it("skips device and percent rules when no device is presented", async () => {
    const db = stubDb(0, [
      {force: 1, minVersionCode: 30, scope: "device", target: "dev-1"},
      {force: 1, minVersionCode: 40, scope: "percent", target: "100"},
    ]);
    expect(await resolveMinVersionForRequest(db)).toEqual({
      force: false,
      minVersionCode: 0,
    });
  });
});
