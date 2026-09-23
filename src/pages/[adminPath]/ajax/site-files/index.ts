import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {createAdminSiteFile, listAdminSiteFiles} from "@/server/admin/site-file-handlers";

export const GET = withRbacGuard(listAdminSiteFiles, PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE);
export const POST = withRbacGuard(createAdminSiteFile, PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE);
