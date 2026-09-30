#!/usr/bin/env node
/**
 * 一次性验证：/admin/items/<id>/ 的「归属书本」下拉实际渲染成什么。
 *
 * 零依赖：Node 22+ 全局 WebSocket 驱动 Chrome DevTools Protocol。
 * 凭据从仓库根 .dev.vars 读取，只留在进程内，不打印、不落盘。
 *
 * 用法：node .scratch/e2e/verify-item-book.mjs [itemId] [base]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const itemId = process.argv[2] || "pyZLleBsXOb";
const base = (process.argv[3] || "http://localhost:4321").replace(/\/+$/, "");
const adminPath = "admin";
const debugPort = 9444;
const shotDir = join(process.cwd(), ".scratch", "e2e", "shots");
mkdirSync(shotDir, { recursive: true });

// 凭据来源（按顺序，全部只留在进程内，不打印、不落盘）：
//   1) 环境变量 MF_TEST_EMAIL / MF_TEST_PASSWORD
//   2) 根 .dev.vars（注意是 `KEY = value`，等号两侧带空格）
//   3) 项目技能 novel-book-ops 里记录的本地测试管理员（本地库专用账号）
function readFromDevVars() {
  try {
    const txt = readFileSync(join(process.cwd(), ".dev.vars"), "utf8");
    const get = (key) => {
      const m = txt.match(new RegExp("^\\s*" + key + "\\s*=\\s*(.*)$", "m"));
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    };
    return { email: get("MICROFEED_SETUP_ADMIN_EMAIL"), password: get("MICROFEED_SETUP_ADMIN_PASSWORD") };
  } catch { return { email: "", password: "" }; }
}
function readFromSkill() {
  try {
    const txt = readFileSync(
      join(process.cwd(), ".workbuddy", "skills", "novel-book-ops", "SKILL.md"), "utf8");
    const m = txt.match(/本地管理员：`([^`]+)`\s*\/\s*`([^`]+)`/);
    return m ? { email: m[1], password: m[2] } : { email: "", password: "" };
  } catch { return { email: "", password: "" }; }
}
const envCreds = { email: process.env.MF_TEST_EMAIL || "", password: process.env.MF_TEST_PASSWORD || "" };
const devCreds = readFromDevVars();
const skillCreds = readFromSkill();
// .dev.vars 里是别的实例的账号，与本地库对不上时会被登录拒绝 → 优先用技能里的本地测试账号。
const creds = envCreds.email
  ? envCreds
  : (devCreds.email.endsWith("@practice.local") ? skillCreds : devCreds);
const { email, password } = creds;
if (!email || !password) {
  console.error("缺少本地管理员凭据（MF_TEST_EMAIL/.dev.vars/技能记录）");
  process.exit(2);
}

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
async function waitFor(expr, { timeout = 15000, interval = 400, label = "条件" } = {}) {
  const start = Date.now();
  for (;;) {
    let v = false;
    try { v = await evalExpr(expr); } catch {}
    if (v) return true;
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${label}`);
    await sleep(interval);
  }
}
async function navigate(url) { await cdp.send("Page.navigate", { url }); await sleep(900); }
async function screenshot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const p = join(shotDir, `${name}.png`);
  writeFileSync(p, Buffer.from(data, "base64"));
  console.log(`  📸 ${p}`);
}

const CHROME = [
  "C:/Users/zhs/AppData/Local/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
if (!CHROME) { console.error("找不到 Chrome"); process.exit(2); }

const chromeProc = spawn(CHROME, [
  `--remote-debugging-port=${debugPort}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${join(shotDir, "chrome-profile")}`,
  "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--disable-dev-shm-usage",
  "--headless=new", "about:blank",
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

  console.log("[1] 登录");
  await navigate(`${base}/${adminPath}/login/`);
  await waitFor(`!!document.querySelector('#microfeed-login-account')`, { timeout: 20000, label: "登录表单" });
  const setInput = (sel, value) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  };
  await evalExpr(`(${setInput.toString()})('#microfeed-login-account', ${JSON.stringify(email)})`);
  await sleep(150);
  await evalExpr(`(${setInput.toString()})('#microfeed-login-password', ${JSON.stringify(password)})`);
  await sleep(150);
  await evalExpr(`document.querySelector('form button[type="submit"]').click()`);
  await waitFor(`location.pathname.indexOf('/login') === -1`, { timeout: 20000, label: "登录后跳转" });
  console.log("  ✓ 已登录");

  console.log(`[2] 打开 /${adminPath}/items/${itemId}/`);
  await navigate(`${base}/${adminPath}/items/${itemId}/`);
  await waitFor(`!!document.querySelector('[data-slot="admin-select-value"]')`, { timeout: 25000, label: "编辑表单渲染" });
  await sleep(1200);

  const read = await evalExpr(`(() => {
    const label = [...document.querySelectorAll('div')].find(
      (d) => d.children.length === 0 && d.textContent.trim() === '归属书本');
    const wrap = label ? label.parentElement : null;
    const value = wrap ? wrap.querySelector('[data-slot="admin-select-value"]') : null;
    const labels = [...document.querySelectorAll('div')]
      .filter((d) => d.children.length === 0 && d.textContent.trim())
      .map((d) => d.textContent.trim());
    return {
      bookLabel: value ? value.textContent.trim() : null,
      allSelectValues: [...document.querySelectorAll('[data-slot="admin-select-value"]')].map((e) => e.textContent.trim()),
      title: (document.querySelector('input[aria-label]') || {}).value || null,
      hasBookLabel: !!label,
      heading: (document.querySelector('h1,h2') || {}).textContent || null,
    };
  })()`);
  console.log("  ✓ 页面读取:", JSON.stringify(read, null, 2));
  await screenshot(`item-${itemId}`);

  console.log(read.bookLabel === "中药" ? "\nRESULT: PASS — 归属书本显示「中药」" : `\nRESULT: FAIL — 归属书本显示 ${JSON.stringify(read.bookLabel)}`);
  cdp.close();
} catch (error) {
  console.error("验证失败:", error.message);
  process.exitCode = 1;
} finally {
  try { chromeProc.kill(); } catch {}
}
