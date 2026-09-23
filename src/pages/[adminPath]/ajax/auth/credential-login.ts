import type {APIRoute} from "astro";

import {handleCredentialLogin} from "@/server/auth/credential-login";

export const POST: APIRoute = ({request}) => handleCredentialLogin(request);
