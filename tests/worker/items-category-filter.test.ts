import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";

import {listAdminItems} from "@/server/items/admin-list";
import {STATUSES} from "@/shared/Constants";

const CATEGORY_ID = "filtercat01";
const BOOK_ID = "filterbook1";
const ITEM_IDS = ["catfilter-a", "catfilter-b", "catfilter-c"];

async function seed() {
  // A category, a book filed under it, and three chapters — only two belong to
  // that book.
  await env.FEED_DB.prepare("DELETE FROM ext_category WHERE id = ?")
    .bind(CATEGORY_ID).run();
  await env.FEED_DB.prepare(
    "INSERT INTO ext_category (id, name, slug, parent_id, sort, visible, created_at) " +
      "VALUES (?, ?, ?, NULL, 0, 1, ?)",
  ).bind(CATEGORY_ID, "Filter category", "filter-category", Date.now()).run();

  await env.FEED_DB.prepare("DELETE FROM channels WHERE id = ?")
    .bind(BOOK_ID).run();
  await env.FEED_DB.prepare(
    "INSERT INTO channels (id, data, created_at, status, genre) VALUES (?, ?, ?, ?, ?)",
  ).bind(
    BOOK_ID,
    JSON.stringify({title: "Filter book"}),
    new Date().toISOString(),
    STATUSES.PUBLISHED,
    CATEGORY_ID,
  ).run();

  await env.FEED_DB.prepare(
    "DELETE FROM items WHERE id LIKE 'catfilter-%'",
  ).run();
  await env.FEED_DB.batch(ITEM_IDS.map((id, index) =>
    env.FEED_DB.prepare(
      "INSERT INTO items (id, status, data, pub_date, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      STATUSES.PUBLISHED,
      JSON.stringify({
        // The last chapter stays unassigned on purpose.
        ...(index < 2 ? {_microfeed: {bookId: BOOK_ID}} : {}),
        title: `Chapter ${id}`,
      }),
      "2026-08-04T10:00:00.000Z",
      "2026-08-04T10:00:00.000Z",
      "2026-08-04T1" + String(index) + ":00:00.000Z",
    )
  ));
}

function adminList(searchParams: Record<string, string> = {}) {
  const request = new Request(
    `https://feed.example.com/admin/ajax/items/?${new URLSearchParams(searchParams)}`,
  );
  return listAdminItems(env.FEED_DB, request, {limit: 20});
}

describe("admin item list novel-cms filtering", () => {
  it("returns the book name and category for every chapter", async () => {
    await seed();
    const all = await adminList();
    const byId = new Map(all.items.map((item) => [item.id, item]));

    expect(byId.get("catfilter-a")?.bookTitle).toBe("Filter book");
    expect(byId.get("catfilter-a")?.categoryName).toBe("Filter category");
    expect(byId.get("catfilter-c")?.bookTitle).toBeUndefined();
  });

  it("filters chapters by the category of their book", async () => {
    await seed();
    const all = await adminList();
    expect(all.items.length).toBe(ITEM_IDS.length);

    const filtered = await adminList({categoryId: CATEGORY_ID});
    expect(filtered.items.map((item) => item.id).sort()).toEqual([
      "catfilter-a",
      "catfilter-b",
    ]);
    expect(filtered.categoryFilter).toBe(CATEGORY_ID);
  });

  it("offers the categories so the list can render its filter row", async () => {
    await seed();
    const listing = await adminList();
    expect(listing.categories?.some(
      (category) => category.id === CATEGORY_ID,
    )).toBe(true);
  });

  it("narrows the list to one book's chapters while the category stays applied", async () => {
    // The combination is the whole point of the drill-down. It also used to be
    // broken in a way each single filter hid: the SQL asks for the category
    // before the book, so pushing the book's value into `bindings` first bound a
    // book id to the genre comparison and matched nothing.
    await seed();
    const both = await adminList({
      bookId: BOOK_ID,
      categoryId: CATEGORY_ID,
    });
    expect(both.items.map((item) => item.id).sort()).toEqual([
      "catfilter-a",
      "catfilter-b",
    ]);
    expect(both.bookFilter).toBe(BOOK_ID);
    expect(both.categoryFilter).toBe(CATEGORY_ID);
    // And it must be a real narrowing, not the category on its own.
    const categoryOnly = await adminList({categoryId: CATEGORY_ID});
    expect(categoryOnly.items.length).toBe(both.items.length);
  });

  it("narrows the list to one book's chapters", async () => {
    await seed();
    const filtered = await adminList({bookId: BOOK_ID});
    expect(filtered.items.map((item) => item.id).sort()).toEqual([
      "catfilter-a",
      "catfilter-b",
    ]);
    // Echoed so paging and sorting keep the drill-down step.
    expect(filtered.bookFilter).toBe(BOOK_ID);
  });

  it("offers the books of the chosen category for the drill-down", async () => {
    await seed();
    const listing = await adminList({categoryId: CATEGORY_ID});
    expect(listing.books).toEqual([{id: BOOK_ID, title: "Filter book"}]);
  });

  it("keeps category and book independent when only a book is asked for", async () => {
    // A book narrows on its own; the category is what supplies the book list,
    // so asking for a book without one must still work.
    await seed();
    const filtered = await adminList({bookId: BOOK_ID});
    expect(filtered.books).toBeUndefined();
    expect(filtered.categoryFilter).toBeUndefined();
  });
});
