# 18 — 沉淀三份决策记录

**What to build:** 把这次迁移里三个"以后一定会有人再问一遍"的决定写成文档：源模型怎么映射过来的、端点契约为什么长这样、标记协议到底是什么。

**Blocked by:** 16（生产已验证，事实不再变）

**Status:** done（2026-09-28）

- [x] ADR：源模型映射 — `.scratch/tcm-import/adr-01-source-model.md`
- [x] ADR：App 端点契约 — `.scratch/tcm-import/adr-02-endpoint-contract.md`
- [x] ADR：标记协议 — `.scratch/tcm-import/adr-03-marker-protocol.md`
- [x] 三份文档与规范文档互相引用 — spec.md 末尾新增「决策记录（ADR）」索引，ADR 互引 spec § 章节

**注**：18 不依赖 16 的"全量导入"，仅依赖"生产已验证、事实不再变"——部署 + 小量数据已验证，事实锁定，故可先结。
