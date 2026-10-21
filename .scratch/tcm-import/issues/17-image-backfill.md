# 17 — 封面与配图回填

**What to build:** 拿到源图后，把 13 本书的封面与名词配图传进项目媒体库并写回，让书页与名词页不再缺图。

导入阶段一律置空，但**原始路径必须留下来**（存在口袋字段里），否则这一单无从下手。

**Blocked by:** 16（生产数据已就位）

**Status:** deferred — 2026-09-28 处置：源图目录至今未提供，按本票 checklist「拿不到则保持置空，不阻塞其他工单」执行。所有封面/配图字段在导入阶段一律置空，原始路径保留在 `_microfeed.sourceImagePath` 口袋里（见 import 脚本 `case`/`bieMing` 等口袋），待拿到源图后可单独回填，不阻塞 16/18。

- [x] 前提：拿到源图目录；拿不到则保持置空，不阻塞其他工单 — **当前：未拿到，已置空，不阻塞**
- [ ] 用项目媒体上传能力传图，取回永久地址
- [ ] 写回书封面与名词配图字段
- [ ] 缺图时页面优雅降级，不裂图、不报错
- [ ] 抽查 3 张确认图能正常显示

## 2026-10-21 代码级核对（结论：deferred 正确，回填实现不存在）

- 现有代码只做两件事：导入期把源图路径写进口袋（`scripts/import-ctwh/build.ts:567/1135` 的 `sourceImagePath: rowText(row, "ImageUrl")`），读取时原样下发（`src/server/tcm/reads.ts:352` 的 `imageUrl: textOrNull(pocket.sourceImagePath)`；`:796-806` 名词的 `imageUrl` 同样取自口袋）。
- **没有**「上传图片到项目媒体库 → 写回封面 / 配图字段」的脚本或代码：`scripts/` 下无回填工具；`ctwh-books/*/out/tcm-channels.sql` 里 `sourceImagePath` 全是空串（源数据的 ImageUrl 列为空）。
- 媒体上传能力本身存在（`packages/cli/src/media.ts`、`tests/worker/media.test.ts`），但那是通用能力，不等于本票的回填链路。
- 因此本票不是「记录没更新」，而是**真的没做**：等源图目录，等实现（上传 → 写回 → 优雅降级 → 抽查）。
