import {describe, expect, it} from "vitest";

import {
  adminReturnQuery,
  resolveAdminReturnTarget,
} from "@/shared/AdminReturnTarget";

function search(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("resolveAdminReturnTarget", () => {
  it("resolves the volume board with the whole expanded state", () => {
    const target = resolveAdminReturnTarget(
      search("from=volumes&bookId=bk123456789&volume=vol-key-1"),
      "admin",
    );

    expect(target).toEqual({
      labelKey: "menu.item.volumes",
      menuCode: "volumes",
      url: "/admin/volumes/?bookId=bk123456789&volume=vol-key-1",
    });
  });

  it("keeps the board's own param order whatever order the link used", () => {
    const target = resolveAdminReturnTarget(
      search("volume=unfiled&from=volumes&bookId=bk123456789"),
      "admin",
    );

    expect(target?.url).toBe("/admin/volumes/?bookId=bk123456789&volume=unfiled");
  });

  it("drops the volume when the board was collapsed", () => {
    const target = resolveAdminReturnTarget(
      search("from=volumes&bookId=bk123456789&volume="),
      "admin",
    );

    expect(target?.url).toBe("/admin/volumes/?bookId=bk123456789");
  });

  it("returns null without a board name", () => {
    expect(resolveAdminReturnTarget(search("bookId=bk123456789"), "admin")).toBeNull();
  });

  it("returns null for a board that is not registered", () => {
    expect(
      resolveAdminReturnTarget(search("from=audit&bookId=bk123456789"), "admin"),
    ).toBeNull();
  });

  it("resolves the book-scoped boards that only carry a book", () => {
    for (const [board, path, labelKey] of [
      ["fangs", "fangs", "menu.item.fangs"],
      ["yao", "yao", "menu.item.yao"],
      ["term", "term", "menu.item.term"],
    ] as const) {
      expect(
        resolveAdminReturnTarget(search(`from=${board}&bookId=bk123456789`), "admin"),
      ).toEqual({
        labelKey,
        menuCode: board,
        url: `/admin/${path}/?bookId=bk123456789`,
      });
    }
  });

  it("returns null for a book-scoped board without its book", () => {
    for (const board of ["fangs", "yao", "term"] as const) {
      expect(
        resolveAdminReturnTarget(search(`from=${board}`), "admin"),
      ).toBeNull();
    }
  });

  it("does not resolve prototype keys as board names", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(
        resolveAdminReturnTarget(search(`from=${name}&bookId=bk123456789`), "admin"),
      ).toBeNull();
    }
  });

  it("returns null when a required param is missing", () => {
    expect(resolveAdminReturnTarget(search("from=volumes&volume=vol-key-1"), "admin"))
      .toBeNull();
    expect(resolveAdminReturnTarget(search("from=volumes&bookId=%20%20"), "admin"))
      .toBeNull();
  });

  it("ignores a param long enough to be noise", () => {
    const target = resolveAdminReturnTarget(
      search(`from=volumes&bookId=bk123456789&volume=${"x".repeat(201)}`),
      "admin",
    );

    expect(target?.url).toBe("/admin/volumes/?bookId=bk123456789");
  });

  it("honours the instance's admin path", () => {
    const target = resolveAdminReturnTarget(
      search("from=volumes&bookId=bk123456789"),
      "studio",
    );

    expect(target?.url).toBe("/studio/volumes/?bookId=bk123456789");
  });
});

describe("adminReturnQuery", () => {
  it("names the board and emits its params in declared order", () => {
    expect(
      adminReturnQuery("volumes", {volume: "vol-key-1", bookId: "bk123456789"}),
    ).toBe("from=volumes&bookId=bk123456789&volume=vol-key-1");
  });

  it("omits empty params", () => {
    expect(adminReturnQuery("volumes", {bookId: "bk123456789", volume: ""}))
      .toBe("from=volumes&bookId=bk123456789");
    expect(adminReturnQuery("volumes", {bookId: "bk123456789", volume: null}))
      .toBe("from=volumes&bookId=bk123456789");
  });

  it("round-trips through resolveAdminReturnTarget", () => {
    const query = adminReturnQuery("volumes", {
      bookId: "bk123456789",
      volume: "第一卷",
    });
    const expected = new URLSearchParams({
      bookId: "bk123456789",
      volume: "第一卷",
    }).toString();

    expect(resolveAdminReturnTarget(search(query), "admin")?.url)
      .toBe(`/admin/volumes/?${expected}`);
  });

  it("rejects a board name the registry does not carry", () => {
    expect(() => adminReturnQuery("audit" as never, {bookId: "bk123456789"}))
      .toThrow(/Unknown return board/u);
  });
});
