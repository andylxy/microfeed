import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {purgeAdminPage} from "@/server/admin/page-handlers";

export const POST = withRbacGuard(purgeAdminPage, PERMISSION_CODES.CONTENT_PAGE_MANAGE);
