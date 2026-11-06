// CTWH 导入脚本共用的 SQL 生成原语：把文本里的 LF/TAB/CR 编码成哨兵，
// 生成可安全内联进迁移文件的字面量，并按单条语句字节上限分块。
// import-chapter-body.mjs 与 import-fangyao.mjs 共用，避免两处逐字重复。

export const SENTINELS = ["@@NL@@", "@@TB@@", "@@CR@@"];

/** 单引号转义 + 控制字符编码为哨兵。返回带引号的 SQL 字面量。 */
export function encodeLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value)
    .replace(/'/g, "''")
    .replace(/\n/g, "@@NL@@")
    .replace(/\t/g, "@@TB@@")
    .replace(/\r/g, "@@CR@@")}'`;
}

/** 文本列表达式：无控制字符 → 纯字面量；有 → 字面量外包三层 replace 运行时还原。 */
export function textExpr(value) {
  if (value === null || value === undefined) return "NULL";
  const s = String(value);
  if (!/[\n\t\r]/.test(s)) return encodeLiteral(s);
  return `replace(replace(replace(${encodeLiteral(s)}, ` +
    `'@@NL@@', char(10)), '@@TB@@', char(9)), '@@CR@@', char(13))`;
}

/** 按累计字节分块，保证单条 INSERT 语句 <80 KiB（80×1024 B）。 */
export function chunkByBytes(rows, toRowSql) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const row of rows) {
    const sql = toRowSql(row);
    const rowBytes = Buffer.byteLength(sql, "utf8") + 8; // ", " 与 ")" 余量
    if (current.length > 0 && bytes + rowBytes > 80 * 1024) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(sql);
    bytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
