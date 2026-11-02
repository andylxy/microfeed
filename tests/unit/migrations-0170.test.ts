/**
 * 0170：`auth_user.signup_source` 的索引。
 *
 * 它服务的是 `getSignupSources` 里那条 `SELECT DISTINCT signup_source`——没有
 * 索引时计划是 `SCAN auth_user` + `USE TEMP B-TREE FOR DISTINCT`，随账号数线性
 * 增长且每次用户页加载都付一遍。
 */
import {readFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function migration0170(): Promise<string> {
  return readFile(
    path.join(repositoryRoot, "migrations", "0170_index_auth_user_signup_source.sql"),
    "utf8",
  );
}

describe("0170 的索引", () => {
  it("建成后 DISTINCT 走覆盖索引，不再需要临时 B-tree", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      'CREATE TABLE "auth_user" ("id" TEXT PRIMARY KEY, "signup_source" TEXT NOT NULL)',
    );
    database.exec(await migration0170());

    const plan = database
      .prepare("EXPLAIN QUERY PLAN SELECT DISTINCT signup_source FROM auth_user")
      .all()
      .map((row) => String((row as {detail: string}).detail));

    expect(plan.some((line) => line.includes("ix_auth_user_signup_source"))).toBe(true);
    expect(plan.some((line) => line.includes("TEMP B-TREE"))).toBe(false);
  });

  it("重放不炸（IF NOT EXISTS）", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      'CREATE TABLE "auth_user" ("id" TEXT PRIMARY KEY, "signup_source" TEXT NOT NULL)',
    );
    const body = await migration0170();
    database.exec(body);
    expect(() => database.exec(body)).not.toThrow();
  });
});
