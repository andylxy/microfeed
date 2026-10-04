import {useCallback, useEffect, useMemo, useState} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import AdminInput from "@/components/admin/shared/AdminInput";
import {
  paginate,
} from "@/components/admin/shared/AdminPagination";
import AdminSelect, {
  type AdminSelectOption,
} from "@/components/admin/shared/AdminSelect";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {cn} from "@/lib/utils";
import {useTranslation} from "@/client/i18n";
import {STATUSES} from "@/shared/Constants";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {
  VolumeBoard,
  VolumeBookOption,
  VolumeChapter,
} from "@/shared/ExtVolume";

// Chapter status labels mirror the item edit page (EditItemApp) so the two
// admin views never disagree about what a status means. Previously unlisted
// chapters were shown as "已发布"; now every status renders its true label.
const CHAPTER_STATUS_LABEL_KEYS: Record<number, string> = {
  [STATUSES.PUBLISHED]: "items.statusPublished",
  [STATUSES.UNLISTED]: "items.statusUnlisted",
  [STATUSES.UNPUBLISHED]: "items.statusUnpublished",
};

function chapterStatusLabelKey(status: number): string {
  return CHAPTER_STATUS_LABEL_KEYS[status] ?? "items.statusUnpublished";
}

interface CategoryOption {
  id: string;
  name: string;
  bookCount?: number;
}

interface VolumesResponse {
  board: VolumeBoard | null;
  books: VolumeBookOption[];
  categories?: CategoryOption[];
}

/**
 * One flattened board row: a volume header, or a chapter under some volume.
 * Rows are counted together toward the per-page size, so a volume can span a
 * page boundary while its chapters continue on the next page.
 */
type BoardRow =
  | {kind: "volume"; groupIndex: number; name: string; chapterCount: number}
  | {kind: "chapter"; groupIndex: number; chapter: VolumeChapter};

/**
 * Volume board: one book's chapters grouped by their `_microfeed.volume` tag.
 *
 * A volume is not an entity, so "managing volumes" is really four chapter
 * writes — file chapters under a volume, renumber chapters, rename a volume
 * (rewrite the tag), and give volumes an explicit order.
 */
/**
 * How many rows show per page on the board: each volume contributes one header
 * row, then one row per chapter, so the page size from Settings → Items
 * (itemsPerPage) counts "卷 + 章" together, the same meaning it has on the items
 * list. The whole board is still loaded in one request; paging is a client-side
 * slice so a TCM book's ~1000 rows don't render all at once.
 */
interface Props {
  itemsPerPage?: number;
}

export default function VolumesApp({itemsPerPage}: Props) {
  const {t} = useTranslation();
  const [books, setBooks] = useState<VolumeBookOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [bookId, setBookId] = useState("");
  const [board, setBoard] = useState<VolumeBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetVolume, setTargetVolume] = useState("");
  const [newVolume, setNewVolume] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(async (id: string, category = categoryId) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (id) params.set("bookId", id);
      if (category) params.set("categoryId", category);
      const response = await fetch(
        `${ADMIN_URLS.ajaxVolumes()}?${params.toString()}`,
      );
      const data = await response.json().catch(() => ({})) as VolumesResponse;
      if (!response.ok) {
        throw new Error(
          (data as unknown as Record<string, any>).error ??
            t("volumes.loadFailed"),
        );
      }
      setBooks(Array.isArray(data.books) ? data.books : []);
      setCategories(Array.isArray(data.categories) ? data.categories : []);
      setBoard(data.board ?? null);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("volumes.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [categoryId, t]);

  useEffect(() => {
    setPage(0);
    void load(bookId, categoryId);
  }, [bookId, categoryId, load]);

  const post = useCallback(async (
    url: string,
    body: unknown,
    successKey: string,
    failKey: string,
  ) => {
    setSaving(true);
    try {
      const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      const data = await response.json().catch(() => ({})) as Record<string, any>;
      if (!response.ok) throw new Error(data.error ?? t(failKey));
      showToast(t(successKey), "success");
      setSelected([]);
      setNewVolume("");
      await load(bookId);
    } catch (saveError) {
      showToast(
        saveError instanceof Error ? saveError.message : t(failKey),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }, [bookId, load, t]);


  const volumeOptions: AdminSelectOption[] = (board?.volumeNames ?? []).map(
    (name) => ({label: name, value: name}),
  );

  // TCM books (伤寒杂病论・桂林古本 等) render their structure read-only:
  // volume membership comes from `tcm_parent_id`, not a mutable tag, so the
  // file/rename/reorder controls would write stray tags onto TCM items.
  const readOnly = board?.readOnly === true;

  // Client-side paging over a flattened row list: one header row per volume,
  // then one row per chapter, counted together toward the per-page size. `safePage`
  // keeps the view valid if an edit (e.g. a volume merge) shrinks the row count.
  const rows = useMemo<BoardRow[]>(() => {
    const out: BoardRow[] = [];
    for (const [groupIndex, group] of (board?.groups ?? []).entries()) {
      out.push({
        kind: "volume",
        groupIndex,
        name: group.name,
        chapterCount: group.chapters.length,
      });
      for (const chapter of group.chapters) {
        out.push({kind: "chapter", groupIndex, chapter});
      }
    }
    return out;
  }, [board]);

  // Slice rows for the current page; volume headers keep their global
  // `groupIndex` so the up/down volume reorder still works.
  const {pageRows, safePage, totalPages} = paginate(rows, itemsPerPage, page);

  const applyAssign = () => {
    if (!bookId || selected.length === 0) return;
    const volume = newVolume.trim() || targetVolume;
    void post(
      ADMIN_URLS.ajaxVolumeAssign(),
      {bookId, itemIds: selected, volume},
      "volumes.assigned",
      "volumes.assignFailed",
    );
  };

  const applyRename = (from: string) => {
    const to = renameValue.trim();
    setRenaming(null);
    if (!bookId || !to || to === from) return;
    void post(
      ADMIN_URLS.ajaxVolumeRename(),
      {bookId, from, to},
      "volumes.renamed",
      "volumes.renameFailed",
    );
  };

  const moveVolume = (index: number, delta: number) => {
    if (!board || !bookId) return;
    const target = index + delta;
    if (target < 0 || target >= board.groups.length) return;
    const reordered = [...board.groups];
    const moved = reordered[index];
    const swapped = reordered[target];
    if (!moved || !swapped) return;
    reordered[index] = swapped;
    reordered[target] = moved;
    void post(
      ADMIN_URLS.ajaxVolumeOrder(),
      {
        bookId,
        orders: reordered.map((group, position) => ({
          order: position,
          volume: group.name,
        })),
      },
      "volumes.volumeOrderSaved",
      "volumes.volumeOrderFailed",
    );
  };

  const toggleSelected = (id: string) => {
    setSelected((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id]);
  };

  if (loading && books.length === 0) {
    return <AdminCollectionLoading label={t("volumes.title")} />;
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
          <h1 className="text-xl font-semibold">{t("volumes.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("volumes.intro")}
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
              onClick={() => {
                setBookId(book.id);
                setSelected([]);
              }}
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
            {t("volumes.pickBook")}
          </p>
        </section>
      )}

      {bookId && board && !board.book && (
        <AdminCollectionError
          message={t("volumes.bookMissing")}
          retry={() => void load(bookId)}
        />
      )}

      {board?.book && (
        <div
          aria-busy={loading || saving}
          className={cn(
            "grid gap-4 transition-opacity",
            (loading || saving) && "opacity-60",
          )}
        >
          <section className="rounded-[14px] border bg-card p-4 shadow-xs">
            {!readOnly ? (
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[12rem] flex-1">
                  <AdminSelect
                    label={t("volumes.moveTo")}
                    onChange={(option) => setTargetVolume(option.value)}
                    options={volumeOptions}
                    placeholder={t("volumes.moveToPlaceholder")}
                    value={volumeOptions.find(({value}) => value === targetVolume)
                      ?? null}
                  />
                </div>
                <div className="min-w-[12rem] flex-1">
                  <AdminInput
                    label={t("volumes.newVolume")}
                    onChange={(event: {target: {value: string}}) =>
                      setNewVolume(event.target.value)}
                    placeholder={t("volumes.newVolumePlaceholder")}
                    value={newVolume}
                  />
                </div>
                <Button
                  disabled={saving || selected.length === 0}
                  onClick={applyAssign}
                  type="button"
                >
                  {t("volumes.assign")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("volumes.tcmReadOnly")}
              </p>
            )}
            {!readOnly && (
              <p aria-live="polite" className="mt-2 text-xs text-muted-foreground">
                {t("volumes.selectedCount", {count: selected.length})}
              </p>
            )}
          </section>

          {board.groups.length === 0 ? (
            <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
              <p className="text-sm text-muted-foreground">
                {t("volumes.listEmpty")}
              </p>
            </section>
          ) : (
            <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
              <div className="divide-y">
                {pageRows.map((row) => (
                  row.kind === "volume" ? (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 bg-muted/30 px-4 py-3"
                      key={`volume:${row.groupIndex}`}
                    >
                      {renaming === row.name ? (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-[12rem]">
                            <AdminInput
                              label={t("volumes.newName")}
                              onChange={(event: {target: {value: string}}) =>
                                setRenameValue(event.target.value)}
                              value={renameValue}
                            />
                          </div>
                          <Button
                            onClick={() => applyRename(row.name)}
                            size="sm"
                            type="button"
                          >
                            {t("volumes.renameSave")}
                          </Button>
                          <Button
                            onClick={() => setRenaming(null)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            {t("volumes.cancel")}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold">
                            {row.name || t("volumes.unfiled")}
                          </h2>
                          <span className="text-xs text-muted-foreground">
                            {t("volumes.chapterCount", {count: row.chapterCount})}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center gap-1">
                        {!readOnly && (
                          <>
                            <Button
                              aria-label={t("volumes.moveUp")}
                              disabled={saving || row.groupIndex === 0}
                              onClick={() => moveVolume(row.groupIndex, -1)}
                              size="icon"
                              type="button"
                              variant="ghost"
                            >
                              <ArrowUpIcon aria-hidden="true" />
                            </Button>
                            <Button
                              aria-label={t("volumes.moveDown")}
                              disabled={saving || row.groupIndex === board.groups.length - 1}
                              onClick={() => moveVolume(row.groupIndex, 1)}
                              size="icon"
                              type="button"
                              variant="ghost"
                            >
                              <ArrowDownIcon aria-hidden="true" />
                            </Button>
                          </>
                        )}
                        {!readOnly && row.name && (
                          <Button
                            onClick={() => {
                              setRenaming(row.name);
                              setRenameValue(row.name);
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <PencilIcon aria-hidden="true" /> {t("volumes.rename")}
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (

                    <div
                      className="flex flex-wrap items-center gap-3 px-4 py-2"
                      key={row.chapter.id}
                    >
                      <input
                        aria-label={row.chapter.title}
                        checked={selected.includes(row.chapter.id)}
                        className="size-4"
                        disabled={readOnly}
                        onChange={() => toggleSelected(row.chapter.id)}
                        type="checkbox"
                      />
                      <a
                        className="min-w-0 flex-1 truncate text-sm hover:underline"
                        href={ADMIN_URLS.editItem(row.chapter.id)}
                      >
                        {row.chapter.title}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {t(chapterStatusLabelKey(row.chapter.status))}
                      </span>
                      {/*
                        The chapter's whole audit trail — every recorded change,
                        with the ability to put an earlier version back. Lives on
                        the audit page for this item, linked here so it is
                        reachable from wherever chapters are listed.
                      */}
                      <a
                        className="shrink-0 text-xs text-muted-foreground hover:underline"
                        href={ADMIN_URLS.auditItem(row.chapter.id)}
                        title={t("volumes.auditHint")}
                      >
                        {t("volumes.auditRecords")}
                      </a>
                    </div>
                  )
                ))}
              </div>
            </section>
          )}
        </div>
      )}
      {board?.book && (
        <AdminPagination
          disabled={saving}
          onChange={setPage}
          page={safePage}
          totalPages={totalPages}
        />
      )}
    </div>
  );
}
