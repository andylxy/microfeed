-- Novel CMS extension tables.
--
-- Everything here lives in the `ext_` namespace and is purely additive so it
-- stays upgrade-safe: applying this migration on top of an upstream microfeed
-- schema adds new tables/columns without touching any existing ones. Upgrade
-- rebase only needs to keep this file's number (0023) after the latest
-- upstream migration.

-- ---------------------------------------------------------------------------
-- Categories (single primary category + free multi-tag supported elsewhere)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ext_category (
  id VARCHAR(11) PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id VARCHAR(11),
  sort INTEGER DEFAULT 0,
  visible BOOLEAN DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ext_category_parent_id ON ext_category (parent_id);
CREATE INDEX IF NOT EXISTS ext_category_slug ON ext_category (slug);
CREATE INDEX IF NOT EXISTS ext_category_sort ON ext_category (sort);

-- ---------------------------------------------------------------------------
-- Content audit trail (field-level diff + periodic checkpoints, ADR-0003)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ext_content_audit (
  id VARCHAR(11) PRIMARY KEY,
  item_id VARCHAR(11),
  channel_id VARCHAR(11),
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  diff_data TEXT,
  checkpoint_data TEXT,
  is_checkpoint BOOLEAN DEFAULT 0,
  review_status TEXT,
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ext_content_audit_item_id ON ext_content_audit (item_id);
CREATE INDEX IF NOT EXISTS ext_content_audit_channel_id ON ext_content_audit (channel_id);
CREATE INDEX IF NOT EXISTS ext_content_audit_created_at ON ext_content_audit (created_at);
CREATE INDEX IF NOT EXISTS ext_content_audit_review_status ON ext_content_audit (review_status);

-- ---------------------------------------------------------------------------
-- Reader content reports (abuse / takedown queue)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ext_content_report (
  id VARCHAR(11) PRIMARY KEY,
  item_id VARCHAR(11),
  channel_id VARCHAR(11),
  reporter_type TEXT,
  category TEXT,
  detail TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ext_content_report_item_id ON ext_content_report (item_id);
CREATE INDEX IF NOT EXISTS ext_content_report_status ON ext_content_report (status);

-- ---------------------------------------------------------------------------
-- Additive query columns (mirrored from item/channel `data` for indexed lookup)
-- ---------------------------------------------------------------------------
ALTER TABLE items ADD COLUMN review_status TEXT;
CREATE INDEX IF NOT EXISTS items_review_status ON items (review_status);

ALTER TABLE channels ADD COLUMN genre TEXT;
CREATE INDEX IF NOT EXISTS channels_genre ON channels (genre);
