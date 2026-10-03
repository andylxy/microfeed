import {useCallback, useEffect, useMemo, useState} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "lucide-react";

import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {DEFAULT_ITEMS_PER_PAGE, STATUSES} from "@/shared/Constants";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {TcmEntryBoard, TcmEntryRow} from "@/shared/ExtVolume";

interface TcmEntryResponse {
  board: TcmEntryBoard | null;
  books: {id: string; title: string}[];
  error?: string;
}

interface Props {
  /** i18n namespace that supplies this board's copy (`yao` / `term`). */
  namespace: "yao" | "term";
  /** The `tcm_kind` to filter items by and the AJAX path segment. */
  kind: "yao" | "term";
  /** Whether the signed-in user holds the `manage` permission for this board. */
  canManage?: boolean;
  itemsPerPage?: number;
}

/**
 * Board for flat TCM books (中药 / 名词) with full CRUD, in the style of the
 * alias board: pick a book, then a card of rows you can add, rename, re-text,
 * publish, soft-delete and restore.
 *
 * Deletion is a soft `status = 3`, so removed rows leave the board and the App
 * endpoints but stay restorable from the recycle bin — a 方剂 keeps a resolvable
 * `yaoID` target. The recycle view (`?deleted=1`) is a separate fetch rather than
 * a client-side filter so the two sets can never show at once.
 */
export default function TcmEntryBoardApp({
  namespace,
  kind,
  canManage = false,
  itemsPerPage,
}: Props) {
  const pageSize = Math.max(1, itemsPerPage ?? DEFAULT_ITEMS_PER_PAGE);
  const {t} = useTranslation();
  const [books, setBooks] = useState<{id: string; title: string}[]>([]);
  const [bookId, setBookId] = useState("");
  const [board, setBoard] = useState<TcmEntryBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // Recycle bin view: only reachable via the toggle once a book is picked.
  const [showDeleted, setShowDeleted] = useState(false);
  // `null` = closed; `add` = new entry; `edit` = editing `editingId`.
  const [mode, setMode] = useState<"add" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({name: "", text: ""});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(
    async (id: string, deleted: boolean) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (id) params.set("bookId", id);
        if (deleted) params.set("deleted", "1");
        const response = await fetch(
          `${ADMIN_URLS.ajaxTcmEntry(kind)}?${params.toString()}`,
        );
        const data = await response.json().catch(() => ({})) as TcmEntryResponse;
        if (!response.ok) {
          throw new Error(data.error ?? t(`${namespace}.loadFailed`));
        }
        setBooks(Array.isArray(data.books) ? data.books : []);
        setBoard(data.board ?? null);
        setError(null);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t(`${namespace}.loadFailed`),
        );
      } finally {
        setLoading(false);
      }
    },
    [kind, namespace, t],
  );

  useEffect(() => {
    setPage(0);
    void load(bookId, showDeleted);
  }, [bookId, showDeleted, load]);

  const mutate = useCallback(
    async (
      action: "add" | "update" | "delete",
      body: unknown,
      restore = false,
    ): Promise<boolean> => {
      setBusy(true);
      setFormError(null);
      try {
        const path = restore
          ? ADMIN_URLS.ajaxTcmEntryRestore(kind)
          : ADMIN_URLS.ajaxTcmEntryAction(kind);
        const response = await fetch(path, {
          body: JSON.stringify({action, ...(body as object)}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        const data = await response.json().catch(() => ({})) as TcmEntryResponse;
        if (!response.ok) {
          throw new Error(data.error ?? t(`${namespace}.saveFailed`));
        }
        // Every mutation returns the re-rendered board, so the list never drifts
        // from what was actually written.
        if (data.board) setBoard(data.board);
        return true;
      } catch (mutateError) {
        setFormError(
          mutateError instanceof Error
            ? mutateError.message
            : t(`${namespace}.saveFailed`),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [kind, namespace, t],
  );

  const closeForm = useCallback(() => {
    setMode(null);
    setEditingId(null);
    setDraft({name: "", text: ""});
    setFormError(null);
  }, []);

  const startAdd = useCallback(() => {
    setMode("add");
    setEditingId(null);
    setDraft({name: "", text: ""});
    setFormError(null);
  }, []);

  const startEdit = useCallback((row: TcmEntryRow) => {
    setMode("edit");
    setEditingId(row.id);
    setDraft({name: row.name, text: row.text});
    setFormError(null);
  }, []);

  const submit = useCallback(async () => {
    if (draft.name.trim() === "") {
      setFormError(t(`${namespace}.required`));
      return;
    }
    // `text` travels even when empty so an existing body can be cleared.
    const ok = mode === "edit" && editingId
      ? await mutate("update", {id: editingId, name: draft.name, text: draft.text})
      : await mutate("add", {bookId, name: draft.name, text: draft.text});
    if (ok) closeForm();
  }, [bookId, closeForm, draft, editingId, mode, mutate, namespace, t]);

  const remove = useCallback(
    async (row: TcmEntryRow) => {
      if (!window.confirm(t(`${namespace}.deleteConfirm`, {name: row.name}))) {
        return;
      }
      await mutate("delete", {id: row.id});
    },
    [mutate, namespace, t],
  );

  const restore = useCallback(
    async (row: TcmEntryRow) => {
      if (!window.confirm(t(`${namespace}.restoreConfirm`, {name: row.name}))) {
        return;
      }
      await mutate("update", {id: row.id}, true);
    },
    [mutate, namespace, t],
  );

  const togglePublish = useCallback(
    async (row: TcmEntryRow) => {
      const next = row.status === STATUSES.PUBLISHED
        ? STATUSES.UNLISTED
        : STATUSES.PUBLISHED;
      await mutate("update", {id: row.id, status: next});
    },
    [mutate],
  );

  // Rows are the entries themselves, counted toward `itemsPerPage`. The whole
  // list still loads in one request; paging is a client-side slice so a large
  // book's rows don't render at once.
  const entries = useMemo(() => board?.entries ?? [], [board]);
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageEntries = useMemo(
    () => entries.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [entries, pageSize, safePage],
  );

  if (loading && books.length === 0) {
    return <AdminCollectionLoading label={t(`${namespace}.title`)} />;
  }

  if (error && !board) {
    return (
      <AdminCollectionError
        message={error}
        retry={() => void load(bookId, showDeleted)}
      />
    );
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t(`${namespace}.title`)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(`${namespace}.intro`)}
          </p>
        </div>
        {canManage && !showDeleted && (
          <Button disabled={!bookId} onClick={startAdd} size="sm" type="button">
            <PlusIcon aria-hidden="true" />
            {t(`${namespace}.add`)}
          </Button>
        )}
      </div>

      {books.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {books.map((book) => (
            <button
              className={`rounded-full border px-3 py-1 text-sm ${bookId === book.id
                ? "border-primary text-primary"
                : "text-muted-foreground"}`}
              key={book.id}
              onClick={() => setBookId(book.id)}
              type="button"
            >
              {book.title}
            </button>
          ))}
        </div>
      )}

      {!bookId && (
        <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
          <p className="text-sm text-muted-foreground">
            {t(`${namespace}.pickBook`)}
          </p>
        </section>
      )}

      {bookId && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {t(`${namespace}.entryCount`, {count: entries.length})}
          </span>
          {canManage && (
            <Button
              onClick={() => setShowDeleted((v) => !v)}
              size="sm"
              type="button"
              variant="outline"
            >
              {showDeleted
                ? t(`${namespace}.backToList`)
                : t(`${namespace}.trash`)}
            </Button>
          )}
        </div>
      )}

      {bookId && board && !board.book && (
        <AdminCollectionError
          message={t(`${namespace}.bookMissing`)}
          retry={() => void load(bookId, showDeleted)}
        />
      )}

      {board?.book && !showDeleted && mode && (
        <section className="grid gap-3 rounded-[14px] border bg-card p-4 shadow-xs">
          <h2 className="text-sm font-semibold">
            {mode === "edit"
              ? t(`${namespace}.editTitle`)
              : t(`${namespace}.addTitle`)}
          </h2>
          <div className="grid gap-3">
            <input
              autoFocus
              className="rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(event) =>
                setDraft((prev) => ({...prev, name: event.target.value}))}
              placeholder={t(`${namespace}.namePlaceholder`)}
              value={draft.name}
            />
            <textarea
              className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(event) =>
                setDraft((prev) => ({...prev, text: event.target.value}))}
              placeholder={t(`${namespace}.textPlaceholder`)}
              value={draft.text}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={busy}
              onClick={() => void submit()}
              size="sm"
              type="button"
            >
              {t(`${namespace}.save`)}
            </Button>
            <Button
              disabled={busy}
              onClick={closeForm}
              size="sm"
              type="button"
              variant="outline"
            >
              {t(`${namespace}.cancel`)}
            </Button>
          </div>
          {formError && (
            <p className="text-xs text-destructive">{formError}</p>
          )}
        </section>
      )}

      {board?.book && (
        <div
          aria-busy={loading}
          className={`grid gap-4 transition-opacity ${loading ? "opacity-60" : ""}`}
        >
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{board.book.title}</h2>
          </div>

          {entries.length === 0 ? (
            <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
              <p className="text-sm text-muted-foreground">
                {showDeleted
                  ? t(`${namespace}.trashEmpty`)
                  : t(`${namespace}.listEmpty`)}
              </p>
            </section>
          ) : (
            <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
              <div className="divide-y">
                {pageEntries.map((entry: TcmEntryRow) => (
                  <div
                    className="flex flex-wrap items-center gap-3 px-4 py-2"
                    key={entry.id}
                  >
                    <a
                      className="min-w-0 flex-1 truncate text-sm hover:underline"
                      href={ADMIN_URLS.editItem(entry.id)}
                    >
                      {entry.name}
                    </a>
                    {typeof entry.no === "number" && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        #{entry.no}
                      </span>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {entry.status === STATUSES.PUBLISHED
                        || entry.status === STATUSES.UNLISTED
                        ? t(`${namespace}.published`)
                        : t(`${namespace}.draft`)}
                    </span>
                    {canManage && (
                      <div className="flex shrink-0 items-center gap-1">
                        {showDeleted ? (
                          <Button
                            disabled={busy}
                            onClick={() => void restore(entry)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {t(`${namespace}.restore`)}
                          </Button>
                        ) : (
                          <>
                            <Button
                              disabled={busy}
                              onClick={() => startEdit(entry)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              {t(`${namespace}.edit`)}
                            </Button>
                            <Button
                              disabled={busy}
                              onClick={() => void togglePublish(entry)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              {entry.status === STATUSES.PUBLISHED
                                ? t(`${namespace}.unpublish`)
                                : t(`${namespace}.publish`)}
                            </Button>
                            <Button
                              disabled={busy}
                              onClick={() => void remove(entry)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              {t(`${namespace}.delete`)}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {board?.book && totalPages > 1 && (
        <nav
          aria-label={t("volumes.paginationAria")}
          className="mt-6 flex items-center justify-center gap-2"
        >
          <Button
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            size="sm"
            type="button"
            variant="outline"
          >
            <ChevronLeftIcon aria-hidden="true" />
            {t("volumes.previous")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("volumes.pageIndicator", {current: safePage + 1, total: totalPages})}
          </span>
          <Button
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("volumes.next")}
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </nav>
      )}
    </div>
  );
}
