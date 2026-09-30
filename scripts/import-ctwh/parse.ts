/**
 * MySQL dump parser for the ctwh import (spec `.scratch/tcm-import/spec.md` §8).
 *
 * The dump format is one `INSERT INTO `Table` (`c1`, ...) VALUES (...);` per
 * physical line (verified: BookBody.sql has 8066 lines for 8066 rows), but the
 * parser does not rely on that — it accumulates characters until the VALUES
 * tuple closes, so an embedded newline cannot corrupt a row.
 *
 * MySQL string escapes are decoded here (`\r\n` → real newlines, `\'`, `\\`,
 * …). Unknown escapes decode to the escaped character itself, matching
 * MySQL's behaviour; `\%` / `\_` keep their backslash (LIKE-pattern escapes).
 * `''` quote doubling inside a literal is normalised before decoding.
 */

export interface DumpRow {
  table: string;
  columns: string[];
  /** Decoded values: string for text, number for bare numeric literals, null for NULL. */
  values: Array<string | number | null>;
  /** 1-based source line where the statement started (for error messages). */
  line: number;
}

const INSERT_HEAD = /^INSERT INTO `([^`]+)` \(([^)]*)\) VALUES \(/;

type Value = string | number | null;

/** Decode one MySQL string body (between the quotes, escapes still raw). */
export function mysqlUnescape(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[i + 1];
    i += 1;
    if (next === undefined) {
      out += "\\";
      break;
    }
    switch (next) {
      case "0": out += "\0"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "Z": out += "\x1a"; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "%":
      case "_": out += `\\${next}`; break;
      default: out += next; break;
    }
  }
  return out;
}

function looksNumeric(literal: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(literal);
}

/** Parse one `INSERT ... VALUES (...);` statement body into a row. */
function parseStatement(
  table: string,
  columns: string[],
  body: string,
  line: number,
): DumpRow {
  const values: Value[] = [];
  let i = 0;
  let inString = false;
  let token = "";
  let sawToken = false;
  let wasQuoted = false;
  const push = () => {
    if (!sawToken) {
      values.push(null);
    } else if (wasQuoted) {
      values.push(token);
    } else {
      values.push(looksNumeric(token) ? Number(token) : token);
    }
    token = "";
    sawToken = false;
    wasQuoted = false;
  };
  while (i < body.length) {
    const char = body[i];
    if (inString) {
      if (char === "\\") {
        // Keep the escape pair raw; mysqlUnescape decodes it later.
        token += char + (body[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (char === "'") {
        if (body[i + 1] === "'") {
          token += "''";
          i += 2;
          continue;
        }
        inString = false;
        token = mysqlUnescape(token.replace(/''/g, "\\'"));
        i += 1;
        continue;
      }
      token += char;
      i += 1;
      continue;
    }
    if (char === "'") {
      inString = true;
      sawToken = true;
      wasQuoted = true;
      token = "";
      i += 1;
      continue;
    }
    if (char === ",") {
      push();
      i += 1;
      continue;
    }
    if (char === ")") {
      push();
      i += 1;
      return {table, columns, values, line};
    }
    if (body.startsWith("NULL", i)) {
      // push() at the next delimiter emits null (sawToken stays false).
      i += 4;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      i += 1;
      continue;
    }
    sawToken = true;
    token += char;
    i += 1;
  }
  // A tuple that runs to EOF without closing — keep what we have so a
  // truncated tail surfaces in the counts check rather than vanishing.
  push();
  return {table, columns, values, line};
}

/** Iterate every INSERT row in a dump file's text. */
export function* iterInsertRows(text: string): Generator<DumpRow> {
  const lines = text.split("\n");
  let lineNumber = 0;
  for (const rawLine of lines) {
    lineNumber += 1;
    if (!rawLine.startsWith("INSERT INTO ")) continue;
    const head = INSERT_HEAD.exec(rawLine);
    if (!head) {
      throw new Error(`ctwh dump line ${lineNumber}: unrecognised INSERT head`);
    }
    const table = head[1] ?? "";
    const columns = (head[2] ?? "")
      .split(",")
      .map((c) => c.trim().replace(/^`|`$/g, ""));
    const tail = rawLine.slice(head[0].length).replace(/;\s*$/, "");
    const row = parseStatement(table, columns, tail, lineNumber);
    if (row.values.length !== columns.length) {
      throw new Error(
        `ctwh dump ${table} line ${lineNumber}: ${row.values.length} values ` +
        `for ${columns.length} columns`,
      );
    }
    yield row;
  }
}

/** Column accessor: name → decoded value. */
export function rowValue(row: DumpRow, column: string): string | number | null {
  const index = row.columns.indexOf(column);
  if (index === -1) return null;
  return row.values[index] ?? null;
}

export function rowText(row: DumpRow, column: string): string {
  const value = rowValue(row, column);
  return typeof value === "string" ? value : "";
}
