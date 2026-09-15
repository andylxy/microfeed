import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {getMediaResponse} from "@/server/media/media";
import {adminLanguageFromRequest} from "@/shared/AdminLanguage";
import {translate} from "@/shared/i18n";

export const GET: APIRoute = ({params, request}) =>
  getMediaResponse(request, env, params.key);
export const HEAD: APIRoute = ({params, request}) =>
  getMediaResponse(request, env, params.key);
export const ALL: APIRoute = ({request}) => new Response(
  translate(
    "errors.media.methodNotAllowed",
    adminLanguageFromRequest(request),
  ),
  {headers: {allow: "GET, HEAD"}, status: 405},
);
