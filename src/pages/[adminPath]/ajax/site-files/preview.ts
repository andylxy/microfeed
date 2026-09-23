import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {previewAdminSiteFile} from "@/server/admin/site-file-handlers";

export const POST = withRbacGuard(previewAdminSiteFile, PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE);
