import {useCallback, useEffect, useState} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
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
}

interface Props {
  /** i18n namespace that supplies this board's copy (`yao` / `term`). */
  namespace: "yao" | "term";
  /** The `tcm_kind` to filter items by and the AJAX path segment. */
  kind: "yao" | "term";
  itemsPerPage?: number;
}

/**
 * Generic read-only board for flat TCM books (中药 / 名词), in the same style as
 * the volume/chapter and fang boards: pick a book, then a card of rows
 * (name + `no` + publish state) counted toward the per-page size. Each row links
 * out to the item editor, which owns aliases / content / status editing, so this
 * page stays read-only.
 *
 * The two concrete pages (`/admin/yao/`, `/admin/term/`) differ only by the
 * `namespace` + `kind` props, mirroring `/admin/fangs/`.
 */
export default function TcmEntryBoardApp({namespace, kind, itemsPerPage}: Props) {
  const pageSize = Math.max(1, itemsPerPage ?? DEFAULT_ITEMS_PER_PAGE);
  const {t} = useTranslation();
  const [books, setBooks] = useState<{id: string; title: string}[]>([]);
  const [bookId, setBookId] = useState("");
  const [board, setBoard] = useState<TcmEntryBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (id) params.set("bookId", id);
      const response = await fetch(
        `${ADMIN_URLS.ajaxTcmEntry(kind)}?${params.toString()}`,
      );
      const data = await response.json().catch(() => ({})) as TcmEntryResponse;
      if (!response.ok) {
        throw new Error(
          (data as unknown as Record<string, any>).error
            ?? t(`${namespace}.loadFailed`),
        );
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
  }, [kind, namespace, t]);

  useEffect(() => {
    setPage(0);
    void load(bookId);
  }, [bookId, load]);

  // Rows are the entries themselves, counted toward `itemsPerPage`. The whole
  // list still loads in one request; paging is a client-side slice so a large
  // book's rows don't render at once.
  const entries = board?.entries ?? [];
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageEntries = entries.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  if (loading && books.length === 0) {
    return <AdminCollectionLoading label={t(`${namespace}.title`)} />;
  }

  if (error && !board) {
    return (
      <AdminCollectionError
        message={error}
        retry={() => void load(bookId)}
      />
    );
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t(`${namespace}.title`)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(`${namespace}.intro`)}
          </p>
        </div>
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

      {bookId && board && !board.book && (
        <AdminCollectionError
          message={t(`${namespace}.bookMissing`)}
          retry={() => void load(bookId)}
        />
      )}

      {board?.book && (
        <div
          aria-busy={loading}
          className={`grid gap-4 transition-opacity ${loading ? "opacity-60" : ""}`}
        >
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{board.book.title}</h2>
            <span className="text-xs text-muted-foreground">
              {t(`${namespace}.entryCount`, {count: entries.length})}
            </span>
          </div>

          {entries.length === 0 ? (
            <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
              <p className="text-sm text-muted-foreground">
                {t(`${namespace}.listEmpty`)}
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
