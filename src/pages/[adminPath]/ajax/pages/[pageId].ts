import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {deleteAdminPage, getAdminPage, updateAdminPage} from "@/server/admin/page-handlers";

export const DELETE = withRbacGuard(deleteAdminPage, PERMISSION_CODES.CONTENT_PAGE_MANAGE);
export const GET = withRbacGuard(getAdminPage, PERMISSION_CODES.CONTENT_PAGE_MANAGE);
export const PUT = withRbacGuard(updateAdminPage, PERMISSION_CODES.CONTENT_PAGE_MANAGE);
