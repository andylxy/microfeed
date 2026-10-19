import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  clearCloudflareToken,
  cloudflareTokenStatus,
  readCloudflareToken,
  saveCloudflareToken,
  type CloudUsageTokenEnv,
} from "@/server/cloud-usage/token-store";
import {decryptSecret, encryptSecret} from "@/server/cloud-usage/secret-crypto";

/**
 * Cloudflare Token 存取的往返测试。
 *
 * 用内存 SQLite 顶替 D1（与 `tests/unit/server/extReview.test.ts` 同款做法），
 * 表结构照 `migrations/0124_schema_cloud_usage_token.sql` 建，这样生产 SQL
 * 被真实执行一遍，断言基于真实的事务语义。
 *
 * 断言的都是外部行为：存进去再读出来是同一个值、末四位提示正确、解不开与没配置
 * 是两种不同结果、清除后回到没配置。
 */

const KEK = "test-upload-signing-key";
const OTHER_KEK = "rotated-upload-signing-key";

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<{results: Record<string, unknown>[]; success: boolean}>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{results: T[]; success: boolean}>;
}

function makeStatement(
  database: DatabaseSync,
  sql: string,
  boundValues: unknown[] = [],
): Statement {
  return {
    bind(...values: unknown[]) {
      return makeStatement(database, sql, values);
    },
    async run() {
      database.prepare(sql).run(...(boundValues as never[]));
      return {results: [], success: true};
    },
    async first<T>() {
      const rows = database
        .prepare(sql)
        .all(...(boundValues as never[])) as T[];
      return rows[0] ?? null;
    },
    async all<T>() {
      const rows = database
        .prepare(sql)
        .all(...(boundValues as never[])) as T[];
      return {results: rows, success: true};
    },
  };
}

function newDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE ext_cloud_usage_token (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token_cipher TEXT NOT NULL,
    token_hint TEXT NOT NULL DEFAULT '',
    updated_at_ms INTEGER NOT NULL
  )`);
  return database;
}

function makeEnv(database: DatabaseSync, key = KEK): CloudUsageTokenEnv {
  return {
    FEED_DB: {
      prepare: (sql: string) => makeStatement(database, sql),
    } as unknown as D1Database,
    UPLOAD_SIGNING_KEY: key,
  };
}

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789abcd";

describe("cloudflare token store", () => {
  it("round-trips a secret through encryptSecret / decryptSecret", async () => {
    const cipher = await encryptSecret(TOKEN, KEK);
    expect(cipher).not.toContain(TOKEN);
    await expect(decryptSecret(cipher, KEK)).resolves.toBe(TOKEN);
  });

  it("reports absent before anything is saved", async () => {
    const env = makeEnv(newDatabase());
    await expect(readCloudflareToken(env)).resolves.toEqual({state: "absent"});
    await expect(cloudflareTokenStatus(env)).resolves.toEqual({
      configured: false,
      tokenHint: "",
      updatedAtMs: null,
    });
  });

  it("saves a token and reads it back with only the last four characters exposed", async () => {
    const env = makeEnv(newDatabase());
    const status = await saveCloudflareToken(env, `  ${TOKEN}\n`);

    expect(status.configured).toBe(true);
    expect(status.tokenHint).toBe("…abcd");
    expect(status.updatedAtMs).toBeGreaterThan(0);

    await expect(cloudflareTokenStatus(env)).resolves.toEqual(status);
    await expect(readCloudflareToken(env)).resolves.toEqual({
      state: "ok",
      token: TOKEN,
      tokenHint: "…abcd",
    });
  });

  it("keeps a single row across repeated saves", async () => {
    const database = newDatabase();
    const env = makeEnv(database);
    await saveCloudflareToken(env, TOKEN);
    await saveCloudflareToken(env, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");

    const rows = database
      .prepare("SELECT id, token_hint FROM ext_cloud_usage_token")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hint).toBe("…zzzz");
  });

  it("reports unreadable when the encryption key changed", async () => {
    const database = newDatabase();
    await saveCloudflareToken(makeEnv(database), TOKEN);

    const rotated = makeEnv(database, OTHER_KEK);
    await expect(readCloudflareToken(rotated)).resolves.toEqual({
      state: "unreadable",
    });
    // 行还在，所以状态仍是「已配置」——界面据此显示「已配置但需重新保存」。
    await expect(cloudflareTokenStatus(rotated)).resolves.toMatchObject({
      configured: true,
      tokenHint: "…abcd",
    });
  });

  it("reports unreadable for a cipher that is not the expected shape", async () => {
    const database = newDatabase();
    database
      .prepare(
        "INSERT INTO ext_cloud_usage_token (id, token_cipher, token_hint, updated_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(1, "not-json", "…wxyz", 1);
    await expect(readCloudflareToken(makeEnv(database))).resolves.toEqual({
      state: "unreadable",
    });
  });

  it("clears back to absent", async () => {
    const env = makeEnv(newDatabase());
    await saveCloudflareToken(env, TOKEN);
    await expect(clearCloudflareToken(env)).resolves.toEqual({
      configured: false,
      tokenHint: "",
      updatedAtMs: null,
    });
    await expect(readCloudflareToken(env)).resolves.toEqual({state: "absent"});
  });

  it("refuses empty, whitespace-bearing, and oversized values", async () => {
    const env = makeEnv(newDatabase());
    await expect(saveCloudflareToken(env, "   ")).rejects.toThrow();
    await expect(saveCloudflareToken(env, "abc def")).rejects.toThrow();
    await expect(saveCloudflareToken(env, "x".repeat(201))).rejects.toThrow();
    await expect(readCloudflareToken(env)).resolves.toEqual({state: "absent"});
  });
});
