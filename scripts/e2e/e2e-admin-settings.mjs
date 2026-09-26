#!/usr/bin/env node
/**
 * microfeed 管理后台 — 真实浏览器 E2E（站点标题保存闭环）
 * -----------------------------------------------------------------------------
 * 零依赖：仅用 Node 22+ 自带全局 WebSocket 驱动 Chrome DevTools Protocol (CDP)。
 * 不依赖 Playwright / Puppeteer，也不需要 npm install。
 *
 * 它做的事（端到端，真实点击，非接口伪装）：
 *   1. 启动或连接一个一次性 Chrome（throwaway profile）
 *   2. 打开 /admin/login/，填入账号密码，点击「登录」
 *   3. 进入 /admin/settings/#site，读取当前站点标题
 *   4. 改成新值（默认 sentinel，也可 --new-title 指定），点「更新」
 *   5. 刷新设置页，确认新值已从服务端持久化（真正的 E2E 判据）
 *   6. 默认自动改回原值（--no-restore 可关）—— 所以对生产跑也不会留痕迹
 *
 * 用法：
 *   node e2e-admin-settings.mjs --base http://127.0.0.1:4321 \
 *       --email you@local --password 'xxxx' [--chrome "C:/path/chrome.exe"] \
 *       [--admin-path admin] [--new-title "测试标题"] [--no-restore]
 *
 *   或直接给实例名，凭据自动从 .microfeed/instances/<name>/.dev.vars 读取：
 *   node e2e-admin-settings.mjs --base http://127.0.0.1:4321 --instance practice
 *
 * 退出码：0 = 全过；2 = 有失败步骤（脚本会打印每步结论）。
 *
 * 凭证纪律（AGENTS.md「内容管理 CLI」一节）：管理员凭据允许读取、不可外泄。
 * 凭据只经命令行参数或 `--instance` 从本机实例配置读出，只留在本进程内：
 * 不写文件、不打印到对话/日志之外、不提交。本脚本不改 .dev.vars、不触碰任何仓库文件。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const get = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  if (i + 1 >= args.length || args[i + 1].startsWith("--")) return true;
  return args[i + 1];
};
const base = (get("base") || "").replace(/\/+$/, "");
const instance = get("instance") || "";
const adminPath = get("admin-path") || "admin";
const newTitle = get("new-title") || "";
const restore = !get("no-restore");
const launch = get("launch");
const chromePath = get("chrome") || "";
const debugPort = Number(get("debug-port") || 9333);
const shotDir = get("shot-dir") || join(tmpdir(), "microfeed-e2e");

// --instance <name>：从 .microfeed/instances/<name>/.dev.vars 读取 bootstrap 管理员凭据。
// 值只留在进程内，不经命令行、不打印、不落盘（AGENTS.md 凭证条款）。
function readInstanceCreds(name) {
  const p = join(process.cwd(), ".microfeed", "instances", name, ".dev.vars");
  if (!existsSync(p)) return { email: "", password: "" };
  const txt = readFileSync(p, "utf8");
  const m = (k) => (txt.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1];
  return {
    email: (m("MICROFEED_SETUP_ADMIN_EMAIL") || "").trim(),
    password: (m("MICROFEED_SETUP_ADMIN_PASSWORD") || "").trim(),
  };
}
const instCreds = instance ? readInstanceCreds(instance) : { email: "", password: "" };
const email = get("email") || instCreds.email || "";
const password = get("password") || instCreds.password || "";

if (!base) {
  console.error("✗ 缺少 --base（管理后台站点基址，如 http://127.0.0.1:4321）");
  process.exit(2);
}
if (!email || !password) {
  console.error(
    "✗ 缺少 --email / --password（或 --instance <name> 从实例 .dev.vars 读取）",
  );
  process.exit(2);
}

const LOGIN_URL = `${base}/${adminPath}/login/`;
const SETTINGS_URL = `${base}/${adminPath}/settings/`;
const SETTINGS_SITE_URL = `${SETTINGS_URL}#site`;

mkdirSync(shotDir, { recursive: true });

// 页面控制台/异常收集（模块级，供 main 与 catch 共用）
const consoleLogs = [];

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);
const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);

// 常见 Chrome 安装路径（仅用于自动探测；可用 --chrome 覆盖）
const CHROME_CANDIDATES = [
  chromePath,
  "C:/Users/zhs/AppData/Local/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return "";
}

// ---------- CDP 客户端 ----------
function connectCdp(wsUrl) {
  return new Promise((resolveC, rejectC) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const eventListeners = [];
    let opened = false;

    ws.addEventListener("open", () => {
      opened = true;
      resolveC({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, (msg) => {
              if (msg.error) rej(new Error(`${method} -> ${JSON.stringify(msg.error)}`));
              // 统一解包：返回 msg.result（方法结果），调用处直接消费其字段
              else res(msg.result);
            });
            try {
              ws.send(JSON.stringify({ id: i, method, params }));
            } catch (e) {
              rej(e);
            }
          });
        },
        on(method, cb) {
          eventListeners.push({ method, cb });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    });
    ws.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : ev.data.toString();
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else {
        for (const l of eventListeners) if (l.method === msg.method) l.cb(msg);
      }
    });
    ws.addEventListener("error", (e) => {
      if (!opened) rejectC(new Error(`WebSocket 连接失败: ${e.message || e}`));
    });
    ws.addEventListener("close", () => {
      if (!opened) rejectC(new Error("WebSocket 在打开前关闭"));
    });
  });
}

async function getDebugTarget() {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  const list = await res.json();
  // 优先挑一个 page 类型且 url 非空（非空白页）的目标
  const page = list.find(
    (t) => t.type === "page" && t.url && !t.url.startsWith("about:blank"),
  ) || list.find((t) => t.type === "page");
  if (!page) throw new Error("Chrome 未暴露任何 page target");
  return page;
}

// ---------- 页面操作封装 ----------
let cdp;

async function evalExpr(expr, { awaitPromise = true, returnByValue = true } = {}) {
  const res = await cdp.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise,
    returnByValue,
  });
  if (res.exceptionDetails) {
    throw new Error(`页面脚本异常: ${JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails)}`);
  }
  return res.result?.value;
}

async function evalFn(fn, ...fnArgs) {
  const expr = `(${fn.toString()})(${fnArgs.map((a) => JSON.stringify(a)).join(",")})`;
  return evalExpr(expr);
}

// 轮询直到表达式为真（或超时）
async function waitFor(expr, { timeout = 15000, interval = 400, label = "条件" } = {}) {
  const start = Date.now();
  for (;;) {
    let v = false;
    try { v = await evalExpr(expr); } catch {}
    if (v) return true;
    if (Date.now() - start > timeout) {
      throw new Error(`等待超时: ${label} (${expr})`);
    }
    await sleep(interval);
  }
}

async function navigate(url) {
  await cdp.send("Page.navigate", { url });
  await sleep(800); // SPA 无可靠 load 事件，短等
}

// React 受控输入：必须用原生 value setter + 派发 input 事件，否则 React 收不到
const SET_INPUT = (sel, value) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA"
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};

async function fill(sel, value, label) {
  const done = await evalFn(SET_INPUT, sel, value);
  if (!done) throw new Error(`未找到输入框: ${sel} (${label})`);
  await sleep(120); // 等 React state 落地（技能陷阱 #1：输入与点击间需间隔）
  ok(`填入 ${label}`);
}

async function click(sel, label) {
  const done = await evalFn((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);
  if (!done) throw new Error(`未找到可点击元素: ${sel} (${label})`);
  ok(`点击 ${label}`);
}

async function screenshot(name) {
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    const p = join(shotDir, `${name}.png`);
    writeFileSync(p, Buffer.from(data, "base64"));
    log(`    📸 ${p}`);
  } catch (e) {
    log(`    (截图失败: ${e.message})`);
  }
}

// ---------- 主流程 ----------
let chromeProc = null;
let steps = [];
function record(name, pass, detail = "") {
  steps.push({ name, pass, detail });
  if (pass) ok(`${name}${detail ? " — " + detail : ""}`);
  else bad(`${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  // 1) Chrome
  const shouldLaunch = launch === true || (launch !== false && chromePath);
  if (shouldLaunch) {
    const exe = findChrome();
    if (!exe) {
      console.error("✗ 找不到 Chrome，请用 --chrome 指定路径（或手动启动 Chrome 并带 --remote-debugging-port）");
      process.exit(2);
    }
    log(`▸ 启动 Chrome: ${exe}`);
    const profile = join(shotDir, "chrome-profile");
    chromeProc = spawn(exe, [
      `--remote-debugging-port=${debugPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--headless=new",
      "about:blank",
    ], { stdio: "ignore" });
    // 等调试端口起来
    const t0 = Date.now();
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        break;
      } catch {
        if (Date.now() - t0 > 15000) throw new Error("Chrome 调试端口未在 15s 内就绪");
        await sleep(300);
      }
    }
  } else {
    log(`▸ 连接已有 Chrome（调试端口 ${debugPort}）`);
    try {
      await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    } catch {
      console.error(`✗ 端口 ${debugPort} 无 Chrome 调试端点。请先启动: chrome --remote-debugging-port=${debugPort}`);
      process.exit(2);
    }
  }

  // 2) 连接 CDP + 启用域
  const target = await getDebugTarget();
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // 收集控制台/异常，便于排错
  cdp.on("Runtime.consoleAPICalled", (m) => {
    const txt = (m.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (txt) consoleLogs.push(`[console.${m.type}] ${txt}`);
  });
  cdp.on("Runtime.exceptionThrown", (m) => {
    consoleLogs.push(`[exception] ${m.exceptionDetails?.exception?.description ?? m.exceptionDetails?.text ?? ""}`);
  });

  // 3) 登录
  log("\n[1/5] 登录管理后台");
  await navigate(LOGIN_URL);
  let needLogin = true;
  try {
    await waitFor(`!!document.querySelector('#microfeed-login-account')`, { timeout: 6000, label: "登录表单" });
  } catch {
    // 可能已登录（cookie 有效）→ 直接看设置页
    try {
      await navigate(SETTINGS_SITE_URL);
      await waitFor(`!!document.querySelector('section#site input')`, { timeout: 6000, label: "设置页（已登录）" });
      needLogin = false;
      log("    已有有效会话，跳过登录");
    } catch {
      record("登录页可达", false, "既无登录表单也无有效会话");
      throw new Error("无法到达登录页或设置页");
    }
  }
  if (needLogin) {
    record("登录页可达", true);
    await fill("#microfeed-login-account", email, "账号");
    await fill("#microfeed-login-password", password, "密码");
    await click('form button[type="submit"]', "登录按钮");
    // 等登录成功并离开登录页
    try {
      await waitFor(
        `(!document.querySelector('#microfeed-login-account')) && (location.pathname.indexOf('/login') === -1)`,
        { timeout: 15000, label: "登录后跳转" },
      );
      record("登录成功并跳转", true);
    } catch {
      // 看是否有错误文案
      const err = await evalExpr(`(document.querySelector('[role="alert"]')?.textContent || '').trim()`);
      record("登录成功并跳转", false, err ? `页面错误: ${err}` : "停留在登录页");
      throw new Error("登录失败");
    }
  }

  // 4) 进入设置页，读原标题
  log("\n[2/5] 打开站点设置，读取当前标题");
  await navigate(SETTINGS_SITE_URL);
  await waitFor(`!!document.querySelector('section#site input')`, { timeout: 12000, label: "站点标题输入框" });
  record("设置页（站点分区）可达", true);
  await screenshot("01-settings-site");
  const originalTitle = (await evalExpr(`(document.querySelector('section#site input')?.value ?? '').trim()`)) || "";
  log(`    原标题: ${JSON.stringify(originalTitle)}`);
  record("读取原标题", true, originalTitle ? `"${originalTitle}"` : "（空）");

  // 5) 修改并保存
  log("\n[3/5] 修改站点标题并保存");
  const sentinel = newTitle || `${originalTitle || "站点"}-e2e-${Date.now()}`;
  await fill("section#site input", sentinel, `新标题 "${sentinel}"`);
  // 点更新按钮（section#site 内唯一 button）
  await click("section#site button", "更新按钮");
  await sleep(700); // 等 React 把按钮置为提交中(disabled)，避免误判“已恢复”
  // 等保存完成：changedSections 清空 → 按钮文案回到“更新”/不再为提交中
  try {
    await waitFor(
      `(() => { const b = document.querySelector('section#site button'); return b && !b.disabled; })()`,
      { timeout: 15000, label: "保存完成（按钮恢复可点）" },
    );
    record("点击更新并等待完成", true);
  } catch {
    record("点击更新并等待完成", false, "按钮未在 15s 内恢复（可能保存失败）");
    await screenshot("02-save-stuck");
    throw new Error("保存似乎失败");
  }

  // 6) 刷新验证持久化（真正的 E2E 判据：服务端真的存了）
  log("\n[4/5] 刷新设置页，确认新值已从服务端持久化");
  await navigate(SETTINGS_SITE_URL);
  await waitFor(`!!document.querySelector('section#site input')`, { timeout: 12000, label: "刷新后站点标题输入框" });
  const afterSave = (await evalExpr(`(document.querySelector('section#site input')?.value ?? '').trim()`)) || "";
  const persisted = afterSave === sentinel;
  record("刷新后服务端持久化", persisted, `读到 "${afterSave}"`);
  if (!persisted) {
    await screenshot("03-persist-fail");
  }

  // 7) 还原（默认开）
  if (restore && originalTitle !== sentinel) {
    log("\n[5/5] 还原为原标题（不留痕迹）");
    await fill("section#site input", originalTitle, `还原为 "${originalTitle}"`);
    await click("section#site button", "更新按钮（还原）");
    await sleep(700); // 同上：等提交中态渲染
    try {
      await waitFor(
        `(() => { const b = document.querySelector('section#site button'); return b && !b.disabled; })()`,
        { timeout: 15000, label: "还原保存完成" },
      );
      await navigate(SETTINGS_SITE_URL);
      await waitFor(`!!document.querySelector('section#site input')`, { timeout: 12000 });
      const restored = (await evalExpr(`(document.querySelector('section#site input')?.value ?? '').trim()`)) || "";
      record("还原成功", restored === originalTitle, `读到 "${restored}"`);
    } catch {
      record("还原成功", false, "还原保存未完成（请手动检查设置页）");
    }
  } else if (restore) {
    log("\n[5/5] 原标题即 sentinel，无需还原");
    record("还原（无需）", true);
  } else {
    log("\n[5/5] 跳过还原（--no-restore）");
    record("还原（跳过）", true, "新值保留在服务端");
  }

  // 收尾
  await screenshot("04-final");
  if (consoleLogs.length) {
    log("\n  页面控制台/异常（供排错）:");
    for (const l of consoleLogs.slice(0, 20)) log(`    · ${l}`);
  }
}

main()
  .then(() => {
    log("\n──────── 结论 ────────");
    const allPass = steps.every((s) => s.pass);
    for (const s of steps) log(`  ${s.pass ? "✓" : "✗"} ${s.name}${s.detail ? " — " + s.detail : ""}`);
    log(allPass ? "\n✅ 真实浏览器 E2E 全部通过" : "\n❌ 存在失败步骤");
    if (cdp) cdp.close();
    if (chromeProc) try { chromeProc.kill("SIGKILL"); } catch {}
    process.exit(allPass ? 0 : 2);
  })
  .catch((e) => {
    log("\n──────── 结论 ────────");
    log(`❌ 流程中断: ${e.message}`);
    for (const s of steps) log(`  ${s.pass ? "✓" : "✗"} ${s.name}${s.detail ? " — " + s.detail : ""}`);
    if (consoleLogs.length) {
      log("  页面控制台/异常（供排错）:");
      for (const l of consoleLogs.slice(0, 20)) log(`    · ${l}`);
    }
    if (cdp) cdp.close();
    if (chromeProc) try { chromeProc.kill("SIGKILL"); } catch {}
    process.exit(2);
  });
