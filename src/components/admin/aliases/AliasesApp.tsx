import {useCallback, useEffect, useMemo, useState} from "react";
import {PlusIcon} from "lucide-react";

import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface AliasRow {
  id: string | null;
  bieming: string;
  name: string;
  source: "manual" | "derived" | "hidden";
}

interface AliasesResponse {
  aliases?: AliasRow[];
  error?: string;
}

interface Props {
  canManage?: boolean;
}

/**
 * Alias board. Lists every effective alias (imported + manual + hidden) the
 * mobile app's `GetAliaZhongYao` endpoint serves.
 *
 *  - `manual`  rows live in `ext_tcm_aliases` (deleted=0): add / edit / delete.
 *  - `derived` rows come from the import pipeline and are read-only, but can be
 *    overridden (add a manual alias with the same `bieming`) or hidden (a
 *    `deleted=1` directive).
 *  - `hidden`  rows are derived aliases with a hide directive: restore removes it.
 *
 * All writes need `content:alias:manage`.
 */
export default function AliasesApp({canManage = false}: Props) {
  const {t} = useTranslation();
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Form mode: `null` = closed; `add` = new; `edit` = edit manual (uses id);
  // `override` = override a derived/hidden alias (POST, no id).
  const [mode, setMode] = useState<"add" | "edit" | "override" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({bieming: "", name: ""});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAliases());
      const data = await response.json().catch(() => ({})) as AliasesResponse;
      if (!response.ok) throw new Error(data.error ?? t("aliases.loadFailed"));
      setAliases(Array.isArray(data.aliases) ? data.aliases : []);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("aliases.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (method: string, body: unknown): Promise<boolean> => {
      setBusy(true);
      setFormError(null);
      try {
        const response = await fetch(ADMIN_URLS.ajaxAliases(), {
          body: JSON.stringify(body),
          headers: {"content-type": "application/json"},
          method,
        });
        const data = await response.json().catch(() => ({})) as AliasesResponse;
        if (!response.ok) throw new Error(data.error ?? t("aliases.saveFailed"));
        setAliases(Array.isArray(data.aliases) ? data.aliases : []);
        return true;
      } catch (mutateError) {
        setFormError(
          mutateError instanceof Error
            ? mutateError.message
            : t("aliases.saveFailed"),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const closeForm = useCallback(() => {
    setMode(null);
    setEditingId(null);
    setDraft({bieming: "", name: ""});
    setFormError(null);
  }, []);

  const startAdd = useCallback(() => {
    setMode("add");
    setEditingId(null);
    setDraft({bieming: "", name: ""});
    setFormError(null);
  }, []);

  const startEdit = useCallback((row: AliasRow) => {
    if (!row.id) return;
    setMode("edit");
    setEditingId(row.id);
    setDraft({bieming: row.bieming, name: row.name});
    setFormError(null);
  }, []);

  const startOverride = useCallback((row: AliasRow) => {
    setMode("override");
    setEditingId(null);
    setDraft({bieming: row.bieming, name: row.name});
    setFormError(null);
  }, []);

  const submit = useCallback(async () => {
    if (!draft.bieming.trim() || !draft.name.trim()) {
      setFormError(t("aliases.required"));
      return;
    }
    let ok: boolean;
    if (mode === "edit" && editingId) {
      ok = await mutate("PUT", {id: editingId, ...draft});
    } else {
      // add or override both create/upsert a manual alias via POST.
      ok = await mutate("POST", draft);
    }
    if (ok) closeForm();
  }, [closeForm, draft, editingId, mode, mutate, t]);

  const remove = useCallback(
    async (row: AliasRow) => {
      if (row.source === "derived") {
        // Hide a derived alias — write a `deleted=1` directive.
        if (!window.confirm(t("aliases.hideConfirm", {bieming: row.bieming}))) {
          return;
        }
        await mutate("DELETE", {bieming: row.bieming, hide: true});
      } else if (row.source === "hidden") {
        // Restore a hidden derived alias — remove the directive by id.
        if (!window.confirm(t("aliases.restoreConfirm", {bieming: row.bieming}))) {
          return;
        }
        if (row.id) await mutate("DELETE", {id: row.id});
      } else {
        // Delete a manual override — derived (if any) reappears.
        if (!window.confirm(t("aliases.deleteConfirm", {bieming: row.bieming}))) {
          return;
        }
        if (row.id) await mutate("DELETE", {id: row.id});
      }
    },
    [mutate, t],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return aliases;
    return aliases.filter(
      (row) =>
        row.bieming.toLowerCase().includes(needle)
        || row.name.toLowerCase().includes(needle),
    );
  }, [aliases, query]);

  const formTitle =
    mode === "edit"
      ? t("aliases.editTitle")
      : mode === "override"
        ? t("aliases.overrideTitle")
        : t("aliases.addTitle");

  if (loading && aliases.length === 0) {
    return <AdminCollectionLoading label={t("aliases.title")} />;
  }

  if (error && aliases.length === 0) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("aliases.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("aliases.intro")}</p>
        </div>
        {canManage && (
          <Button onClick={startAdd} size="sm" type="button">
            <PlusIcon aria-hidden="true" />
            {t("aliases.add")}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          className="w-full max-w-sm rounded-md border bg-background px-3 py-2 text-sm"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("aliases.searchPlaceholder")}
          type="search"
          value={query}
        />
        <span className="text-xs text-muted-foreground">
          {t("aliases.count", {count: filtered.length})}
        </span>
      </div>

      {mode && (
        <section className="grid gap-3 rounded-[14px] border bg-card p-4 shadow-xs">
          <h2 className="text-sm font-semibold">{formTitle}</h2>
          <div className="flex flex-wrap items-center gap-3">
            <input
              autoFocus
              className="rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(event) =>
                setDraft((prev) => ({...prev, bieming: event.target.value}))}
              placeholder={t("aliases.biemingPlaceholder")}
              value={draft.bieming}
            />
            <input
              className="rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(event) =>
                setDraft((prev) => ({...prev, name: event.target.value}))}
              placeholder={t("aliases.namePlaceholder")}
              value={draft.name}
            />
            <Button disabled={busy} onClick={() => void submit()} size="sm" type="button">
              {t("aliases.save")}
            </Button>
            <Button
              disabled={busy}
              onClick={closeForm}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("aliases.cancel")}
            </Button>
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
        </section>
      )}

      {filtered.length === 0 ? (
        <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
          <p className="text-sm text-muted-foreground">{t("aliases.empty")}</p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("aliases.bieming")}</th>
                <th className="px-4 py-2 font-medium">{t("aliases.name")}</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((row) => (
                <tr key={(row.id ?? `d-${row.bieming}`)}>
                  <td className="px-4 py-2">{row.bieming}</td>
                  <td className="px-4 py-2">{row.name}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-xs text-muted-foreground">
                        {row.source === "manual"
                          ? t("aliases.manual")
                          : row.source === "hidden"
                            ? t("aliases.hidden")
                            : t("aliases.derived")}
                      </span>
                      {canManage && (
                        <>
                          {row.source === "manual" ? (
                            <>
                              <Button
                                onClick={() => startEdit(row)}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                {t("aliases.edit")}
                              </Button>
                              <Button
                                onClick={() => void remove(row)}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                {t("aliases.delete")}
                              </Button>
                            </>
                          ) : row.source === "derived" ? (
                            <>
                              <Button
                                onClick={() => startOverride(row)}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                {t("aliases.overrideEdit")}
                              </Button>
                              <Button
                                onClick={() => void remove(row)}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                {t("aliases.hide")}
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                onClick={() => startOverride(row)}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                {t("aliases.overrideEdit")}
                              </Button>
                              <Button
                                onClick={() => void remove(row)}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                {t("aliases.restore")}
                              </Button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
