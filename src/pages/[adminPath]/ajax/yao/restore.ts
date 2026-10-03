/**
 * Restore a soft-deleted 中药 entry (`POST {id, status?}`). Separate from
 * `ajax/yao` because `DELETE` there already means "soft-delete"; restoring is the
 * inverse verb, so it gets its own path instead of a body flag.
 */
import {
  TCM_ENTRY_KINDS,
  tcmEntryEndpoints,
} from "@/server/admin/tcm-entry-handlers";

export const POST = tcmEntryEndpoints(TCM_ENTRY_KINDS.yao).restore;
