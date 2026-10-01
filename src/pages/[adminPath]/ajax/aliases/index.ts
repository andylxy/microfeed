/**
 * Alias board CRUD. `GET` lists every effective alias (imported + manual, each
 * tagged with its source); `POST`/`PUT`/`DELETE` maintain the manual aliases in
 * `ext_tcm_aliases`, which the mobile app's `GetAliaZhongYao` endpoint merges
 * last (so a manual alias overrides an imported one). Guards live on the
 * handler module.
 */
export {
  createAliasEndpoint as POST,
  deleteAliasEndpoint as DELETE,
  listAliasesEndpoint as GET,
  updateAliasEndpoint as PUT,
} from "@/server/admin/alias-handlers";
