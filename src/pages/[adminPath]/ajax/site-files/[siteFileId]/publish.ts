import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {publishAdminSiteFile} from "@/server/admin/site-file-handlers";

export const POST = withRbacGuard(publishAdminSiteFile, PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE);
