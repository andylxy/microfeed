// App 端图形验证码（账号密码登录，策略 A：每次登录都要）。
//
// 设计要点（用户拍板 2026-10-25）：
// - **无状态**：不落 D1、不用 KV。`reqNo` 里只放「过期时刻 + HMAC 签名」，
//   码本身从不写进 reqNo（攻击者没有密钥无法反推，也无法离线爆破答案）。
//   好处：GET 与 POST 可能落在不同 isolate / 不同数据中心也不怕；零 D1 开销。
// - **代价**：TTL（2 分钟）内同一张码可被重复使用。因 `login` 已有
//   5 次/分/IP 的 429 限流（ADR-0011），实际风险可接受。
// - **零第三方依赖**：PNG 用原生 `CompressionStream("deflate")` 压缩 + 手写
//   PNG chunk；HMAC 用 `crypto.subtle`。Workers 与 Node 22 都能跑。
//
// 与 App `VierCode.Bean` 的契约（App 必须用 @SerializedName 映射大驼峰）：
//   { ValidCodeBase64: <纯 PNG 的 base64，无 data URI 前缀>,
//     ValidCodeReqNo:  "<expAt>.<base64url(HMAC-SHA256(code.expAt))>",
//     IsCode: true }
// 登录时 App 回传 `verificationCode` + `uUID`(=reqNo)；服务端重算 HMAC 比对。

const TTL_MS = 2 * 60 * 1000;
const CODE_LEN = 4;

const CANVAS_W = 132;
const CANVAS_H = 44;
const SCALE = 4; // 每个点阵像素放大倍数
const GLYPH_W = 5 * SCALE; // 20
const GLYPH_H = 7 * SCALE; // 28
const CHAR_GAP = 8;

// 5x7 点阵字体（仅数字，7 行 × 5 列，'1' 为亮）。
// 数字-only：字体表小、字形不易写错；配合噪声 + 2 分钟 TTL + IP 限流已足够挡脚本。
// 若日后要扩到字母，只需往这里加 5x7 字形并把 randomCode 的字符集换掉。
const FONT_5X7: Record<string, readonly string[]> = {
  "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

const BG: readonly number[] = [245, 244, 240]; // 暖白 #F5F4F0
const TEXT_COLORS: readonly (readonly number[])[] = [
  [44, 44, 42],
  [26, 58, 95],
  [110, 50, 40],
  [60, 40, 20],
];
const DOT_LIGHT: readonly number[] = [180, 180, 175];
const DOT_DARK: readonly number[] = [120, 120, 115];
const LINE_COLOR: readonly number[] = [150, 150, 145];

function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += String(randomInt(10));
  return out;
}

function drawLine(
  set: (x: number, y: number, rgb: readonly number[]) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: readonly number[],
): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    set(x, y, rgb);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/** 把码画进 RGB 像素缓冲（3 字节/像素，无 alpha）。 */
function renderPixels(code: string): Uint8Array {
  const px = new Uint8Array(CANVAS_W * CANVAS_H * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = BG[0]!;
    px[i + 1] = BG[1]!;
    px[i + 2] = BG[2]!;
  }
  const set = (x: number, y: number, rgb: readonly number[]): void => {
    if (x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H) return;
    const o = (y * CANVAS_W + x) * 3;
    px[o] = rgb[0]!;
    px[o + 1] = rgb[1]!;
    px[o + 2] = rgb[2]!;
  };

  const totalW = CODE_LEN * GLYPH_W + (CODE_LEN - 1) * CHAR_GAP;
  const startX = Math.floor((CANVAS_W - totalW) / 2);
  const baseY = Math.floor((CANVAS_H - GLYPH_H) / 2);

  for (let i = 0; i < code.length; i++) {
    const rows = FONT_5X7[code[i]!] ?? FONT_5X7["0"]!;
    const gx = startX + i * (GLYPH_W + CHAR_GAP) + (randomInt(5) - 2);
    const gy = baseY + (randomInt(5) - 2);
    const color = TEXT_COLORS[randomInt(TEXT_COLORS.length)]!;
    for (let r = 0; r < 7; r++) {
      const row = rows[r]!;
      for (let c = 0; c < 5; c++) {
        if (row[c] !== "1") continue;
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            set(gx + c * SCALE + sx, gy + r * SCALE + sy, color);
          }
        }
      }
    }
  }

  // 噪点
  for (let n = 0; n < 70; n++) {
    set(randomInt(CANVAS_W), randomInt(CANVAS_H), randomInt(2) === 0 ? DOT_LIGHT : DOT_DARK);
  }
  // 干扰线
  for (let n = 0; n < 2; n++) {
    drawLine(
      set,
      randomInt(CANVAS_W),
      randomInt(CANVAS_H),
      randomInt(CANVAS_W),
      randomInt(CANVAS_H),
      LINE_COLOR,
    );
  }
  return px;
}

// —— PNG 编码（8-bit RGB，color type 2，无 alpha） ——

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  writeU32(out, 8 + data.length, crc32(crcInput));
  return out;
}

type DeflateStream = {readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>};
type DeflateCtor = new (format: "deflate" | "gzip" | "deflate-raw") => DeflateStream;

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const ctor = (globalThis as unknown as {CompressionStream: DeflateCtor}).CompressionStream;
  // CompressionStream("deflate") 产出的就是 zlib(RFC1950) 流，正是 PNG IDAT 需要的。
  const stream = new ctor("deflate");
  const writer = stream.writable.getWriter();
  void writer.write(data);
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

async function encodePng(px: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    raw.set(px.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  const idat = await zlibDeflate(raw);

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = signature.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(signature, offset);
  offset += signature.length;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// —— base64 ——

const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet.charAt((n >> 18) & 63) + alphabet.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? alphabet.charAt((n >> 6) & 63) : pad ? "=" : "";
    out += i + 2 < bytes.length ? alphabet.charAt(n & 63) : pad ? "=" : "";
  }
  return out;
}

// —— HMAC-SHA256 无状态签名 ——

function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {name: "HMAC", hash: "SHA-256"},
    false,
    ["sign"],
  );
}

async function signCode(secret: string, code: string, expAt: number): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(`${code}.${expAt}`),
  );
  return encodeBase64(new Uint8Array(signature), B64_URL, false);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 生成一张验证码：返回码（仅调试用，勿下发）、签名 reqNo、PNG 的纯 base64。 */
export async function generateCaptcha(
  secret: string,
): Promise<{code: string; reqNo: string; pngBase64: string}> {
  if (!secret) throw new Error("captcha: missing signing secret");
  const code = randomCode();
  const expAt = Date.now() + TTL_MS;
  const reqNo = `${expAt}.${await signCode(secret, code, expAt)}`;
  const png = await encodePng(renderPixels(code), CANVAS_W, CANVAS_H);
  return {code, reqNo, pngBase64: encodeBase64(png, B64_STD, true)};
}

/** 校验用户提交的码与 reqNo 是否匹配且未过期（无状态，不读库）。 */
export async function verifyCaptcha(
  secret: string,
  submittedCode: string,
  reqNo: string,
): Promise<boolean> {
  if (!secret || !submittedCode || !reqNo) return false;
  const dot = reqNo.indexOf(".");
  if (dot <= 0) return false;
  const expAtRaw = reqNo.slice(0, dot);
  const signature = reqNo.slice(dot + 1);
  const expAt = Number(expAtRaw);
  if (!Number.isInteger(expAt) || Date.now() > expAt) return false;
  const expected = await signCode(secret, submittedCode.trim(), expAt);
  return timingSafeEqual(signature, expected);
}
