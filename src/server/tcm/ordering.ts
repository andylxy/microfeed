/**
 * TCM 篇章排序键 —— App `GetBookChapter`（reads.ts）、公开书页目录
 * （extCategory.ts）、后台卷面板（extVolume.ts）三处共用同一条 ORDER BY。
 *
 * netcore 按源主键（BookInfoId）序返回篇章 —— 唯一能同时解释两类反例的排序：
 * 9040000 的「前言」（section=904000203）排第 3（数值序会垫底）、10001 的
 * section 0..21 按数字序（字符串序会排成 0,1,10,11,…）。build.ts 把书内主键
 * 排名写进 `_microfeed.no`；本键优先用 no，无 no 的存量书（桂林古本，等宽
 * section）回落 section 字符串序，结果与其主键序一致。2026-10-01 第八轮。
 */
export const TCM_CHAPTER_ORDER_SQL =
  "COALESCE(json_extract(data, '$._microfeed.no'), CAST(json_extract(data, '$._microfeed.section') AS TEXT)), id";
