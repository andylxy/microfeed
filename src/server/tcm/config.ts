// App 站点配置端点的读取层（工单 13，spec `.scratch/tcm-import/spec.md` §6）。
//
// 旧后端这三项来自 Sys_Dictionary / DevConfig 表；本项目没有对应结构，
// 按拍板适配到现有存储（不新建复杂结构）：
// - systemName / systemLogo / systemDescription ← 主频道（channels.is_primary=1）的
//   title / image / description
// - getAboutInfo ← settings 表 webGlobalSettings JSON 的可选 `aboutInfo` 数组
//   （[{text, name}]，后台改 JSON 即生效）；缺失 → []
// - 旧后端「列表类配置缺失返回 string.Empty」的行为保持一致（空串而非 null）

import {SETTINGS_CATEGORIES} from "@/shared/Constants";

interface ChannelData {
  title?: unknown;
  description?: unknown;
  image?: unknown;
}

async function primaryChannelData(
  database: D1Database,
): Promise<ChannelData | null> {
  const row = await database.prepare(
    "SELECT data FROM channels WHERE is_primary = 1 LIMIT 1",
  ).first<{data: string}>();
  if (!row) return null;
  try {
    return JSON.parse(String(row.data ?? "{}")) as ChannelData;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 旧后端 GetProjectInfo 的形状；列表类配置缺失返回空串。 */
export async function getAppProjectInfo(database: D1Database): Promise<unknown> {
  const channel = await primaryChannelData(database);
  return {
    sysDefaultLinksIcon: "",
    systemDescription: text(channel?.description),
    systemWorkbenchData: "",
    systemName: text(channel?.title),
    systemVersion: "",
    systemLogo: text(channel?.image),
  };
}

/** 旧后端 GetLoginInfo 的形状；无图形验证码能力 ⇒ vierificationCode 恒为 "false"。 */
export async function getAppLoginInfo(database: D1Database): Promise<unknown> {
  const channel = await primaryChannelData(database);
  return {
    loginAccountLinks: "",
    loginAccountList: "",
    loginFooter: "",
    vierificationCode: "false",
    systemName: text(channel?.title),
    systemVersion: "",
  };
}

/** 旧后端 getAboutInfo 的形状：[{text, name}]；缺失/配置为空 → []。 */
export async function getAppAboutInfo(database: D1Database): Promise<unknown[]> {
  const row = await database.prepare(
    "SELECT data FROM settings WHERE category = ? LIMIT 1",
  ).bind(SETTINGS_CATEGORIES.WEB_GLOBAL_SETTINGS).first<{data: string}>();
  if (!row) return [];
  try {
    const parsed = JSON.parse(String(row.data ?? "{}")) as {aboutInfo?: unknown};
    return Array.isArray(parsed.aboutInfo) ? parsed.aboutInfo : [];
  } catch {
    return [];
  }
}

/** 旧后端 getPicCaptcha 的形状（PicVierificationCode）；本项目无验证码能力。 */
export function emptyPicCaptcha(): {
  ValidCodeBase64: string;
  ValidCodeReqNo: string;
  IsCode: boolean;
} {
  return {ValidCodeBase64: "", ValidCodeReqNo: "", IsCode: false};
}
