#!/usr/bin/env node
/**
 * 书页渲染验证：截图 + 读取目录条目（公开页，无需登录）。
 * 零依赖：Node 22+ 全局 WebSocket 驱动 Chrome DevTools Protocol。
 *
 * 用法：node .scratch/e2e/shot-book-page.mjs <bookId> [base]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const bookId = process.argv[2] || "4KbG9bDqdz3";
const base = (process.argv[3] || "http://localhost:4321").replace(/\/+$/, "");
const debugPort = 9455;
const shotDir = join(process.cwd(), ".scratch", "e2e", "shots");
mkdirSync(shotDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectCdp(wsUrl) {
  return new Promise((resolveC, rejectC) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      resolveC({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, (msg) => (msg.error ? rej(new Error(`${method} -> ${JSON.stringify(msg.error)}`)) : res(msg.result)));
            ws.send(JSON.stringify({ id: i, method, params }));
          });
        },
        close() { try { ws.close(); } catch {} },
      });
    });
    ws.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : ev.data.toString();
      let msg; try { msg = JSON.parse(text); } catch { return; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    ws.addEventListener("error", (e) => { if (!opened) rejectC(new Error(String(e.message || e))); });
  });
}

let cdp;
async function evalExpr(expr) {
  const res = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(`页面脚本异常: ${JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails)}`);
  return res.result?.value;
}
async function waitFor(expr, { timeout = 20000, interval = 400, label = "条件" } = {}) {
  const start = Date.now();
  for (;;) {
    let v = false;
    try { v = await evalExpr(expr); } catch {}
    if (v) return true;
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${label}`);
    await sleep(interval);
  }
}

const CHROME = [
  "C:/Users/zhs/AppData/Local/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
if (!CHROME) { console.error("找不到 Chrome"); process.exit(2); }

const chromeProc = spawn(CHROME, [
  `--remote-debugging-port=${debugPort}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${join(shotDir, "chrome-profile-book")}`,
  "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--disable-dev-shm-usage",
  "--headless=new", "--window-size=1280,1400",
  "about:blank",
], { stdio: "ignore" });

try {
  const t0 = Date.now();
  for (;;) {
    try { await fetch(`http://127.0.0.1:${debugPort}/json/version`); break; }
    catch { if (Date.now() - t0 > 15000) throw new Error("Chrome 调试端口未就绪"); await sleep(300); }
  }
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url && !t.url.startsWith("about:blank")) || list.find((t) => t.type === "page");
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const url = `${base}/book/${bookId}/`;
  console.log(`导航 ${url}`);
  await cdp.send("Page.navigate", { url });
  await waitFor(`document.querySelectorAll('.mf-toc-item').length > 0`, { label: "目录渲染" });
  await sleep(1500); // 等主题 JS 完成卷分组

  const read = await evalExpr(`(() => {
    const items = [...document.querySelectorAll('.mf-toc-item')];
    const vols = [...document.querySelectorAll('[data-mf-volume]')].map((e) => e.getAttribute('data-mf-volume'));
    const headings = [...document.querySelectorAll('.mf-detail-volume-title, .mf-toc-volume-heading')]
      .map((e) => e.textContent.trim()).filter(Boolean);
    return {
      title: (document.querySelector('.mf-detail-title') || {}).textContent?.trim() || null,
      catalogHeading: (document.querySelector('#mf-detail-catalog h2') || {}).textContent?.trim() || null,
      itemCount: items.length,
      firstItems: items.slice(0, 6).map((e) => e.textContent.trim()),
      lastItems: items.slice(-2).map((e) => e.textContent.trim()),
      distinctVolumes: [...new Set(vols)].slice(0, 5),
      volumeHeadings: headings.slice(0, 5),
      otherBookNames: ['星河剑歌','边陲小城','断剑之秘'].filter((k) => document.body.innerText.includes(k)),
    };
  })()`);
  console.log(JSON.stringify(read, null, 2));

  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const p = join(shotDir, `book-${bookId}.png`);
  writeFileSync(p, Buffer.from(data, "base64"));
  console.log(`📸 ${p}`);
  cdp.close();
} catch (error) {
  console.error("验证失败:", error.message);
  process.exitCode = 1;
} finally {
  try { chromeProc.kill(); } catch {}
}
