import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {resetAdminSiteFile} from "@/server/admin/site-file-handlers";

export const POST = withRbacGuard(resetAdminSiteFile, PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE);
