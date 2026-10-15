import {useCallback, useEffect, useState} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import AdminInput from "@/components/admin/shared/AdminInput";
import {Button} from "@/components/ui/button";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {cn} from "@/lib/utils";
import {useTranslation} from "@/client/i18n";
import {STATUSES} from "@/shared/Constants";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {
  VolumeBookOption,
  VolumeEntry,
  VolumeEntryList,
  VolumeList,
} from "@/shared/ExtVolume";

interface CategoryOption {
  id: string;
  name: string;
  bookCount?: number;
}

interface VolumesResponse {
  volumes: VolumeList | null;
  books: VolumeBookOption[];
  categories?: CategoryOption[];
}

// 条目的状态标签与条目编辑页同源（EditItemApp），两个后台视图对同一个状态的说法不能不一致。
const ENTRY_STATUS_LABEL_KEYS: Record<number, string> = {
  [STATUSES.PUBLISHED]: "items.statusPublished",
  [STATUSES.UNLISTED]: "items.statusUnlisted",
  [STATUSES.UNPUBLISHED]: "items.statusUnpublished",
};

function entryStatusLabelKey(status: number): string {
  return ENTRY_STATUS_LABEL_KEYS[status] ?? "items.statusUnpublished";
}

/** 地址里的展开态：`bookId` 选书，`volume` 选卷。 */
function readLocationState(): {bookId: string; volume: string} {
  const params = new URLSearchParams(window.location.search);
  return {
    bookId: params.get("bookId") ?? "",
    volume: params.get("volume") ?? "",
  };
}

function writeLocationState(bookId: string, volume: string): void {
  const params = new URLSearchParams(window.location.search);
  if (bookId) params.set("bookId", bookId);
  else params.delete("bookId");
  if (volume) params.set("volume", volume);
  else params.delete("volume");
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", url);
}

/**
 * Volume board: one book's volumes, and one volume's entries.
 *
 * Clicking a book loads the volume rows and their entry counts only. Clicking a
 * volume loads that volume's entries in a second request — every entry it has,
 * shown at once, with no page control anywhere on this page. Opening the book a
 * 81-volume classic had cost 8,812 row reads before; it now costs a few hundred,
 * and expanding the largest volume reads the ~600 rows that volume actually has.
 *
 * The expanded volume lives in the URL, so refresh, back, and sending a
 * colleague a link to one volume all land on the same volume.
 */
export default function VolumesApp() {
  const {t} = useTranslation();
  const [books, setBooks] = useState<VolumeBookOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [bookId, setBookId] = useState(() => readLocationState().bookId);
  const [volumeKey, setVolumeKey] = useState(() => readLocationState().volume);
  const [volumeList, setVolumeList] = useState<VolumeList | null>(null);
  const [entries, setEntries] = useState<VolumeEntryList | null>(null);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setVolumeList(data.volumes ?? null);
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

  // 展开态变化时取该卷条目；收起（volumeKey 为空）不发请求。
  useEffect(() => {
    if (!bookId || !volumeKey) {
      setEntries(null);
      setEntriesError(null);
      setEntriesLoading(false);
      return;
    }
    let cancelled = false;
    setEntriesLoading(true);
    setEntriesError(null);
    const params = new URLSearchParams({bookId, volume: volumeKey});
    fetch(`${ADMIN_URLS.ajaxVolumeEntries()}?${params.toString()}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as VolumeEntryList;
        if (!response.ok) {
          throw new Error(
            (data as unknown as Record<string, any>).error ??
              t("volumes.entriesFailed"),
          );
        }
        if (!cancelled) setEntries(data);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setEntries(null);
        setEntriesError(
          loadError instanceof Error
            ? loadError.message
            : t("volumes.entriesFailed"),
        );
      })
      .finally(() => {
        if (!cancelled) setEntriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, volumeKey, t]);

  // 浏览器后退/前进改写了这两个查询参数时，跟着回到对应的那一卷。
  useEffect(() => {
    const onPopState = () => {
      const state = readLocationState();
      setBookId(state.bookId);
      setVolumeKey(state.volume);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectBook = (id: string) => {
    setBookId(id);
    setVolumeKey("");
    writeLocationState(id, "");
  };

  const toggleVolume = (key: string) => {
    const next = volumeKey === key ? "" : key;
    setVolumeKey(next);
    writeLocationState(bookId, next);
  };

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
    const volumes = volumeList?.volumes ?? [];
    if (!bookId || !volumeList) return;
    const target = index + delta;
    if (target < 0 || target >= volumes.length) return;
    const reordered = [...volumes];
    const moved = reordered[index];
    const swapped = reordered[target];
    if (!moved || !swapped) return;
    reordered[index] = swapped;
    reordered[target] = moved;
    void post(
      ADMIN_URLS.ajaxVolumeOrder(),
      {
        bookId,
        orders: reordered.map((volume, position) => ({
          order: position,
          volume: volume.name,
        })),
      },
      "volumes.volumeOrderSaved",
      "volumes.volumeOrderFailed",
    );
  };

  if (loading && books.length === 0) {
    return <AdminCollectionLoading label={t("volumes.title")} />;
  }

  if (error && !volumeList) {
    return (
      <AdminCollectionError
        message={error}
        retry={() => void load(bookId)}
      />
    );
  }

  const volumes = volumeList?.volumes ?? [];
  const entriesNoun = t(
    volumeList?.tcm ? "volumes.nounSections" : "volumes.nounChapters",
  );

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
              setVolumeKey("");
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
                setVolumeKey("");
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
              onClick={() => selectBook(book.id)}
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

      {bookId && volumeList && !volumeList.book && (
        <AdminCollectionError
          message={t("volumes.bookMissing")}
          retry={() => void load(bookId)}
        />
      )}

      {volumeList?.book && (
        <div
          aria-busy={loading || saving}
          className={cn(
            "grid gap-4 transition-opacity",
            (loading || saving) && "opacity-60",
          )}
        >
          {volumes.length === 0 ? (
            <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
              <p className="text-sm text-muted-foreground">
                {t("volumes.listEmpty")}
              </p>
            </section>
          ) : (
            <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
              <div className="divide-y">
                {volumes.map((volume, index) => {
                  const expanded = volumeKey === volume.key;
                  return (
                    <div key={volume.key}>
                      <div
                        className="flex flex-wrap items-center justify-between gap-2 bg-muted/30 px-4 py-3"
                      >
                        {renaming === volume.name ? (
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
                              onClick={() => applyRename(volume.name)}
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
                            <button
                              aria-expanded={expanded}
                              className="flex cursor-pointer items-center gap-2 text-left"
                              onClick={() => toggleVolume(volume.key)}
                              type="button"
                            >
                              {expanded ? (
                                <ChevronDownIcon
                                  aria-hidden="true"
                                  className="size-4 text-muted-foreground"
                                />
                              ) : (
                                <ChevronRightIcon
                                  aria-hidden="true"
                                  className="size-4 text-muted-foreground"
                                />
                              )}
                              <span className="sr-only">
                                {t(expanded ? "volumes.collapse" : "volumes.expand")}
                              </span>
                              <h2 className="font-semibold">
                                {volume.name || t("volumes.unfiled")}
                              </h2>
                            </button>
                            <span className="text-xs text-muted-foreground">
                              {t(
                                volumeList.tcm
                                  ? "volumes.sectionCount"
                                  : "volumes.chapterCount",
                                {count: volume.chapterCount},
                              )}
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
                            disabled={saving || index === volumes.length - 1}
                            onClick={() => moveVolume(index, 1)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <ArrowDownIcon aria-hidden="true" />
                          </Button>
                          {volume.name && (
                            <Button
                              onClick={() => {
                                setRenaming(volume.name);
                                setRenameValue(volume.name);
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

                      {expanded && (
                        <div className="divide-y border-t bg-background">
                          {entriesLoading && (
                            <p className="px-4 py-3 text-sm text-muted-foreground">
                              {t("volumes.entriesLoading")}
                            </p>
                          )}
                          {entriesError && (
                            <p className="px-4 py-3 text-sm text-destructive">
                              {entriesError}
                            </p>
                          )}
                          {!entriesLoading && !entriesError
                            && (entries?.entries.length ?? 0) === 0 && (
                            <p className="px-4 py-3 text-sm text-muted-foreground">
                              {t("volumes.entriesEmpty", {noun: entriesNoun})}
                            </p>
                          )}
                          {!entriesLoading && (entries?.entries ?? []).map(
                            (entry: VolumeEntry) => (
                              <div
                                className="flex flex-wrap items-center gap-3 px-4 py-2"
                                key={entry.id}
                              >
                                <span className="w-8 shrink-0 text-xs tabular-nums text-muted-foreground">
                                  {entry.index}
                                </span>
                                <a
                                  className="min-w-0 flex-1 truncate text-sm hover:underline"
                                  href={ADMIN_URLS.editItem(entry.id)}
                                >
                                  {entry.title}
                                </a>
                                <span className="text-xs text-muted-foreground">
                                  {t(entryStatusLabelKey(entry.status))}
                                </span>
                                {/* 该条目的全部修改留痕与恢复入口都在审计页，就地给出链接。 */}
                                <a
                                  className="shrink-0 text-xs text-muted-foreground hover:underline"
                                  href={ADMIN_URLS.auditItem(entry.id)}
                                  title={t("volumes.auditHint")}
                                >
                                  {t("volumes.auditRecords")}
                                </a>
                              </div>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
