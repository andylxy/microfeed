import {useCallback, useEffect, useState} from "react";
import {ArrowDownIcon, ArrowUpIcon, PencilIcon} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSelect, {
  type AdminSelectOption,
} from "@/components/admin/shared/AdminSelect";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {cn} from "@/lib/utils";
import {useTranslation} from "@/client/i18n";
import {STATUSES} from "@/shared/Constants";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {
  VolumeBoard,
  VolumeBookOption,
} from "@/shared/ExtVolume";

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
 * Volume board: one book's chapters grouped by their `_microfeed.volume` tag.
 *
 * A volume is not an entity, so "managing volumes" is really four chapter
 * writes — file chapters under a volume, renumber chapters, rename a volume
 * (rewrite the tag), and give volumes an explicit order.
 */
export default function VolumesApp() {
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
  const [chapterEdits, setChapterEdits] = useState<Record<string, string>>({});
  const [targetVolume, setTargetVolume] = useState("");
  const [newVolume, setNewVolume] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

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
      setChapterEdits({});
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

  const saveChapterOrder = () => {
    if (!bookId) return;
    const updates = Object.entries(chapterEdits)
      .map(([id, value]) => ({chapterNo: Number(value), id}))
      .filter(({chapterNo}) => Number.isFinite(chapterNo));
    if (updates.length === 0) return;
    void post(
      ADMIN_URLS.ajaxVolumeReorder(),
      {bookId, updates},
      "volumes.orderSaved",
      "volumes.orderFailed",
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
                setChapterEdits({});
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
              <Button
                disabled={saving || Object.keys(chapterEdits).length === 0}
                onClick={saveChapterOrder}
                type="button"
                variant="outline"
              >
                {t("volumes.saveOrder")}
              </Button>
            </div>
            <p aria-live="polite" className="mt-2 text-xs text-muted-foreground">
              {t("volumes.selectedCount", {count: selected.length})}
            </p>
          </section>

          {board.groups.length === 0 ? (
            <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
              <p className="text-sm text-muted-foreground">
                {t("volumes.listEmpty")}
              </p>
            </section>
          ) : (
            board.groups.map((group, index) => (
              <section
                className="overflow-hidden rounded-[14px] border bg-card shadow-xs"
                key={group.name || "__unfiled__"}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
                  {renaming === group.name ? (
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
                        onClick={() => applyRename(group.name)}
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
                        {group.name || t("volumes.unfiled")}
                      </h2>
                      <span className="text-xs text-muted-foreground">
                        {t("volumes.chapterCount", {
                          count: group.chapters.length,
                        })}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <Button
                      aria-label={t("volumes.moveUp")}
                      disabled={saving || index === 0}
                      onClick={() => moveVolume(index, -1)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={t("volumes.moveDown")}
                      disabled={saving || index === board.groups.length - 1}
                      onClick={() => moveVolume(index, 1)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                    {group.name && (
                      <Button
                        onClick={() => {
                          setRenaming(group.name);
                          setRenameValue(group.name);
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

                <div className="divide-y">
                  {group.chapters.map((chapter) => (
                    <div
                      className="flex flex-wrap items-center gap-3 px-4 py-2"
                      key={chapter.id}
                    >
                      <input
                        aria-label={chapter.title}
                        checked={selected.includes(chapter.id)}
                        className="size-4"
                        onChange={() => toggleSelected(chapter.id)}
                        type="checkbox"
                      />
                      <input
                        aria-label={t("volumes.chapterNo")}
                        className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
                        onChange={(event) => setChapterEdits((current) => ({
                          ...current,
                          [chapter.id]: event.target.value,
                        }))}
                        type="number"
                        value={chapterEdits[chapter.id]
                          ?? String(chapter.chapterNo)}
                      />
                      <a
                        className="min-w-0 flex-1 truncate text-sm hover:underline"
                        href={ADMIN_URLS.editItem(chapter.id)}
                      >
                        {chapter.title}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {chapter.status === STATUSES.PUBLISHED
                          ? t("volumes.published")
                          : t("volumes.draft")}
                      </span>
                      {/*
                        The chapter's whole audit trail — every recorded change,
                        with the ability to put an earlier version back. Lives on
                        the audit page for this item, linked here so it is
                        reachable from wherever chapters are listed.
                      */}
                      <a
                        className="shrink-0 text-xs text-muted-foreground hover:underline"
                        href={ADMIN_URLS.auditItem(chapter.id)}
                        title={t("volumes.auditHint")}
                      >
                        {t("volumes.auditRecords")}
                      </a>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
