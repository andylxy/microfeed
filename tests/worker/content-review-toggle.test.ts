import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {updateAdminFeed} from "@/pages/[adminPath]/ajax/feed";
import FeedDb from "@/server/feed/FeedDb";
import {SETTINGS_CATEGORIES, STATUSES} from "@/shared/Constants";

const ORIGIN = "https://feed.example.com";
const ITEM_ID = "review-toggle-item";

function feedRequest(body: unknown): Request {
  return new Request(`${ORIGIN}/admin/ajax/feed/`, {
    body: JSON.stringify(body),
    headers: {"content-type": "application/json"},
    method: "POST",
  });
}

async function saveItem(title: string): Promise<Response> {
  return updateAdminFeed(
    feedRequest({
      item: {
        id: ITEM_ID,
        pubDateMs: Date.now(),
        status: STATUSES.PUBLISHED,
        title,
      },
    }),
    env,
    () => undefined,
  );
}

async function setReviewEnabled(enabled: boolean): Promise<Response> {
  return updateAdminFeed(
    feedRequest({
      settings: {[SETTINGS_CATEGORIES.CONTENT_REVIEW]: {enabled}},
    }),
    env,
    () => undefined,
  );
}

async function storedTitle(): Promise<string | null> {
  const row = await env.FEED_DB.prepare(
    "SELECT json_extract(data, '$.title') AS title FROM items WHERE id = ?",
  ).bind(ITEM_ID).first<{title: string}>();
  return row?.title ?? null;
}

async function reviewRows(): Promise<Array<{status: string}>> {
  const result = await env.FEED_DB.prepare(
    "SELECT status FROM ext_content_review WHERE item_id = ? ORDER BY rowid",
  ).bind(ITEM_ID).all();
  return (result.results ?? []) as Array<{status: string}>;
}

beforeEach(async () => {
  await new FeedDb(env, new Request(`${ORIGIN}/admin/`)).getContent();
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM items WHERE id = ?").bind(ITEM_ID),
    env.FEED_DB.prepare(
      "DELETE FROM ext_content_review WHERE item_id = ?",
    ).bind(ITEM_ID),
    env.FEED_DB.prepare(
      "DELETE FROM ext_content_audit WHERE item_id = ?",
    ).bind(ITEM_ID),
    env.FEED_DB.prepare(
      "DELETE FROM settings WHERE category = ?",
    ).bind(SETTINGS_CATEGORIES.CONTENT_REVIEW),
  ]);
});

describe("content review switch", () => {
  it("applies a save immediately by default (no pending version, no pin)", async () => {
    const first = await saveItem("First title");
    expect(first.status).toBe(200);
    expect(await storedTitle()).toBe("First title");

    const second = await saveItem("Second title");
    expect(second.status).toBe(200);
    expect(await storedTitle()).toBe("Second title");
    expect(await reviewRows()).toEqual([]);
  });

  it("holds a save back as pending when review is enabled", async () => {
    await saveItem("Approved baseline");
    const enabled = await setReviewEnabled(true);
    expect(enabled.status).toBe(200);

    const edit = await saveItem("Edited while review on");
    expect(edit.status).toBe(200);
    // The gate pinned the body back to the last approved content, so the
    // edited title is NOT what the live row holds — this is exactly the
    // "saved but nothing changed" experience the switch explains.
    expect(await storedTitle()).toBe("Approved baseline");

    const rows = await reviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
  });

  it("rejects every pending version when the switch turns off", async () => {
    await saveItem("Approved baseline");
    await setReviewEnabled(true);
    await saveItem("Queued edit one");
    await saveItem("Queued edit two");
    expect(
      (await reviewRows()).filter((row) => row.status === "pending"),
    ).toHaveLength(2);
    expect(await storedTitle()).toBe("Approved baseline");

    const disabled = await setReviewEnabled(false);
    expect(disabled.status).toBe(200);
    // Every queued version dies as rejected; the body stays at the approved
    // content it was pinned to (a rejection restores, it does not publish).
    expect(
      (await reviewRows()).filter((row) => row.status === "pending"),
    ).toEqual([]);
    expect(
      (await reviewRows()).every((row) => row.status === "rejected"),
    ).toBe(true);
    expect(await storedTitle()).toBe("Approved baseline");

    // And with review off, saving is immediate again.
    const after = await saveItem("Live again");
    expect(after.status).toBe(200);
    expect(await storedTitle()).toBe("Live again");
  });

  it("still records the audit trail with review off", async () => {
    await saveItem("Audited edit");
    const audit = await env.FEED_DB.prepare(
      "SELECT COUNT(*) AS count FROM ext_content_audit WHERE item_id = ?",
    ).bind(ITEM_ID).first<{count: number}>();
    expect(audit?.count ?? 0).toBeGreaterThan(0);
  });
});
