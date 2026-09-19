-- ---------------------------------------------------------------------------
-- Content correction proposals (ADR: review = content correction, not a gate)
--
-- Reviewing means checking what the READER PAGE renders. When a page is wrong,
-- the reviewer who owns that page submits a correction; nothing touches the
-- item until someone confirms "同意更新最新修改". On approval the proposed data
-- is written back to the ORIGINAL storage location (items.data), and the trail
-- answers: who submitted / what changed / who approved.
--
-- Additive only: no existing table or column is dropped or renamed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ext_content_correction (
  id VARCHAR(11) PRIMARY KEY,
  item_id VARCHAR(11) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Field-level diff against the data current at submit time; rendered as the
  -- "更新了什么" view.
  diff_data TEXT,
  -- Full proposed `data`, applied verbatim on approval. Stored alongside the
  -- diff on purpose: the diff is for humans, this is for the write-back.
  proposed_data TEXT NOT NULL,
  -- Who submitted the update (the page's reviewer) and when.
  submitted_by TEXT,
  submitted_at INTEGER,
  -- Who confirmed (同意) or rejected it, and when. Equal to submitted_by is
  -- allowed and recorded honestly - v1 has a single admin (see §7.7).
  reviewed_by TEXT,
  reviewed_at INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS ext_content_correction_item_id
  ON ext_content_correction (item_id);
CREATE INDEX IF NOT EXISTS ext_content_correction_status
  ON ext_content_correction (status);

-- ---------------------------------------------------------------------------
-- Approval linkage on the audit trail (additive).
-- The row written when an approved correction lands records the approver, so a
-- history read never has to guess who signed off on a change.
-- ---------------------------------------------------------------------------
ALTER TABLE ext_content_audit ADD COLUMN approved_by TEXT;
ALTER TABLE ext_content_audit ADD COLUMN approved_at INTEGER;
