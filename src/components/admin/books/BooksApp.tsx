import {useCallback, useEffect, useState, type ChangeEvent} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSelect, {
  type AdminSelectOption,
} from "@/components/admin/shared/AdminSelect";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {STATUSES} from "@/shared/Constants";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {
  BookAdmin,
  BookCategoryOption,
  BooksBoard,
} from "@/shared/ExtBook";

interface BookFormState {
  author: string;
  categoryId: string;
  cover: string;
  description: string;
  serialStatus: string;
  status: number;
  title: string;
  wordCount: string;
}

const EMPTY_FORM: BookFormState = {
  author: "",
  categoryId: "",
  cover: "",
  description: "",
  serialStatus: "serializing",
  status: STATUSES.PUBLISHED,
  title: "",
  wordCount: "",
};

function formFromBook(book: BookAdmin): BookFormState {
  return {
    author: book.author,
    categoryId: book.categoryId,
    cover: book.cover,
    description: book.description,
    serialStatus: book.serialStatus || "serializing",
    status: book.status || STATUSES.PUBLISHED,
    title: book.title,
    wordCount: book.wordCount == null ? "" : String(book.wordCount),
  };
}

function formToPayload(form: BookFormState) {
  const trimmedWordCount = form.wordCount.trim();
  return {
    author: form.author.trim(),
    categoryId: form.categoryId || null,
    cover: form.cover.trim(),
    description: form.description.trim(),
    serialStatus: form.serialStatus,
    status: form.status,
    title: form.title.trim(),
    wordCount: trimmedWordCount ? Number(trimmedWordCount) : null,
  };
}

/**
 * Book manager: the CRUD screen the sample books were missing.
 *
 * A book is a `channels` row, so the site's own feed (the primary channel)
 * shows up as one of them — it is editable but cannot be deleted. Deletion is
 * a soft `status = 3`, and the chapters of a deleted book are left alone.
 */
export default function BooksApp() {
  const {t} = useTranslation();
  const [books, setBooks] = useState<BookAdmin[]>([]);
  const [categories, setCategories] = useState<BookCategoryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BookAdmin | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<BookAdmin | null>(null);
  const [form, setForm] = useState<BookFormState>(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBooks());
      const data = await response.json().catch(() => ({})) as BooksBoard &
        Record<string, any>;
      if (!response.ok) throw new Error(data.error ?? t("books.loadFailed"));
      setBooks(Array.isArray(data.books) ? data.books : []);
      setCategories(Array.isArray(data.categories) ? data.categories : []);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("books.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const categoryOptions: AdminSelectOption[] = [
    {label: t("books.noCategory"), value: ""},
    ...categories.map((category) => ({
      label: category.name,
      value: category.id,
    })),
  ];
  const statusOptions: AdminSelectOption[] = [
    {label: t("books.serializing"), value: "serializing"},
    {label: t("books.finished"), value: "finished"},
  ];
  const visibilityOptions: AdminSelectOption[] = [
    {label: t("books.published"), value: String(STATUSES.PUBLISHED)},
    {label: t("books.draft"), value: String(STATUSES.UNPUBLISHED)},
  ];

  const startCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setCreating(true);
  };

  const startEdit = (book: BookAdmin) => {
    setCreating(false);
    setForm(formFromBook(book));
    setEditing(book);
  };

  const cancel = () => {
    setEditing(null);
    setCreating(false);
    setForm(EMPTY_FORM);
  };

  const save = async () => {
    if (!form.title.trim()) {
      showToast(t("errors.books.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = editing != null
        ? await fetch(ADMIN_URLS.ajaxBook(editing.id), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxBooks(), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      const data = await response.json().catch(() => ({})) as Record<string, any>;
      if (!response.ok) throw new Error(data.error ?? t("books.saveFailed"));
      showToast(t("saveAction.saved"), "success");
      cancel();
      await load();
    } catch (saveError) {
      showToast(
        saveError instanceof Error ? saveError.message : t("books.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (book: BookAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBook(book.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, any>;
      if (!response.ok) throw new Error(data.error ?? t("books.deleteFailed"));
      showToast(t("saveAction.saved"), "success");
      setConfirming(null);
      await load();
    } catch (deleteError) {
      showToast(
        deleteError instanceof Error
          ? deleteError.message
          : t("books.deleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <AdminCollectionLoading label={t("books.title")} />;
  }
  if (error) {
    return (
      <AdminCollectionError
        message={error}
        retry={() => void load()}
      />
    );
  }

  const showForm = creating || editing != null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("books.intro")}</p>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("books.title")}</h2>
        {!showForm && (
          <Button onClick={startCreate} type="button" variant="outline">
            {t("books.newBook")}
          </Button>
        )}
      </div>

      {showForm && (
        <div className="space-y-4 rounded-lg border p-4">
          <h3 className="font-medium">
            {editing ? t("books.editBook") : t("books.newBook")}
          </h3>
          <AdminInput
            label={t("books.nameLabel")}
            onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setForm({...form, title: event.target.value})}
            value={form.title}
          />
          <AdminInput
            label={t("books.authorLabel")}
            onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setForm({...form, author: event.target.value})}
            value={form.author}
          />
          <AdminInput
            label={t("books.coverLabel")}
            onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setForm({...form, cover: event.target.value})}
            value={form.cover}
          />
          <AdminInput
            label={t("books.wordCountLabel")}
            onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setForm({...form, wordCount: event.target.value})}
            type="number"
            value={form.wordCount}
          />
          <AdminSelect
            label={t("books.categoryLabel")}
            onChange={(option) =>
              setForm({...form, categoryId: option.value})}
            options={categoryOptions}
            value={categoryOptions.find(({value}) => value === form.categoryId)
              ?? categoryOptions[0]}
          />
          <AdminSelect
            label={t("books.serialStatusLabel")}
            onChange={(option) =>
              setForm({...form, serialStatus: option.value})}
            options={statusOptions}
            value={statusOptions.find(({value}) => value === form.serialStatus)
              ?? statusOptions[0]}
          />
          <AdminSelect
            label={t("books.statusLabel")}
            onChange={(option) =>
              setForm({...form, status: Number(option.value)})}
            options={visibilityOptions}
            value={visibilityOptions.find(
              ({value}) => Number(value) === form.status,
            ) ?? visibilityOptions[0]}
          />
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="book-description">
              {t("books.descriptionLabel")}
            </label>
            <textarea
              className="w-full rounded-md border px-3 py-2 text-sm"
              id="book-description"
              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setForm({...form, description: event.target.value})}
              rows={4}
              value={form.description}
            />
          </div>
          <div className="flex gap-2">
            <Button disabled={saving} onClick={() => void save()} type="button">
              {t("books.saveAction")}
            </Button>
            <Button
              onClick={cancel}
              type="button"
              variant="ghost"
            >
              {t("books.cancelAction")}
            </Button>
          </div>
        </div>
      )}

      {books.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">{t("books.empty")}</p>
      )}

      <div className="divide-y rounded-lg border">
        {books.map((book) => (
          <div
            className="flex flex-wrap items-center justify-between gap-3 p-3"
            key={book.id}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {book.title || t("books.untitled")}
                </span>
                {book.isPrimary && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {t("books.primaryBadge")}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {book.status === STATUSES.PUBLISHED
                    ? t("books.published")
                    : t("books.draft")}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {book.author || "—"} · {book.categoryName || t("books.noCategory")}
                {" · "}
                {book.serialStatus === "finished"
                  ? t("books.finished")
                  : t("books.serializing")}
                {book.wordCount != null && ` · ${book.wordCount}`}
                {` · ${book.chapterCount} ${t("books.chapterCount")}`}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => startEdit(book)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("books.editBook")}
              </Button>
              {!book.isPrimary && (
                <Button
                  onClick={() => setConfirming(book)}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  {t("books.deleteAction")}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {confirming && (
        <div className="space-y-3 rounded-lg border border-destructive p-4">
          <p className="text-sm">{t("books.confirmDelete")}</p>
          <div className="flex gap-2">
            <Button
              disabled={saving}
              onClick={() => void remove(confirming)}
              type="button"
              variant="destructive"
            >
              {t("books.deleteAction")}
            </Button>
            <Button
              onClick={() => setConfirming(null)}
              type="button"
              variant="ghost"
            >
              {t("books.cancelAction")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
