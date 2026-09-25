# 06 — 四门禁全绿与端到端手工验证

**What to build:** 整条集成链路通过项目全部质量门禁，并在真实环境确认闭环：后台用 wangEditor 编辑 → 保存 → 前台公开渲染正常；且 wang 拥有的正文重开后仍被隔离。

**Blocked by:** 04（Item 接线）、05（测试加固）

**Status:** ready-for-agent

- [ ] `./node_modules/.bin/yarn typecheck` 0 error（含 astro check + tsc --noEmit）
- [ ] `./node_modules/.bin/yarn lint` 0 问题
- [ ] `./node_modules/.bin/yarn i18n:check` 通过
- [ ] `./node_modules/.bin/yarn test` 全绿（单元 + worker 两套）
- [ ] 手工验证：切到 wangEditor 编辑正文/标题/列表，上传图片、插入视频链接
- [ ] 手工验证：保存后 `description` 为标准 HTML，刷新页面内容正确回显
- [ ] 手工验证：公开 JSON 的 `content_html` 即该 HTML，前台主题渲染正常
- [ ] 手工验证：wang 拥有的 item 重开后，模式列表仅 `[wangEditor, 源码]`，rich/markdown 不可见
- [ ] 验证完毕**停止 dev server**
- [ ] 输出精确的 `git add` 路径与提交信息，交用户手动提交（本环境 AI 不代提交）

## 备注

- 若需部署：先 `mv dist .stale-dist-<ts>` 移走残留，再 `CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy`，并回读 `.microfeed/deploy.log` 确认 `Deployed and verified`。
- 本期不含部署动作，除非用户另行要求。
