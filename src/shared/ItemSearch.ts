// 后台列表搜索的入口定义在 `src/server/admin/item-search.ts`（items 直查）；
// 本文件只留它与 Worker 共用的一部分：查询词解析、状态名与正文 revision 常量。
export const ITEM_CONTENT_TEXT_REVISION = 1;

export const ITEM_SEARCH_STATUSES = [
  "published",
  "unlisted",
  "unpublished",
] as const;
export type ItemSearchStatus = typeof ITEM_SEARCH_STATUSES[number];

export interface ItemSearchClause {
  /** 该词来自引号包裹的短语。引号只影响切词（短语不被空格劈开），
   *  匹配时与普通词同为子串。 */
  phrase: boolean;
  text: string;
}

export function parseItemSearchQuery(input: string): ItemSearchClause[] {
  const clauses: ItemSearchClause[] = [];
  let buffer = "";
  let quote: "'" | '"' | null = null;
  let quoted = false;
  let escaped = false;

  const push = () => {
    const text = buffer.trim();
    if (text) {
      clauses.push({phrase: quoted, text});
    }
    buffer = "";
    quoted = false;
  };

  for (const character of input) {
    if (escaped) {
      buffer += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
        push();
      } else {
        buffer += character;
      }
      continue;
    }
    if ((character === '"' || character === "'") && buffer.length === 0) {
      quote = character;
      quoted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    buffer += character;
  }
  if (escaped) buffer += "\\";
  push();
  return clauses;
}
