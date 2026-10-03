import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {GET as appVersionGet} from "@/pages/api/app/version";
import {readAllDevices} from "@/server/admin/rbac-handlers";
import {
  readAppVersionConfig,
  readRolloutRules,
  saveAppVersionConfig,
  saveRolloutRules,
} from "@/server/app-version/config";
import {resolveMinVersionForRequest} from "@/server/app-version/resolve";
import {requireAccountAccess, requireAppVersion} from "@/server/rbac/guard";
import {
  deviceIdFromRequest,
  isDeviceRevoked,
  registerUserDevice,
} from "@/server/rbac/resolve";

/**
 * DB-backed tests for the device/version surface (spec §6.1–§6.5).
 *
 * Covers what the pure-logic suite cannot: the migrations really create the two
 * tables, the singleton config round-trips, the App content namespace is gated
 * while the public version endpoint is not, and a revoked device both reports as
 * revoked and produces the distinguishing 401 signal (ADR-0003 / ADR-0006).
 */

const db = env.FEED_DB;
const APP_URL = "https://app.example.com/api/AppBookRequest/GetNav/";
const VERSION_URL = "https://app.example.com/api/app/version";

async function reset(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM ext_app_rollout"),
    db.prepare(
      "UPDATE ext_app_version SET min_version_code = 0, latest_version_code = 10, " +
        "latest_version_name = '1.5', download_url = '', file_md5 = '', update_log = '' WHERE id = 1",
    ),
    db.prepare("DELETE FROM ext_user_devices"),
    db.prepare('DELETE FROM "auth_user"'),
  ]);
}

async function seedUser(id: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt) ' +
        "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01')",
    )
    .bind(id, id.toUpperCase(), `${id}@example.com`)
    .run();
}

beforeEach(reset);

describe("app version configuration", () => {
  it("round-trips the singleton config row", async () => {
    const saved = await saveAppVersionConfig(db, {
      downloadUrl: "https://cdn.example.com/app-v2.apk",
      latestVersionCode: 20,
      latestVersionName: "2.0",
      md5: "abc123",
      minVersionCode: 12,
      updateLog: "Fixed things",
    });
    expect(saved).toEqual({ok: true});

    const config = await readAppVersionConfig(db);
    expect(config).toMatchObject({
      downloadUrl: "https://cdn.example.com/app-v2.apk",
      latestVersionCode: 20,
      latestVersionName: "2.0",
      md5: "abc123",
      minVersionCode: 12,
      updateLog: "Fixed things",
    });
    expect(config.updatedAt).not.toBeNull();
  });

  it("rejects an invalid config payload", async () => {
    expect(await saveAppVersionConfig(db, {latestVersionName: "", minVersionCode: 0}))
      .toEqual({ok: false, reason: "invalidConfig"});
    expect(await saveAppVersionConfig(db, {
      latestVersionName: "2.0",
      minVersionCode: -1,
    })).toEqual({ok: false, reason: "invalidConfig"});
  });

  it("replaces rollout rules and validates them", async () => {
    expect(await saveRolloutRules(db, [{scope: "percent", target: "150", minVersionCode: 5}]))
      .toEqual({ok: false, reason: "invalidRule"});
    expect(await saveRolloutRules(db, "nope")).toEqual({ok: false, reason: "invalidRule"});

    expect(await saveRolloutRules(db, [
      {force: true, minVersionCode: 12, scope: "all", target: null},
      {force: false, minVersionCode: 15, scope: "percent", target: "50"},
    ])).toEqual({ok: true});

    const rules = await readRolloutRules(db);
    expect(rules).toHaveLength(2);
    expect(rules.find((rule) => rule.scope === "percent")).toMatchObject({
      force: false,
      minVersionCode: 15,
      target: "50",
    });
  });
});

describe("version gate on the App content namespace", () => {
  it("resolves the floor from the stored config and hard rules", async () => {
    await saveAppVersionConfig(db, {
      latestVersionName: "2.0",
      minVersionCode: 5,
    });
    await saveRolloutRules(db, [
      {force: true, minVersionCode: 30, scope: "device", target: "dev-1"},
    ]);
    expect(await resolveMinVersionForRequest(db, {deviceId: "dev-1"})).toEqual({
      force: true,
      minVersionCode: 30,
    });
    expect(await resolveMinVersionForRequest(db, {deviceId: "dev-2"})).toEqual({
      force: true,
      minVersionCode: 5,
    });
  });

  it("does not 426 a client that only a soft rule would cover", async () => {
    // The whole point of `force = 0`: nudge, don't block. If a soft rule raised
    // the floor, the content gate would hard-block exactly the clients the rule
    // only meant to prompt (ADR-0008 §5).
    await saveAppVersionConfig(db, {latestVersionName: "2.0", minVersionCode: 0});
    await saveRolloutRules(db, [
      {force: false, minVersionCode: 30, scope: "all", target: null},
    ]);
    expect(await resolveMinVersionForRequest(db)).toEqual({
      force: false,
      minVersionCode: 0,
    });
    expect(
      await requireAppVersion(db, new Request(APP_URL, {headers: {"app-version": "10"}})),
    ).toBeNull();
  });

  it("426s a missing, non-integer or too-low app-version header", async () => {
    await saveAppVersionConfig(db, {latestVersionName: "2.0", minVersionCode: 10});

    expect((await requireAppVersion(db, new Request(APP_URL)))?.status).toBe(426);
    expect(
      (await requireAppVersion(db, new Request(APP_URL, {headers: {"app-version": "1.0"}})))?.status,
    ).toBe(426);
    expect(
      (await requireAppVersion(db, new Request(APP_URL, {headers: {"app-version": "9"}})))?.status,
    ).toBe(426);
  });

  it("passes a request at or above the floor", async () => {
    await saveAppVersionConfig(db, {latestVersionName: "2.0", minVersionCode: 10});
    expect(
      await requireAppVersion(db, new Request(APP_URL, {headers: {"app-version": "10"}})),
    ).toBeNull();
  });
});

describe("public /api/app/version endpoint", () => {
  it("returns the descriptor and never 426s, even below the floor", async () => {
    await saveAppVersionConfig(db, {
      downloadUrl: "https://cdn.example.com/app.apk",
      latestVersionCode: 20,
      latestVersionName: "2.0",
      md5: "deadbeef",
      minVersionCode: 18,
      updateLog: "Changelog",
    });
    const response = await appVersionGet({
      request: new Request(VERSION_URL, {headers: {"app-version": "1"}}),
    } as never);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      downloadUrl: "https://cdn.example.com/app.apk",
      force: true,
      latestVersionCode: 20,
      latestVersionName: "2.0",
      md5: "deadbeef",
      minVersionCode: 18,
      updateLog: "Changelog",
    });
  });

  it("reports force=false for a caller already above the hard floor", async () => {
    await saveAppVersionConfig(db, {
      downloadUrl: "https://cdn.example.com/app.apk",
      latestVersionCode: 20,
      latestVersionName: "2.0",
      minVersionCode: 18,
    });
    const response = await appVersionGet({
      request: new Request(VERSION_URL, {headers: {"app-version": "19"}}),
    } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      force: false,
      minVersionCode: 18,
    });
  });

  it("reports force=true when the caller sends no app-version at all", async () => {
    await saveAppVersionConfig(db, {latestVersionName: "2.0", minVersionCode: 18});
    const response = await appVersionGet({
      request: new Request(VERSION_URL),
    } as never);
    expect(await response.json()).toMatchObject({force: true});
  });
});

describe("device registration and revocation", () => {
  it("lists every device across accounts with its owner", async () => {
    await seedUser("u-one");
    await seedUser("u-two");
    await db.batch([
      db
        .prepare(
          "INSERT INTO ext_user_devices (user_id, device_id, last_seen_at, status) VALUES (?, ?, '2024-01-02', ?)",
        )
        .bind("u-one", "dev-a", "active"),
      db
        .prepare(
          "INSERT INTO ext_user_devices (user_id, device_id, last_seen_at, status) VALUES (?, ?, '2024-01-01', ?)",
        )
        .bind("u-two", "dev-b", "revoked"),
    ]);

    const all = await readAllDevices(db);
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.deviceId).sort()).toEqual(["dev-a", "dev-b"]);
    expect(all.find((row) => row.deviceId === "dev-a")?.email).toBe("u-one@example.com");

    const revoked = await readAllDevices(db, {status: "revoked"});
    expect(revoked.map((row) => row.deviceId)).toEqual(["dev-b"]);
  });

  it("registers a device without lifting a revocation", async () => {
    await seedUser("u-dev");
    const request = new Request(APP_URL, {headers: {"x-device-id": "dev-keep"}});
    expect(deviceIdFromRequest(request)).toBe("dev-keep");

    await registerUserDevice(db, "u-dev", request);
    await db
      .prepare("UPDATE ext_user_devices SET status = 'revoked' WHERE user_id = ? AND device_id = ?")
      .bind("u-dev", "dev-keep")
      .run();

    // A later request from the same device must not flip it back to active.
    await registerUserDevice(db, "u-dev", request);
    expect(await isDeviceRevoked(db, "u-dev", request)).toBe(true);
    const row = await db
      .prepare("SELECT status FROM ext_user_devices WHERE user_id = ? AND device_id = ?")
      .bind("u-dev", "dev-keep")
      .first<{status: string}>();
    expect(row?.status).toBe("revoked");
  });

  it("rejects an invalid device id header", async () => {
    expect(deviceIdFromRequest(new Request(APP_URL, {headers: {"x-device-id": "bad id!"}})))
      .toBeNull();
    expect(
      deviceIdFromRequest(new Request(APP_URL, {headers: {"x-device-id": "a".repeat(65)}})),
    ).toBeNull();
  });

  it("marks a revoked device 401 with the distinguishing header", async () => {
    const revoked = requireAccountAccess({authUser: {id: "u1"}, rbacDeviceRevoked: true});
    expect(revoked?.status).toBe(401);
    expect(revoked?.headers.get("X-Device-Revoked")).toBe("1");

    // An ordinary expired session stays a plain 401 with no signal.
    const expired = requireAccountAccess({authUser: null});
    expect(expired?.status).toBe(401);
    expect(expired?.headers.get("X-Device-Revoked")).toBeNull();
  });
});
