import {D1_MAX_BOUND_PARAMS, STATUSES} from "@/shared/Constants";

/** 最小 D1 形态数据库端口：真实 D1 与单测 fake 都能结构化满足。 */
interface SectionQueryDb {
  prepare(query: string): SectionQueryStatement;
}
interface SectionQueryStatement {
  bind(...values: unknown[]): SectionQueryStatement;
  all(): Promise<{results: Record<string, unknown>[]}>;
}

export interface FetchSectionsOptions {
  /** 只取 `tcm_kind = 'section'` 的条文（书页目录用）；卷看板不传，按 parent 取全部子项。 */
  tcmKindSection?: boolean;
}

/**
 * 一次（按 D1 单语句参数上限分片）取回若干 parent 下的全部条文，按 `tcm_parent_id`
 * 归并成 Map。取代「每个 parent 各查一次」的 N 次往返。
 *
 * 排序键以 `tcm_parent_id` 打头，命中迁移 0094 的 `items_section_order` 索引
 * （tcm_parent_id, COALESCE(receiptNo, no), id），消除 `USE TEMP B-TREE FOR ORDER BY`；
 * 调用方取回后按 parent 重新分组、只保留组内相对顺序，故全局序先按 parent 不改变
 * 任何 parent 内部的条文顺序（正确性不变）。每片最多 `D1_MAX_BOUND_PARAMS - 1` 个 id，
 * 把 `status != ?` 那 1 个绑定参数也留在上限之内。
 */
export async function fetchSectionsByParents(
  db: SectionQueryDb,
  parentIds: Array<string>,
  options: FetchSectionsOptions = {},
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const result = new Map<string, Array<Record<string, unknown>>>();
  if (parentIds.length === 0) return result;
  const chunkSize = D1_MAX_BOUND_PARAMS - 1;
  for (let i = 0; i < parentIds.length; i += chunkSize) {
    const chunk = parentIds.slice(i, i + chunkSize);
    const sectionResult = await db.prepare(
      "SELECT id, status, data, pub_date, tcm_parent_id FROM items " +
        "WHERE " + (options.tcmKindSection ? "tcm_kind = 'section' AND " : "") +
        "tcm_parent_id IN (" + chunk.map(() => "?").join(",") + ") " +
        "AND status != ? " +
        "ORDER BY tcm_parent_id, " +
        "COALESCE(json_extract(data, '$._microfeed.receiptNo'), json_extract(data, '$._microfeed.no')), id",
    ).bind(...chunk, STATUSES.DELETED).all();
    for (const row of (Array.isArray(sectionResult.results)
      ? sectionResult.results
      : [])) {
      const parent = String(row.tcm_parent_id ?? "");
      const list = result.get(parent) ?? [];
      list.push(row);
      result.set(parent, list);
    }
  }
  return result;
}
