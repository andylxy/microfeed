# 本机环境与本地资源

本册从仓库根 `AGENTS.md` 移出，规则条文与实测记录逐字保留；触发条件见 `AGENTS.md` 的读取约定。

## 本机环境注意事项

- 本沙箱 `corepack` 已损坏，所有工作区命令一律用 `./node_modules/.bin/yarn`（仓库锁定 `yarn@4.18.0` 本地 shim）；全局 Yarn 是 1.x，不要直接调用。
- 本机 `npx` 无法解析包 bin shim（报"不是内部或外部命令"）。`npx @microfeed/cli` 前缀失败时，直接用 Node 调用缓存的启动器入口（`node <npm-cache>/_npx/<hash>/node_modules/@microfeed/cli/dist/index.js manage …`）。
- 出站网络限制：`*.workers.dev` 与 `cloudflare-dns.com`（DNS-over-HTTPS）不可达；局域网 DNS 服务器有很长的负缓存（新建 DNS 记录在本地约十分钟内无法解析）。用 `curl --resolve <host>:443:<cloudflare-ip>` 验证站点；CLI 验证失败可能只是本地问题，站点在全球其他网络正常。
- 系统区域是 zh-CN，Node 的 `navigator.language` 与 `Intl.DateTimeFormat(undefined)` 会解析为中文。组件测试通过 `tests/unit/i18n-setup.ts` 固定为英文。`tests/unit/components/admin-items-list.test.ts` 有一个既有的日期断言在本机失败但在 Linux CI 通过。
- 更改 UI 文案（i18n）时，既有测试可能断言旧英文文案；运行测试并把断言更新为对应的 i18n 键调用或新的渲染文本。
- GitHub 的 git 推送（receive-pack）必须走本机出口代理：系统 IE/WinINET 代理为 `127.0.0.1:10808`（浏览器也走它）。Git for Windows 默认不读取 IE 代理；push 长时间无响应时执行 `git config --global http.proxy http://127.0.0.1:10808`（撤销：`git config --global --unset http.proxy`）。该代理由本机 VPN/代理客户端提供，客户端运行时普通 push 可直接成功，客户端未启动时间接推送会失败。

## 本地 D1 数据库文件管理

- 本地 D1 业务库**只保留一个文件**：`.microfeed/instances/<实例>/local-state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`。同目录下任何 `*.bak-*`、`*.sqlite.bak`、`*.sqlite.old` 副本都属于**过时临时文件，必须删除**；实例目录下不得出现第二个 D1 业务库文件。
- `metadata.sqlite` 及其 `-shm`/`-wal` 属于 miniflare 运行时元数据，与业务库无关，必须保留；`cache/`、`observability/`、`r2/` 下的同名文件同理。删除前先确认目标文件确实是业务库副本。
- 需要直接改库（或运行任何会写库的修复脚本）时，**先在同一目录创建临时备份**，命名 `…sqlite.bak-<YYYYMMDD-HHMMSS>`，再改数据。
- **任务成功并通过验证后，必须删除该备份**，回到"只有一个 D1 文件"的状态。需要回滚时先用备份恢复，恢复并复验通过后同样删除备份。删除备份的前置条件：① 当前库可正常读写（用户在本地用过关键页面或接口并返回预期值）；② 备份已确认不再需要。禁止在验证通过前删除，禁止把备份遗留到下一个任务。
- 本机 safe-delete 闸的行为：删除请求一旦**超过 50 个文件**就被拦下（报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 或 `SAFE_DELETE_FAIL_CLOSED`）。前置条件：`export CODEBUDDY_SAFE_DELETE_ENABLED=0`。单文件 `rm -f` 不受影响；删目录用 `CODEBUDDY_SAFE_DELETE_ENABLED=0` + `rm -rf`。
- 一次性产物同样用完即删：`.vite-old-<ts>`、`.vite-stale-<ts>`、`.vite-broken-<ts>-*`、`node_modules/.vite` 的搬移副本、`.scratch/chrome-cdp-tmp` 等，不得留在仓库里。

## Vite 依赖缓存目录（`.vite*`）管理

`node_modules/.vite` 及其变体是 vite 的**依赖预构建缓存**，可随时安全删除重建。以下目录名一律视为一次性产物，**任务结束前必须清理干净**（单个约 20–160MB，残留数个就会占用数百 MB）：`node_modules/.vite`（当前活跃缓存，dev server 运行期间**不可删**）、`node_modules/.vite-temp`（优化器临时目录，优化中断会留下垃圾）、`node_modules/.vite-old-<ts>`（手工搬移的旧缓存备份）、`node_modules/.vite-stale-<ts>`（历次故障排查留下的旧缓存）、`node_modules/.vite-broken-<ts>-*`（排障时 `mv` 出来的坏缓存）。

### ⚠️ 启动 dev server 必须设 `CODEBUDDY_SAFE_DELETE_ENABLED=0`

Vite 重新优化依赖时要删除 `node_modules/.vite/deps_temp_*`，该目录常有数百个文件，**超过 50 即触发 safe-delete 闸并抛 `[SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，直接终止优化器**，表现为 dev server 启动中断。

**正确启动方式**：

```bash
export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:$PATH"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
export CODEBUDDY_SAFE_DELETE_ENABLED=0
./node_modules/.bin/yarn manage dev --local --instance <实例>
```

### 典型故障：`deps_ssr/astro_compiler-runtime.js` 不存在

报错文案会引导你去加 `optimizeDeps.exclude`，**该配置对本故障无效**（依赖本身兼容）。先跑这个判据区分成因：

```bash
ls node_modules/.vite/deps_ssr/astro_compiler-runtime.js
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('node_modules/.vite/deps_ssr/_metadata.json','utf8')).optimized).filter(k=>/astro_compiler/.test(k)))"
```

- 文件不存在 **且** `_metadata.json` 未登记 → **优化器中途被终止**（safe-delete 闸），按下面三步恢复。
- 文件不存在但 metadata 有登记 → hash 漂移，先重启，仍不行再排查 `optimizeDeps`。

恢复三步（约 40 秒）：① 停 dev server 链——用 `Get-CimInstance Win32_Process` 按**命令行**筛出 `yarn manage dev` / `manage-cli/index.ts` / `tsx` / `astro.mjs dev` 四层进程后逐个 `Stop-Process`，**禁止按进程名一刀切**（同机可能还有别的 node 进程）；② 把所有 `node_modules/.vite*` 改名移走：`mv node_modules/.vite* node_modules/.vite-broken-<ts>-*`；③ 按上面的「正确启动方式」重启，等 `http://localhost:4321/` 回 200。重启后校验：`astro_compiler-runtime.js` 已生成、`_metadata.json` 登记数恢复到数百条、后台页面返回 200/302（未登录跳登录属正常）。确认服务稳定后再删除 `.vite-broken-*` 目录。

## 本环境的 git 提交拦截（为什么 AI 不代为提交）

本沙箱在文件系统层拦截工作区内的删除（改为移进 Windows 回收站），git 提交时对 lock 文件与 ref 目录的清理被改写成搬运，分支引用会随 `.git/refs/heads/<ns>` 一起离开仓库：commit 报成功，`git log` 却说 `does not have any commits yet`、`git status` 把整仓显示成已暂存。提交对象与 `.git/logs/HEAD`（reflog）从未受损，引用可从 reflog 一行恢复；任何碰索引的 git 命令都会产生被搬走的 `index.lock`。

⇒ 由用户在自己终端手动提交（那里没有这层拦截，一次即成）。AI 的职责是：改代码、给出精确的 `git add` 路径与提交信息，交给用户执行；验证是否运行归「门禁仅在手动触发时运行」。若确实需要 AI 代为提交，走技能 `git-safe-commit` 的流程：提交后立刻 `git rev-parse HEAD` 复核，被吃则从 reflog 重写引用（先 `mkdir -p` 父目录）。

## 本地资源清单（环境边界的展开）

### 开发环境 = 本地项目环境

一切改动、验证、度量、测试，一律在本地项目环境完成，使用的全部是本地资源：

- **本地 D1**：`.microfeed/instances/<实例>/local-state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`（注意真正的业务库是这个 `<hash>.sqlite`，同一级的 `<实例名>.db` 可能是 0 字节的遗留文件，不代表库已损坏）。读代价、索引、查询计划的结论只以本地库实测为准。
- **本地 R2 / KV / 队列 / 缓存**：本地实例的绑定，同样只在本地读写。
- **本地主题**：改 `themes/feed-zh/` 后按 `theme.md` 的流程递增版本并安装到本地 D1 的 `themes` 表，再在本地站点验证。磁盘上的主题源文件不直接参与渲染，不重新安装就看不到改动。
- **本地 dev server**：`./node_modules/.bin/yarn manage dev --local --instance <实例>`。
- **本地测试与探针**：`vitest`、`tsx` 脚本、`curl 127.0.0.1` 全部在本地执行。

### 生产环境由用户主动管理

生产环境（远程 D1、远程 R2、已部署的 Worker、远程主题）由用户自行管理：

- 不主动连接、查询、改动、部署任何生产资源。`wrangler d1 execute --remote`、`manage deploy`、`manage status`、远程主题的 install / activate / delete 等命令，只在用户明确要求时才执行。
- D1 额度与读代价的结论一律以本地实测为准，不连远程取数；需要生产数据才能回答的问题，明确说出缺什么数据、从哪里取。
- 用户要求操作生产前，先复述命令、影响范围与风险，得到确认后再执行。
- 需要用户在生产环境确认的事项（部署、迁移、主题激活、数据修正），把要执行的命令与提交信息整理好交给用户，由用户在自己终端执行。
