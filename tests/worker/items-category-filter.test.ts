import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";

import {listAdminItems} from "@/server/items/admin-list";
import {STATUSES} from "@/shared/Constants";

const CATEGORY_ID = "filtercat01";
const BOOK_ID = "filterbook1";
const ITEM_IDS = ["catfilter-a", "catfilter-b", "catfilter-c"];

async function seed() {
  // 一个分类、一本归在该分类下的书、三个篇章，其中只有两个属于这本书。
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
    // 0113 的触发器从 JSON 回填 genre 镜像列，JSON 里缺少 genre 会把列写成 NULL。
    JSON.stringify({_microfeed: {genre: CATEGORY_ID}, title: "Filter book"}),
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
        // 最后一个篇章故意不带书归属。
        ...(index < 2 ? {_microfeed: {bookId: BOOK_ID}} : {}),
        title: `Chapter ${id}`,
      }),
      "2026-08-04T10:00:00.000Z",
      "2026-08-04T10:00:00.000Z",
      "2026-08-04T1" + String(index) + ":00:00.000Z",
    )
  ));
}

const PAGED_CATEGORY_ID = "filtercat02";
const HIDDEN_CATEGORY_ID = "filtercat03";
const PAGED_BOOK_IDS = ["catpage-book1", "catpage-book2"] as const;
const HIDDEN_BOOK_ID = "catpage-hidden-book";
// updated_at 递增，倒序首页即 e、d、c、b、a；前四行分散在两本书里，
// 分类列表要为每本书单独发一条分支再归并。
const PAGED_ITEMS = [
  {bookId: PAGED_BOOK_IDS[0], id: "catpage-a", hour: 10},
  {bookId: PAGED_BOOK_IDS[1], id: "catpage-b", hour: 11},
  {bookId: PAGED_BOOK_IDS[0], id: "catpage-c", hour: 12},
  {bookId: PAGED_BOOK_IDS[1], id: "catpage-d", hour: 13},
  {bookId: PAGED_BOOK_IDS[0], id: "catpage-e", hour: 14},
];

async function seedPagedCategory() {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_category WHERE id IN (?, ?)")
      .bind(PAGED_CATEGORY_ID, HIDDEN_CATEGORY_ID),
    env.FEED_DB.prepare("DELETE FROM items WHERE id LIKE 'catpage-%'"),
    env.FEED_DB.prepare("DELETE FROM channels WHERE id LIKE 'catpage-%'"),
  ]);
  await env.FEED_DB.batch([
    env.FEED_DB.prepare(
      "INSERT INTO ext_category (id, name, slug, parent_id, sort, visible, created_at) " +
        "VALUES (?, ?, ?, NULL, 0, 1, ?)",
    ).bind(PAGED_CATEGORY_ID, "Paged category", "paged-category", Date.now()),
    env.FEED_DB.prepare(
      "INSERT INTO ext_category (id, name, slug, parent_id, sort, visible, created_at) " +
        "VALUES (?, ?, ?, NULL, 0, 1, ?)",
    ).bind(HIDDEN_CATEGORY_ID, "Hidden category", "hidden-category", Date.now()),
    ...PAGED_BOOK_IDS.map((id, index) =>
      env.FEED_DB.prepare(
        "INSERT INTO channels (id, data, created_at, status, genre) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        id,
        JSON.stringify({
          _microfeed: {genre: PAGED_CATEGORY_ID},
          title: `Paged book ${index + 1}`,
        }),
        new Date().toISOString(),
        STATUSES.PUBLISHED,
        PAGED_CATEGORY_ID,
      )
    ),
    // 未发布的书不进入下拉筛选，旧的行走过滤却会匹配它的章节；
    // 分类分支列表保持这一行集。
    env.FEED_DB.prepare(
      "INSERT INTO channels (id, data, created_at, status, genre) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      HIDDEN_BOOK_ID,
      JSON.stringify({
        _microfeed: {genre: HIDDEN_CATEGORY_ID},
        title: "Hidden book",
      }),
      new Date().toISOString(),
      STATUSES.UNPUBLISHED,
      HIDDEN_CATEGORY_ID,
    ),
  ]);
  await env.FEED_DB.batch([
    ...PAGED_ITEMS.map(({bookId, id, hour}) =>
      env.FEED_DB.prepare(
        "INSERT INTO items (id, status, data, pub_date, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        id,
        STATUSES.PUBLISHED,
        JSON.stringify({_microfeed: {bookId}, title: `Chapter ${id}`}),
        "2026-08-05T10:00:00.000Z",
        "2026-08-05T10:00:00.000Z",
        `2026-08-05T${String(hour)}:00:00.000Z`,
      )
    ),
    env.FEED_DB.prepare(
      "INSERT INTO items (id, status, data, pub_date, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      "catpage-hidden",
      STATUSES.PUBLISHED,
      JSON.stringify({
        _microfeed: {bookId: HIDDEN_BOOK_ID},
        title: "Hidden chapter",
      }),
      "2026-08-05T10:00:00.000Z",
      "2026-08-05T10:00:00.000Z",
      "2026-08-05T10:00:00.000Z",
    ),
  ]);
}

function adminList(
  searchParams: Record<string, string> = {},
  limit = 20,
) {
  const request = new Request(
    `https://feed.example.com/admin/ajax/items/?${new URLSearchParams(searchParams)}`,
  );
  return listAdminItems(env.FEED_DB, request, {limit});
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

describe("admin item list category pagination across books", () => {
  it("pages a category-only list across both books without gaps or duplicates", async () => {
    await seedPagedCategory();
    const first = await adminList({categoryId: PAGED_CATEGORY_ID}, 2);
    expect(first.items.map((item) => item.id)).toEqual([
      "catpage-e",
      "catpage-d",
    ]);
    expect(first.nextCursor).toBeDefined();
    expect(first.prevCursor).toBeUndefined();

    const second = await adminList({
      categoryId: PAGED_CATEGORY_ID,
      next_cursor: String(first.nextCursor),
    }, 2);
    expect(second.items.map((item) => item.id)).toEqual([
      "catpage-c",
      "catpage-b",
    ]);
    expect(second.nextCursor).toBeDefined();
    expect(second.prevCursor).toBeDefined();

    const third = await adminList({
      categoryId: PAGED_CATEGORY_ID,
      next_cursor: String(second.nextCursor),
    }, 2);
    expect(third.items.map((item) => item.id)).toEqual(["catpage-a"]);
    expect(third.nextCursor).toBeUndefined();
    expect(third.prevCursor).toBeDefined();

    // 从第二页的首行往回翻，按显示顺序返回第一页的内容。
    const back = await adminList({
      categoryId: PAGED_CATEGORY_ID,
      prev_cursor: String(second.prevCursor),
    }, 2);
    expect(back.items.map((item) => item.id)).toEqual([
      "catpage-e",
      "catpage-d",
    ]);
    expect(back.prevCursor).toBeUndefined();

    const seen = [first, second, third].flatMap((page) =>
      page.items.map((item) => item.id)
    );
    expect(seen.sort()).toEqual(PAGED_ITEMS.map(({id}) => id).sort());
  });

  it("includes chapters whose book is unpublished, as the row filter always did", async () => {
    await seedPagedCategory();
    const filtered = await adminList({categoryId: HIDDEN_CATEGORY_ID});
    expect(filtered.items.map((item) => item.id)).toEqual(["catpage-hidden"]);
    // 下拉筛选只保留已发布、非容器的 channel，这本书因此不进入筛选，
    // 它的章节仍会列出。
    expect(filtered.books).toBeUndefined();
  });

  it("returns an empty page for a category without books", async () => {
    await seedPagedCategory();
    const filtered = await adminList({categoryId: "filtercat-missing"});
    expect(filtered.items).toEqual([]);
    expect(filtered.categoryFilter).toBe("filtercat-missing");
    expect(filtered.nextCursor).toBeUndefined();
    expect(filtered.prevCursor).toBeUndefined();
  });

  it("keeps the book filter applied together with the category", async () => {
    await seedPagedCategory();
    const filtered = await adminList({
      categoryId: PAGED_CATEGORY_ID,
      bookId: PAGED_BOOK_IDS[0],
    });
    expect(filtered.items.map((item) => item.id).sort()).toEqual([
      "catpage-a",
      "catpage-c",
      "catpage-e",
    ]);
  });
});

const CHUNK_CATEGORY_ID = "filtercat04";
const CHUNK_BOOK_COUNT = 40;
const CHUNK_ITEM_IDS = Array.from(
  {length: CHUNK_BOOK_COUNT},
  (_, index) => `catchunk-${String(index).padStart(2, "0")}`,
);

async function seedChunkedCategory() {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_category WHERE id = ?")
      .bind(CHUNK_CATEGORY_ID),
    env.FEED_DB.prepare("DELETE FROM items WHERE id LIKE 'catchunk-%'"),
    env.FEED_DB.prepare("DELETE FROM channels WHERE id LIKE 'catchunk-book-%'"),
  ]);
  await env.FEED_DB.prepare(
    "INSERT INTO ext_category (id, name, slug, parent_id, sort, visible, created_at) " +
      "VALUES (?, ?, ?, NULL, 0, 1, ?)",
  ).bind(CHUNK_CATEGORY_ID, "Chunk category", "chunk-category", Date.now()).run();
  await env.FEED_DB.batch(
    Array.from({length: CHUNK_BOOK_COUNT}, (_, index) =>
      env.FEED_DB.prepare(
        "INSERT INTO channels (id, data, created_at, status, genre) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        `catchunk-book-${index}`,
        JSON.stringify({
          _microfeed: {genre: CHUNK_CATEGORY_ID},
          title: `Chunk book ${index}`,
        }),
        new Date().toISOString(),
        STATUSES.PUBLISHED,
        CHUNK_CATEGORY_ID,
      )
    ),
  );
  await env.FEED_DB.batch(CHUNK_ITEM_IDS.map((id, index) =>
    env.FEED_DB.prepare(
      "INSERT INTO items (id, status, data, pub_date, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      STATUSES.PUBLISHED,
      JSON.stringify({
        _microfeed: {bookId: `catchunk-book-${index}`},
        title: `Chunk chapter ${index}`,
      }),
      "2026-08-06T10:00:00.000Z",
      "2026-08-06T10:00:00.000Z",
      new Date(Date.UTC(2026, 7, 6, 0, 0, 0) + index * 3_600_000).toISOString(),
    )
  ));
}

describe("admin item list category books beyond one statement's bind budget", () => {
  // 40 本书、每分支 3 个绑定参数时一条语句放不下全部书（上限 100 个参数，
  // 每条语句为外层 LIMIT 保留 1 个绑定参数，最多 33 个分支）。翻页后每分支另有 3 个
  // 游标参数，单条语句只放得下 16 个分支，分片更多。
  it("merges chunked branches into one ordered page", async () => {
    await seedChunkedCategory();
    const first = await adminList({categoryId: CHUNK_CATEGORY_ID}, 5);
    expect(first.items.map((item) => item.id)).toEqual([
      "catchunk-39",
      "catchunk-38",
      "catchunk-37",
      "catchunk-36",
      "catchunk-35",
    ]);
    expect(first.nextCursor).toBeDefined();

    const second = await adminList({
      categoryId: CHUNK_CATEGORY_ID,
      next_cursor: String(first.nextCursor),
    }, 5);
    expect(second.items.map((item) => item.id)).toEqual([
      "catchunk-34",
      "catchunk-33",
      "catchunk-32",
      "catchunk-31",
      "catchunk-30",
    ]);
  });

  it("applies the kind filter inside every chunked branch", async () => {
    await seedChunkedCategory();
    await env.FEED_DB.batch([
      env.FEED_DB.prepare("UPDATE items SET tcm_kind = 'section' WHERE id = ?")
        .bind("catchunk-01"),
      env.FEED_DB.prepare("UPDATE items SET tcm_kind = 'section' WHERE id = ?")
        .bind("catchunk-39"),
    ]);
    const filtered = await adminList({
      categoryId: CHUNK_CATEGORY_ID,
      tcmKind: "section",
    }, 5);
    expect(filtered.items.map((item) => item.id)).toEqual([
      "catchunk-39",
      "catchunk-01",
    ]);
    expect(filtered.tcmKindFilter).toBe("section");
  });

  it("keeps the SQL tie-break when every row shares the sort timestamp", async () => {
    await seedChunkedCategory();
    const listing = await adminList({
      categoryId: CHUNK_CATEGORY_ID,
      order: "asc",
      sort: "created_at",
    }, 3);
    expect(listing.items.map((item) => item.id)).toEqual([
      "catchunk-00",
      "catchunk-01",
      "catchunk-02",
    ]);
  });
});
