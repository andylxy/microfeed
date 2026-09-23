import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {deleteAdminSiteFile, getAdminSiteFile, updateAdminSiteFile} from "@/server/admin/site-file-handlers";

export const DELETE = withRbacGuard(deleteAdminSiteFile, PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE);
export const GET = withRbacGuard(getAdminSiteFile, PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE);
export const PUT = withRbacGuard(updateAdminSiteFile, PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE);
