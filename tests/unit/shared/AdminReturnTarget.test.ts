import {describe, expect, it} from "vitest";

import {
  adminReturnQuery,
  resolveAdminReturnTarget,
} from "@/shared/AdminReturnTarget";

function search(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("resolveAdminReturnTarget (no registered boards after ADR-0069)", () => {
  it("always returns null, whatever the from value", () => {
    expect(
      resolveAdminReturnTarget(search("from=volumes&bookId=bk123456789"), "admin"),
    ).toBeNull();
    expect(
      resolveAdminReturnTarget(search("from=fangs&bookId=bk123456789"), "admin"),
    ).toBeNull();
    expect(resolveAdminReturnTarget(search("from=yao&bookId=bk123456789"), "admin"))
      .toBeNull();
    expect(resolveAdminReturnTarget(search("from=term&bookId=bk123456789"), "admin"))
      .toBeNull();
  });

  it("returns null without a board name", () => {
    expect(resolveAdminReturnTarget(search("bookId=bk123456789"), "admin")).toBeNull();
  });

  it("does not resolve prototype keys as board names", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(
        resolveAdminReturnTarget(search(`from=${name}&bookId=bk123456789`), "admin"),
      ).toBeNull();
    }
  });

  it("is independent of the instance's admin path", () => {
    expect(resolveAdminReturnTarget(search("from=volumes&bookId=bk123456789"), "studio"))
      .toBeNull();
  });
});

describe("adminReturnQuery (no registered boards after ADR-0069)", () => {
  it("rejects every board name", () => {
    for (const board of ["volumes", "fangs", "yao", "term", "audit"]) {
      expect(() =>
        adminReturnQuery(board as never, {bookId: "bk123456789"}),
      ).toThrow(/Unknown return board/u);
    }
  });
});
