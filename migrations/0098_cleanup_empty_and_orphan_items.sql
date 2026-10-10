-- 0098: 清理空内容占位行 + 已删除孤儿行
--
-- 问题：items 表里两类垃圾数据。
--   (1) 18 行 content_text 和 data.description 都为空——TCM 章节的导入占位符，
--       没有实际正文，永远算不出字数。分布在 3 个 book_id 下：
--         Kcb7X2K5LTh（伤寒金匮）16 行、4KbG9bDqdz3（本草）1 行、
--         tcmterm0001（中医名词）1 行。删除后各书仍有 179/173/17 行有效章节。
--   (2) 3 行 status=3（已软删除）且 book_id 为空——脱离任何书的残留记录，
--       其中 1 行还残留了标题「第二卷 第1章 星河觉醒」（来自测试数据）。
--
-- 影响：不影响任何现有功能。bookWordCounts 对这些空行返回 0；
-- 已删除行不参与任何查询（WHERE status != 3）。纯垃圾清理。
--
-- 回滚：不可逆（DELETE）。如需恢复，从备份还原。

DELETE FROM items WHERE id IN (
  -- content_text 空 + description 空（18 行）
  'F5Pf7dvj0rJ',       -- 中药 (book: 4KbG9bDqdz3)
  '1ETophp7fQf',       -- 妇人产后病脉证治第二十一
  '532t0mbQWu6',       -- 呕吐哕下利病脉证治第十七
  'B37twUrFy4g',       -- 黄瘅病证并治第十五
  'BViWWso67HJ',       -- 五藏风寒积聚病脉证并治第十一
  'KRo9WOWZgaL',       -- 痰饮欬嗽病脉证并治第十二
  'NNs6l5Xxa78',       -- 阴阳易差后劳复第二十三
  'Nm4fw2Gr7Dv',       -- 趺蹶手指臂肿转筋狐疝蚘虫病脉证治第十九
  'QAl97ziFF2o',       -- 消渴小便不利淋病脉证治第十三
  'We70C3uBvf4',       -- 腹满寒疝宿食病脉证并治第十
  'XXZi9DVgyi8',       -- 水气病脉证并治第十四
  'bQSrKNy5IaF',       -- 疮痈肠痈浸淫病脉证治第十八
  'k2XcdBgrFLp',       -- 奔豚气病脉证并治第八
  'l52LnEaErGy',       -- 妇人妊娠病脉证治第二十
  'oBYSJS4D85C',       -- 惊悸吐衄下血胸满瘀血病脉证第十六
  'qnGG70i17QW',       -- 胸痹心痛短气病脉证并治第九
  'w5t2szXzxTP',       -- 妇人杂病脉证治第二十二
  'ZDAkg3UmGf2',       -- 名词 (book: tcmterm0001)

  -- status=3 + book_id=NULL（3 行，已删除残留）
  'RLhsPgdL3U2',
  'XhJgCh3Cccc',
  'KQ3_PkVlVGe'
);
