// App 站点配置端点的读取层（工单 13，spec `.scratch/tcm-import/spec.md` §6）。
//
// 旧后端的字典/配置项按拍板适配到现有存储：
// - getAboutInfo ← 专用表 `ext_app_about_info`（name 主键 + text 列）。
//   旧后端来自 DevConfig 表；建表迁移（`migrations/0145_schema_app_about_info.sql`）
//   已用 `json_each` 把 webGlobalSettings.aboutInfo 的存量一次性搬入。
//   后台「关于页内容」管理页维护，内容逐字存取（ADR-0029 约定）。
// - 旧后端 GetProjectInfo / GetLoginInfo 已删除（App 零引用）。
// - 旧后端「列表类配置缺失返回 string.Empty」的行为保持一致（空串而非 null）

/** 旧后端 getAboutInfo 的形状：[{text, name}]；表空 → []。 */
export async function getAppAboutInfo(database: D1Database): Promise<unknown[]> {
  // 排序对齐 netcore 入库顺序（about_thks → bookname → manual → updata_log）：
  // 此前 ORDER BY name 按字母序把 thks 排到第三，与 netcore「关于」页顺序不一致。
  // 表当前 4 行（name 主键）；CASE 排序不增加 D1 读取行数（仍只读这 4 行）。
  // 新增关于行需在 CASE 里补分支；ELSE 分支之后再用 name 兜底，保证相对顺序稳定。
  // 同款排序见 src/server/app/about/config.ts 的 readAboutInfo（管理端），两处需同步改。
  const result = await database.prepare(
    "SELECT name, text FROM ext_app_about_info ORDER BY CASE name " +
      "WHEN 'about_thks' THEN 1 WHEN 'about_bookname' THEN 2 " +
      "WHEN 'about_manual' THEN 3 WHEN 'app_updata_log' THEN 4 ELSE 99 END, name",
  ).all<{name: string; text: string}>();
  return (result.results ?? []).map((row) => ({
    name: row.name,
    text: row.text,
  }));
}
