/**
 * Restore a soft-deleted 名词 entry (`POST {id, status?}`). Counterpart of
 * `ajax/yao/restore`.
 */
import {
  TCM_ENTRY_KINDS,
  tcmEntryEndpoints,
} from "@/server/admin/tcm-entry-handlers";

export const POST = tcmEntryEndpoints(TCM_ENTRY_KINDS.term).restore;
