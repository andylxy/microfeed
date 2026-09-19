-- ---------------------------------------------------------------------------
-- Pending content versions (the review chain that was missing)
--
-- Before this, "pending review" was a label (`items.review_status`) that no
-- code ever set, and the queue read the chapter's LIVE body — so content could
-- change freely after entering review and a rejection could not undo anything.
--
-- Now every content change funnels through one entry point
-- (`extContentReview.recordContentChange`), which stores the state BEFORE the
-- change as a pending version. The queue lists chapters with unconfirmed
-- versions; confirming approves them, rejecting restores the snapshot.
--
-- Additive only: no existing table or column is dropped or renamed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ext_content_review (
  id VARCHAR(11) PRIMARY KEY,
  item_id VARCHAR(11) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  -- What the change was, field by field (rendered as the review diff).
  diff_data TEXT,
  -- The chapter's data BEFORE this change. Rejection restores exactly this,
  -- which is what makes rejecting meaningful instead of cosmetic.
  snapshot_data TEXT NOT NULL,
  action TEXT NOT NULL,
  submitted_by TEXT,
  submitted_at INTEGER,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS ext_content_review_item_id
  ON ext_content_review (item_id);
CREATE INDEX IF NOT EXISTS ext_content_review_status
  ON ext_content_review (status);
CREATE INDEX IF NOT EXISTS ext_content_review_submitted_at
  ON ext_content_review (submitted_at);
