import {withRbacGuard} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {listAdminItemSummaries} from "@/server/admin/item-handlers";

export const GET = withRbacGuard(listAdminItemSummaries, PERMISSION_CODES.CONTENT_CHAPTER_READ);
