import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";

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
import {
  bookStatusBadgeStyle,
  bookStatusDisplayName,
} from "@/shared/ExtBook";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {
  BookAdmin,
  BookCategoryOption,
  BookStatusOption,
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
}

const EMPTY_FORM: BookFormState = {
  author: "",
  categoryId: "",
  cover: "",
  description: "",
  serialStatus: "serializing",
  status: STATUSES.PUBLISHED,
  title: "",
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
  };
}

function formToPayload(form: BookFormState) {
  return {
    author: form.author.trim(),
    categoryId: form.categoryId || null,
    cover: form.cover.trim(),
    description: form.description.trim(),
    serialStatus: form.serialStatus,
    status: form.status,
    title: form.title.trim(),
  };
}

/**
 * Shared book editor. Rendered both at the top (for "New book") and inline
 * inside the row being edited, so editing expands where the user clicked
 * instead of jumping to the top of the page.
 */
function BookForm({
  form,
  setForm,
  editing,
  categoryOptions,
  statusOptions,
  visibilityOptions,
  saving,
  onSave,
  onCancel,
  title,
}: {
  form: BookFormState;
  setForm: Dispatch<SetStateAction<BookFormState>>;
  editing: BookAdmin | null;
  categoryOptions: AdminSelectOption[];
  statusOptions: AdminSelectOption[];
  visibilityOptions: AdminSelectOption[];
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const {t} = useTranslation();
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h3 className="font-medium">{title}</h3>
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
      <div className="grid gap-1 text-sm">
        <span className="font-medium">{t("books.wordCountLabel")}</span>
        <span className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {editing ? `${editing.wordCount} ${t("books.wordCountUnit")}` : "—"}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("books.wordCountDerivedHint")}
        </span>
      </div>
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
        ) ?? null}
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
        <Button disabled={saving} onClick={onSave} type="button">
          {t("books.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("books.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Book manager: the CRUD screen the sample books were missing.
 *
 * A book is a `channels` row, so the site's own feed (the primary channel)
 * shows up as one of them — it is editable but cannot be deleted. Deletion is
 * a soft delete that writes the status dictionary's delete state; the chapters
 * are left alone so a mistyped delete can be restored.
 */
export default function BooksApp() {
  const {t, i18n} = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const [books, setBooks] = useState<BookAdmin[]>([]);
  const [categories, setCategories] = useState<BookCategoryOption[]>([]);
  const [statuses, setStatuses] = useState<BookStatusOption[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BookAdmin | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<BookAdmin | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState<BookAdmin | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
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
      setStatuses(Array.isArray(data.statuses) ? data.statuses : []);
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

  // 软删除的作品（status 命中字典里的删除态）随看板返回，主列表不显示它们，
  // 由「已删除」筹码单列——恢复与物理删除都只对这批行开放。已删除视图不叠
  // 分类筛选（筹码整行隐藏，避免出现空列表又没法重置筛选）。
  const liveBooks = books.filter((book) => !book.isDeleted);
  const deletedBooks = books.filter((book) => book.isDeleted);
  const visibleBooks = categoryFilter
    ? liveBooks.filter((book) => book.categoryId === categoryFilter)
    : liveBooks;
  const listedBooks = showDeleted ? deletedBooks : visibleBooks;
  const countFor = (id: string) =>
    liveBooks.filter((book) => book.categoryId === id).length;
  const firstSelectableCode = statuses.find((row) => row.formSelectable)?.code
    ?? STATUSES.PUBLISHED;

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
  // 显示/隐藏不再是代码里的两项常量：选项来自 `ext_book_status`（迁移 0142），
  // 运营在「书籍状态」页增删状态后这里自动跟上，不需要部署。
  const visibilityOptions: AdminSelectOption[] = statuses
    .filter((row) => row.formSelectable)
    .map((row) => ({
      label: bookStatusDisplayName(row, zh),
      value: String(row.code),
    }));
  const statusLabel = (code: number): string => {
    const row = statuses.find((item) => item.code === code);
    return row ? bookStatusDisplayName(row, zh) : t("books.statusUnknown");
  };

  const startCreate = () => {
    setEditing(null);
    // A new book needs a status the form offers; the first selectable row is
    // the default (normally the system "visible" code).
    setForm({...EMPTY_FORM, status: firstSelectableCode});
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

  /**
   * 恢复软删除的作品：把它切回表单可选状态里的第一个（通常是「显示」）。
   * 走既有更新通道——服务端只允许「切换到表单可选状态」，正好卡住误恢复。
   */
  const restore = async (book: BookAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBook(book.id), {
        body: JSON.stringify({status: firstSelectableCode}),
        headers: {"content-type": "application/json"},
        method: "PUT",
      });
      const data = await response.json().catch(() => ({})) as Record<string, any>;
      if (!response.ok) throw new Error(data.error ?? t("books.saveFailed"));
      showToast(t("saveAction.saved"), "success");
      setConfirmingPurge(null);
      setShowDeleted(false);
      await load();
    } catch (restoreError) {
      showToast(
        restoreError instanceof Error
          ? restoreError.message
          : t("books.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  /** 物理删除：连章节一起清库。确认框里带章节数，删完即不可恢复。 */
  const purge = async (book: BookAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookPurge(book.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, any>;
      if (!response.ok) throw new Error(data.error ?? t("books.purgeFailed"));
      // 服务端返回真正删掉的章节数（含已软删除的章节），提示语按这个数报。
      showToast(t("books.purged", {count: Number(data.chapters ?? 0)}), "success");
      setConfirmingPurge(null);
      setShowDeleted(false);
      await load();
    } catch (purgeError) {
      showToast(
        purgeError instanceof Error
          ? purgeError.message
          : t("books.purgeFailed"),
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

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("books.intro")}</p>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("books.title")}</h2>
        {!creating && (
          <Button onClick={startCreate} type="button" variant="outline">
            {t("books.newBook")}
          </Button>
        )}
      </div>

      {creating && (
        <BookForm
          categoryOptions={categoryOptions}
          editing={null}
          form={form}
          onCancel={cancel}
          onSave={() => void save()}
          saving={saving}
          setForm={setForm}
          statusOptions={statusOptions}
          title={t("books.newBook")}
          visibilityOptions={visibilityOptions}
        />
      )}

      {deletedBooks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            className={`rounded-full border px-3 py-1 text-sm ${showDeleted
              ? "border-destructive text-destructive"
              : "text-muted-foreground"}`}
            onClick={() => setShowDeleted((current) => !current)}
            type="button"
          >
            {t("books.deletedChip")}
            <small className="ml-1 opacity-70">{deletedBooks.length}</small>
          </button>
        </div>
      )}

      {!showDeleted && categories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            className={`rounded-full border px-3 py-1 text-sm ${!categoryFilter
              ? "border-primary text-primary"
              : "text-muted-foreground"}`}
            onClick={() => setCategoryFilter("")}
            type="button"
          >
            {t("books.allCategories")}
          </button>
          {categories.map((category) => (
            <button
              className={`rounded-full border px-3 py-1 text-sm ${categoryFilter === category.id
                ? "border-primary text-primary"
                : "text-muted-foreground"}`}
              key={category.id}
              onClick={() => setCategoryFilter(category.id)}
              type="button"
            >
              {category.name}
              <small className="ml-1 opacity-70">{countFor(category.id)}</small>
            </button>
          ))}
        </div>
      )}

      {listedBooks.length === 0 && !creating && !showDeleted && (
        <p className="text-sm text-muted-foreground">
          {categoryFilter ? t("books.emptyCategory") : t("books.empty")}
        </p>
      )}

      <div className="rounded-lg border">
        {listedBooks.map((book) => {
          const isEditingThis = editing?.id === book.id;
          // 状态徽章按行上色（迁移 0143）：有配色的行画成彩块，没有的保持纯文字。
          const badgeStyle = bookStatusBadgeStyle(
            statuses.find((item) => item.code === book.status)
              ?? {colorFg: null, colorBg: null},
          );
          return (
            <div
              className={isEditingThis ? "" : "border-b last:border-b-0"}
              key={book.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 p-3">
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
                    <span
                      className={badgeStyle
                        ? "rounded px-1.5 py-0.5 text-xs font-medium"
                        : "text-xs text-muted-foreground"}
                      style={badgeStyle}
                    >
                      {statusLabel(book.status)}
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
                {!isEditingThis && (
                  <div className="flex gap-2">
                    {book.isDeleted ? (
                      <>
                        {/* 软删除的行只给恢复与物理删除：编辑会顺手把它改回可见状态 */}
                        <Button
                          onClick={() => void restore(book)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {t("books.restoreAction")}
                        </Button>
                        <Button
                          onClick={() => setConfirmingPurge(book)}
                          size="sm"
                          type="button"
                          variant="destructive"
                        >
                          {t("books.purgeAction")}
                        </Button>
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                )}
              </div>
              {isEditingThis && (
                <div className="border-t bg-muted/30 p-4">
                  <BookForm
                    categoryOptions={categoryOptions}
                    editing={book}
                    form={form}
                    onCancel={cancel}
                    onSave={() => void save()}
                    saving={saving}
                    setForm={setForm}
                    statusOptions={statusOptions}
                    title={t("books.editBook")}
                    visibilityOptions={visibilityOptions}
                  />
                </div>
              )}
            </div>
          );
        })}
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

      {confirmingPurge && (
        <div className="space-y-3 rounded-lg border border-destructive p-4">
          <p className="text-sm">
            {t("books.confirmPurge", {
              title: confirmingPurge.title || t("books.untitled"),
            })}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={saving}
              onClick={() => void purge(confirmingPurge)}
              type="button"
              variant="destructive"
            >
              {t("books.purgeAction")}
            </Button>
            <Button
              onClick={() => setConfirmingPurge(null)}
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
