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
import type {FangBoard, FangRow} from "@/shared/ExtVolume";

interface CategoryOption {
  id: string;
  name: string;
  bookCount?: number;
}

interface FangsResponse {
  board: FangBoard | null;
  books: {id: string; title: string}[];
  categories?: CategoryOption[];
}

interface Props {
  itemsPerPage?: number;
}

/**
 * Fang (方剂) board: one book's prescriptions in the same style as the
 * volume/chapter board — a book picker, then a card of rows (name + `no` +
 * publish state) counted toward the per-page size. Each row links out to the
 * item editor, which owns the composition (`fangYaoList` via FangEditor) and
 * status editing, so this page stays read-only.
 */
export default function FangsApp({itemsPerPage}: Props) {
  const pageSize = Math.max(1, itemsPerPage ?? DEFAULT_ITEMS_PER_PAGE);
  const {t} = useTranslation();
  const [books, setBooks] = useState<{id: string; title: string}[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [bookId, setBookId] = useState("");
  const [board, setBoard] = useState<FangBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async (id: string, category = categoryId) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (id) params.set("bookId", id);
      if (category) params.set("categoryId", category);
      const response = await fetch(
        `${ADMIN_URLS.ajaxFangs()}?${params.toString()}`,
      );
      const data = await response.json().catch(() => ({})) as FangsResponse;
      if (!response.ok) {
        throw new Error(
          (data as unknown as Record<string, any>).error
            ?? t("fangs.loadFailed"),
        );
      }
      setBooks(Array.isArray(data.books) ? data.books : []);
      setCategories(Array.isArray(data.categories) ? data.categories : []);
      setBoard(data.board ?? null);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("fangs.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [categoryId, t]);

  useEffect(() => {
    setPage(0);
    void load(bookId, categoryId);
  }, [bookId, categoryId, load]);

  // Same meaning as the volume board: rows are the fangs themselves, counted
  // toward `itemsPerPage`. The whole list still loads in one request; paging is
  // a client-side slice so a large book's rows don't render at once.
  const fangs = board?.fangs ?? [];
  const totalPages = Math.max(1, Math.ceil(fangs.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageFangs = fangs.slice(safePage * pageSize, (safePage + 1) * pageSize);

  if (loading && books.length === 0) {
    return <AdminCollectionLoading label={t("fangs.title")} />;
  }

  if (error && !board) {
    return (
      <AdminCollectionError message={error} retry={() => void load(bookId)} />
    );
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("fangs.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("fangs.intro")}
          </p>
        </div>
      </div>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            className={`rounded-full border px-3 py-1 text-sm ${!categoryId
              ? "border-primary text-primary"
              : "text-muted-foreground"}`}
            onClick={() => {
              setCategoryId("");
              setBookId("");
            }}
            type="button"
          >
            {t("volumes.allCategories")}
          </button>
          {categories.map((category) => (
            <button
              className={`rounded-full border px-3 py-1 text-sm ${categoryId === category.id
                ? "border-primary text-primary"
                : "text-muted-foreground"}`}
              key={category.id}
              onClick={() => {
                setCategoryId(category.id);
                setBookId("");
              }}
              type="button"
            >
              {category.name}
              {typeof category.bookCount === "number" && (
                <small className="ml-1 opacity-70">{category.bookCount}</small>
              )}
            </button>
          ))}
        </div>
      )}

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
            {t("fangs.pickBook")}
          </p>
        </section>
      )}

      {bookId && board && !board.book && (
        <AdminCollectionError
          message={t("fangs.bookMissing")}
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
              {t("fangs.fangCount", {count: fangs.length})}
            </span>
          </div>

          {fangs.length === 0 ? (
            <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
              <p className="text-sm text-muted-foreground">
                {t("fangs.listEmpty")}
              </p>
            </section>
          ) : (
            <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
              <div className="divide-y">
                {pageFangs.map((fang: FangRow) => (
                  <div
                    className="flex flex-wrap items-center gap-3 px-4 py-2"
                    key={fang.id}
                  >
                    <a
                      className="min-w-0 flex-1 truncate text-sm hover:underline"
                      href={ADMIN_URLS.editItem(fang.id)}
                    >
                      {fang.name}
                    </a>
                    {typeof fang.no === "number" && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        #{fang.no}
                      </span>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {fang.status === STATUSES.PUBLISHED
                        || fang.status === STATUSES.UNLISTED
                        ? t("fangs.published")
                        : t("fangs.draft")}
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
