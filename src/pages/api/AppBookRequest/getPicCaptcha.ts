import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {generateCaptcha} from "@/server/tcm/captcha";
import {appEnvelope} from "@/server/tcm/envelope";

// 图形验证码（账号密码登录，策略 A：每次登录都要）。
// 无状态：reqNo 里是 HMAC 签名，不落库、不读 D1；TTL 2 分钟，重放窗口由
// login 的 5 次/分/IP 限流（ADR-0011）兜底。
//
// 返回旧后端 PicVierificationCode 形状；App 侧 IsCode=true 即显示验证码行。
// ValidCodeBase64 必须是**纯 PNG base64**（无 `data:image/...;base64,` 前缀），
// 否则 App 的 Base64ConverBitmapHelper 会直接返回 null、验证码图不显示。
export const GET: APIRoute = async () => {
  // 本地联调旁路：`MAIL_DEV_ECHO=1` 时固定验证码为 "1234"，使 adb 联调阶段
  // 无需识别图片即可通过校验（生产未设该变量，走真实随机码）。
  const devCode = env.MAIL_DEV_ECHO === "1" ? "1234" : undefined;
  const {reqNo, pngBase64} = await generateCaptcha(env.BETTER_AUTH_SECRET, devCode);
  return jsonResponse(
    appEnvelope({
      ValidCodeBase64: pngBase64,
      ValidCodeReqNo: reqNo,
      IsCode: true,
    }),
  );
};
