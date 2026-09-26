# 真实浏览器 E2E 运行手册：管理后台站点标题保存闭环

> 配套脚本：`scripts/e2e/e2e-admin-settings.mjs`（零依赖，Node 22+ 自带 `WebSocket` 直接驱动 Chrome CDP，无需 Playwright / npm install）
>
> 为什么会需要它：在本项目的 CI/沙箱里，`manage dev` 在 Vite 依赖重优化这一步会**可复现卡死**（无浏览器驱动、无代理都试过），真实浏览器 E2E 无法在沙箱内闭环。因此把这套 E2E 做成一份**你在本机终端一键可跑**的脚本，绕过沙箱限制。

---

## 它验证什么

真实浏览器里完整走一遍「登录 → 改站点标题 → 保存 → 刷新 → 确认服务端已持久化 → 还原」，覆盖的是**真实点击与渲染**，不是接口伪装：

| 步骤 | 动作 | 判据 |
|---|---|---|
| 1 | 登录 `/admin/login/`（填账号密码、点登录） | 离开登录页、进入后台 |
| 2 | 打开 `/admin/settings/#site`，读当前标题 | 输入框存在、读到值 |
| 3 | 改成新值、点「更新」 | 按钮恢复可点（提交完成） |
| 4 | **刷新**设置页再读 | 新值仍在 = 服务端真的存了（真正的 E2E 判据） |
| 5 | 默认自动改回原标题 | 对生产跑也**不留痕迹** |

默认行为会**自动还原**原标题（`--no-restore` 可关），所以即使直接对生产站点跑，也不会改坏你的站点标题。

---

## 前置条件

- **Node ≥ 22**（`node -v` 确认；全局 `WebSocket` 是 22 才有的）。
- **Chrome / Chromium** 已安装（脚本会自动探测常见路径；否则用 `--chrome "绝对路径"` 指定）。
- 一个**可用的管理后台账号** + 密码。
- 一个**正在运行**的 microfeed 管理后台（dev 实例或生产均可）。

---

## 用法 A：对本地 dev 实例跑（推荐先在这里验证）

### 1) 起 dev server（在你的本机终端，不受沙箱限制）

```bash
cd /path/to/microfeed
yarn manage dev --instance practice --disable-webhooks
```

记下它打印的端口（默认约 `http://127.0.0.1:4321`；若被占用会自动 +1，看 `➜ Local:` 那行）。

### 2) 准备一个 bootstrap 管理员（仅首次，用完即删）

`practice` 实例的数据库是本地空的，需要先在 `.dev.vars` 里临时写 bootstrap 凭据，`manage dev` 启动时会建好管理员，之后即可删掉。**绝不要提交、绝不要打印到日志之外**：

```bash
# 生成一次性口令（例如 18 位，含大小写+数字），写入 .dev.vars
printf 'MICROFEED_SETUP_ADMIN_EMAIL=admin@practice.local\nMICROFEED_SETUP_ADMIN_PASSWORD=把这里换成你的强口令\nMICROFEED_SETUP_ADMIN_PASSWORD_CONFIRMATION=把这里换成你的强口令\n' >> .dev.vars
```

然后**重启** dev server 让它读到新变量建管理员。验证登录成功后，立刻从 `.dev.vars` 删掉这三行 `MICROFEED_SETUP_*`（`.dev.vars` 已被 gitignore，不会进仓库；但仍要避免明文凭据长期留存磁盘）。

> 如果你已有 practice 实例的管理员账号，跳过这步，直接用现账号。

### 3) 跑脚本

```bash
node scripts/e2e/e2e-admin-settings.mjs \
  --base http://127.0.0.1:4321 \
  --instance practice
```

> `--instance practice` 会自动从 `.microfeed/instances/practice/.dev.vars` 读取
> bootstrap 管理员凭据（`MICROFEED_SETUP_ADMIN_EMAIL/PASSWORD`），无需手动传账号密码，
> 凭据只留在进程内、不出现在命令行。若不用 `--instance`，也可显式传：
>
> ```bash
> node scripts/e2e/e2e-admin-settings.mjs \
>   --base http://127.0.0.1:4321 \
>   --email admin@practice.local \
>   --password '你的口令'
> ```

可选参数：

| 参数 | 说明 | 默认 |
|---|---|---|
| `--base` | 管理后台基址（**必填**） | — |
| `--email` / `--password` | 登录凭据（与 `--instance` 二选一） | — |
| `--instance` | 实例名：自动从 `.microfeed/instances/<name>/.dev.vars` 读 bootstrap 管理员凭据 | — |
| `--admin-path` | 管理路径段 | `admin` |
| `--new-title` | 指定要设的测试标题（否则用 sentinel `原标题-e2e-时间戳`） | 自动 |
| `--no-restore` | 不还原原标题（新值保留在服务端） | 默认会还原 |
| `--chrome` | Chrome 可执行文件绝对路径 | 自动探测 |
| `--debug-port` | Chrome 调试端口 | `9333` |
| `--shot-dir` | 截图与临时 profile 目录 | 系统 temp 下 `microfeed-e2e/` |

脚本会**自己启动一个一次性 Chrome**（throwaway profile，结束即杀），并输出每一步 ✓/✗ 与截图路径。

---

## 用法 B：直接对生产站点跑（安全，因为默认还原）

```bash
node scripts/e2e/e2e-admin-settings.mjs \
  --base https://feed.881019.xyz \
  --email 你的真实管理员邮箱 \
  --password '你的密码'
```

脚本会：改成 sentinel → 保存 → 刷新确认持久化 → **改回原标题** → 刷新确认还原。生产站点标题最终不变。

> 想故意留一个新标题做验证？加 `--new-title "我要的标题" --no-restore`。

---

## 退出码

- `0`：全部步骤通过
- `2`：有失败步骤（脚本会逐条打印结论 + 页面控制台/异常，便于排错）

---

## 排错

- **「找不到 Chrome」**：用 `--chrome "C:/.../chrome.exe"` 显式指定。
- **「端口 9333 无调试端点」**：说明脚本没拉起 Chrome（被杀软拦截？）。换一个端口：`--debug-port 9444`；或自己先手动启动 Chrome：
  ```bash
  chrome --remote-debugging-port=9333 --user-data-dir=%TEMP%/mf-chrome
  ```
  然后脚本会自动复用（不带 `--launch` 时默认连已有端口）。
- **登录失败（页面错误: …）**：看打印的 `[role="alert"]` 文案——通常是账号/密码错，或 bootstrap 管理员没建好。
- **保存后没持久化**：多半是保存接口报错，看脚本结尾的 `[exception]` / `[console.error]` 输出。
- **卡在「登录后跳转」**：确认 `--admin-path` 与你的实例一致（默认 `admin`；自定义过管理路径要改）。

---

## 清理

脚本结束时**自动**杀掉它启动的一次性 Chrome 与临时 profile。如果你手动起过 Chrome 调试端口，记得自己关掉。`.dev.vars` 里的 `MICROFEED_SETUP_*` 临时凭据用完即删（见用法 A.2）。
