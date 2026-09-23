import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {reorderAdminPageNavigation} from "@/server/admin/page-handlers";

export const PUT = withRbacGuard(reorderAdminPageNavigation, PERMISSION_CODES.CONTENT_PAGE_MANAGE);
