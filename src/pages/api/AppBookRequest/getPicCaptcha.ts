import type {APIRoute} from "astro";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {emptyPicCaptcha} from "@/server/tcm/config";

// 本项目无图形验证码能力；返回旧后端 PicVierificationCode 的空形状，
// App 侧 IsCode=false 即不强制验证码，登录链路不阻塞。
export const GET: APIRoute = async () => jsonResponse(appEnvelope(emptyPicCaptcha()));
