-- 0099: 恢复被 0098 误删的 TCM 根 chapter
--
-- 根因：0098 清理"空内容垃圾"时，把 2 个 TCM 书的根 chapter 也删了。
--       中药书根 chapter (id=F5Pf7dvj0rJ) 和名词书根 chapter (id=ZDAkg3UmGf2)
--       恰好都是 content_text 空 + description 空——但它们是目录占位符，
--       不是内容条目。删除后 172 条 yao 和 17 条 term 的 tcm_parent_id 悬空。
--
-- 修复：重新插入这两个根 chapter（确定性 id，与 import-yao.mjs / import-term.mjs
--       生成的完全一致），恢复 189 条断裂引用。
--
-- 验证：
--   中药书根 chapter → 172 条 yao 重新挂载
--   名词书根 chapter → 17 条 term 重新挂载
--
-- 回滚：不可逆（INSERT）。如需恢复，从备份还原。
-- 幂等性：使用 INSERT OR IGNORE，重复执行不会报错。

INSERT OR IGNORE INTO items (id, status, data, pub_date, created_at, updated_at,
  content_text, content_text_updated_at, content_text_revision, review_status,
  book_id, tcm_kind, tcm_parent_id)
VALUES (
  'F5Pf7dvj0rJ', 1,
  '{"title":"中药","description":"","content_format":"html","_microfeed":{"bookId":"4KbG9bDqdz3","section":1}}',
  '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
  '', '2024-01-01T00:00:00.000Z', 1, NULL,
  '4KbG9bDqdz3', 'chapter', NULL
);

INSERT OR IGNORE INTO items (id, status, data, pub_date, created_at, updated_at,
  content_text, content_text_updated_at, content_text_revision, review_status,
  book_id, tcm_kind, tcm_parent_id)
VALUES (
  'ZDAkg3UmGf2', 1,
  '{"title":"名词","description":"","content_format":"html","_microfeed":{"bookId":"tcmterm0001","section":1}}',
  '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
  '', '2024-01-01T00:00:00.000Z', 1, NULL,
  'tcmterm0001', 'chapter', NULL
);
