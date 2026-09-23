import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {createAdminPage, listAdminPages} from "@/server/admin/page-handlers";

export const GET = withRbacGuard(listAdminPages, PERMISSION_CODES.CONTENT_PAGE_MANAGE);
export const POST = withRbacGuard(createAdminPage, PERMISSION_CODES.CONTENT_PAGE_MANAGE);
