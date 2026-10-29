import {describe, expect, it} from "vitest";

import {baseUsername, deriveUniqueUsername} from "@/server/app/email-register/username";
import {makeD1, makeSqlite} from "./helpers/d1";

/**
 * 用户名推导与冲突后缀（ADR §6.1「`deriveUsername` 冲突后缀」）。
 *
 * `auth_user.username` 带唯一索引，两个不同邮箱的本地部分撞车是常态
 * （`zhang@a.com` 与 `zhang@b.com`）。撞车后必须换一个能插进去的名字，
 * 否则整个注册会失败。
 */

const SCHEMA = `
  CREATE TABLE auth_user (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    username TEXT
  );
`;

function makeDb() {
  const sqlite = makeSqlite(SCHEMA);
  return {sqlite, db: makeD1(sqlite)};
}

describe("baseUsername", () => {
  it("取邮箱本地部分并转小写", () => {
    expect(baseUsername("Zhang.San@Example.com")).toBe("zhang.san");
  });

  it("去掉用户名不允许的字符", () => {
    expect(baseUsername("zhang+san@example.com")).toBe("zhangsan");
    expect(baseUsername("张san@example.com")).toBe("san");
  });

  it("本地部分全是非法字符时回落到 user", () => {
    expect(baseUsername("@example.com")).toBe("user");
  });

  it("超长本地部分截断到 32 个字符", () => {
    const localPart = "a".repeat(60);
    expect(baseUsername(`${localPart}@example.com`)).toHaveLength(32);
  });
});

describe("deriveUniqueUsername", () => {
  it("没冲突时直接用基名", async () => {
    const {db} = makeDb();
    expect(await deriveUniqueUsername(db, "zhang")).toBe("zhang");
  });

  it("基名已占用时追加 4 位后缀，且与已有名字不同", async () => {
    const {sqlite, db} = makeDb();
    sqlite
      .prepare("INSERT INTO auth_user (id, name, email, username) VALUES (?, ?, ?, ?)")
      .run("u1", "zhang", "zhang@a.com", "zhang");

    const candidate = await deriveUniqueUsername(db, "zhang");
    expect(candidate).not.toBe("zhang");
    expect(candidate).toMatch(/^zhang[a-z0-9]{4}$/u);
  });

  it("同一个基名连续推导两次会得到不同的候选名", async () => {
    const {sqlite, db} = makeDb();
    sqlite
      .prepare("INSERT INTO auth_user (id, name, email, username) VALUES (?, ?, ?, ?)")
      .run("u1", "zhang", "zhang@a.com", "zhang");

    const first = await deriveUniqueUsername(db, "zhang");
    const second = await deriveUniqueUsername(db, "zhang");
    // 后缀是 CSPRNG 随机值，重复概率 1/36^4；相等说明随机源没接上。
    expect(first).not.toBe(second);
  });

  it("返回的名字一定没被占用", async () => {
    const {sqlite, db} = makeDb();
    sqlite
      .prepare("INSERT INTO auth_user (id, name, email, username) VALUES (?, ?, ?, ?)")
      .run("u1", "zhang", "zhang@a.com", "zhang");

    for (let i = 0; i < 20; i += 1) {
      const candidate = await deriveUniqueUsername(db, "zhang");
      expect(sqlite.prepare("SELECT 1 FROM auth_user WHERE username = ?").get(candidate))
        .toBeUndefined();
    }
  });
});
