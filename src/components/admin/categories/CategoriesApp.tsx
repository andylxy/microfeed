import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  GripVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSelect, {
  type AdminSelectOption,
} from "@/components/admin/shared/AdminSelect";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {cn} from "@/lib/utils";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {Category} from "@/shared/ExtCategory";
import i18n, {useTranslation} from "@/client/i18n";

type DropPosition = "after" | "before";

interface CategoriesResponse {
  items: Category[];
}

async function responseJson(response: Response): Promise<unknown> {
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) {
    throw new Error(data.error ?? i18n.t("categories.loadFailed"));
  }
  return data;
}

/**
 * Reorder a flat category list by moving `draggedId` to before/after
 * `targetId`. Returns the same reference when nothing changes so callers can
 * skip a redundant state update + persist.
 */
function reorderCategoriesList(
  list: Category[],
  draggedId: string,
  targetId: string,
  position: DropPosition,
): Category[] {
  if (draggedId === targetId) return list;
  const draggedIndex = list.findIndex(({id}) => id === draggedId);
  const targetIndex = list.findIndex(({id}) => id === targetId);
  if (draggedIndex < 0 || targetIndex < 0) return list;

  const reordered = [...list];
  const [dragged] = reordered.splice(draggedIndex, 1);
  if (!dragged) return list;
  const adjustedTargetIndex = reordered.findIndex(({id}) => id === targetId);
  reordered.splice(
    position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex,
    0,
    dragged,
  );
  return reordered.every(({id}, index) => id === list[index]?.id)
    ? list
    : reordered;
}

/** Collect a category's descendant ids (for cycle-safe parent selection). */
function collectDescendantIds(
  categories: Category[],
  rootId: string,
): Set<string> {
  const childrenOf = (parentIdValue: string) =>
    categories.filter((category) => category.parentId === parentIdValue);
  const result = new Set<string>();
  const stack = [...childrenOf(rootId)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (result.has(current.id)) continue;
    result.add(current.id);
    stack.push(...childrenOf(current.id));
  }
  return result;
}

interface EditorState {
  id: string | null;
  name: string;
  slug: string;
  parentId: string | null;
  visible: boolean;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  name: "",
  slug: "",
  parentId: null,
  visible: true,
};

export default function CategoriesApp() {
  const {t} = useTranslation();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: DropPosition;
  } | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const activePointerIdRef = useRef<number | null>(null);
  const dragChangedRef = useRef(false);
  const categoriesRef = useRef<Category[]>([]);
  const savedCategoriesRef = useRef<Category[]>([]);
  const savingOrderRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await responseJson(
        await fetch(ADMIN_URLS.ajaxCategories(), {
          cache: "no-store",
          headers: {accept: "application/json"},
        }),
      )) as CategoriesResponse;
      setCategories(data.items);
      categoriesRef.current = data.items;
      savedCategoriesRef.current = data.items;
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("categories.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = useCallback(() => {
    setEditor({...EMPTY_EDITOR});
  }, []);

  const openEdit = useCallback((category: Category) => {
    setEditor({
      id: category.id,
      name: category.name,
      slug: category.slug,
      parentId: category.parentId,
      visible: category.visible,
    });
  }, []);

  const closeEditor = useCallback(() => setEditor(null), []);

  const persistEditor = useCallback(async () => {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) {
      showToast(t("categories.saveFailed"), "error");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name,
        slug: editor.slug.trim() || undefined,
        parentId: editor.parentId,
        visible: editor.visible,
      };
      if (editor.id) {
        await responseJson(await fetch(ADMIN_URLS.ajaxCategory(editor.id), {
          body: JSON.stringify(payload),
          headers: {"content-type": "application/json"},
          method: "PUT",
        }));
        showToast(t("categories.saved"), "success");
      } else {
        await responseJson(await fetch(ADMIN_URLS.ajaxCategories(), {
          body: JSON.stringify(payload),
          headers: {"content-type": "application/json"},
          method: "POST",
        }));
        showToast(t("categories.created"), "success");
      }
      setEditor(null);
      await load();
    } catch (saveError) {
      showToast(
        saveError instanceof Error
          ? saveError.message
          : t("categories.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }, [editor, load, t]);

  const toggleVisible = useCallback(
    async (category: Category, visible: boolean) => {
      const previous = categoriesRef.current;
      setCategories((current) =>
        current.map((c) => (c.id === category.id ? {...c, visible} : c)),
      );
      try {
        await responseJson(await fetch(ADMIN_URLS.ajaxCategory(category.id), {
          body: JSON.stringify({visible}),
          headers: {"content-type": "application/json"},
          method: "PUT",
        }));
        showToast(t("categories.saved"), "success");
      } catch (toggleError) {
        setCategories(previous);
        showToast(
          toggleError instanceof Error
            ? toggleError.message
            : t("categories.saveFailed"),
          "error",
        );
      }
    },
    [t],
  );

  const removeCategory = useCallback(
    async (category: Category) => {
      if (!window.confirm(t("categories.deleteConfirm", {name: category.name}))) {
        return;
      }
      try {
        await responseJson(await fetch(ADMIN_URLS.ajaxCategory(category.id), {
          method: "DELETE",
        }));
        showToast(t("categories.deleted"), "success");
        await load();
      } catch (deleteError) {
        showToast(
          deleteError instanceof Error
            ? deleteError.message
            : t("categories.deleteFailed"),
          "error",
        );
      }
    },
    [load, t],
  );

  const persistOrder = useCallback(
    async (ordered: Category[]) => {
      if (savingOrderRef.current) return;
      savingOrderRef.current = true;
      setSavingOrder(true);
      try {
        await responseJson(await fetch(ADMIN_URLS.ajaxCategoryOrder(), {
          body: JSON.stringify({ids: ordered.map(({id}) => id)}),
          headers: {"content-type": "application/json"},
          method: "POST",
        }));
        savedCategoriesRef.current = ordered;
        showToast(t("categories.orderSaved"), "success");
      } catch (orderError) {
        setCategories(savedCategoriesRef.current);
        showToast(
          orderError instanceof Error
            ? orderError.message
            : t("categories.saveFailed"),
          "error",
        );
      } finally {
        savingOrderRef.current = false;
        setSavingOrder(false);
      }
    },
    [t],
  );

  const finishDragging = useCallback(() => {
    activePointerIdRef.current = null;
    const changed = dragChangedRef.current;
    dragChangedRef.current = false;
    setDraggedId(null);
    setDropTarget(null);
    if (changed) void persistOrder(categoriesRef.current);
  }, [persistOrder]);

  useEffect(() => {
    if (!draggedId) return;
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) return;
      event.preventDefault();
      const targetRow = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-category-id]");
      const targetId = targetRow?.dataset.categoryId;
      if (!targetRow || !targetId || targetId === draggedId) {
        setDropTarget(null);
        return;
      }
      const bounds = targetRow.getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2
        ? "before"
        : "after";
      setDropTarget({id: targetId, position});
      setCategories((current) => {
        const reordered = reorderCategoriesList(
          current,
          draggedId,
          targetId,
          position,
        );
        if (reordered !== current) {
          dragChangedRef.current = true;
          categoriesRef.current = reordered;
        }
        return reordered;
      });
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerId === activePointerIdRef.current) finishDragging();
    };
    window.addEventListener("blur", finishDragging);
    window.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("pointermove", handlePointerMove, {passive: false});
    window.addEventListener("pointerup", handlePointerEnd);
    return () => {
      window.removeEventListener("blur", finishDragging);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
    };
  }, [draggedId, finishDragging]);

  const beginDragging = (
    categoryId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0 || savingOrderRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    dragChangedRef.current = false;
    setDraggedId(categoryId);
  };

  const moveWithKeyboard = (categoryId: string, direction: -1 | 1) => {
    if (savingOrderRef.current) return;
    const current = categoriesRef.current;
    const currentIndex = current.findIndex(({id}) => id === categoryId);
    const target = current[currentIndex + direction];
    if (currentIndex < 0 || !target) return;
    const reordered = reorderCategoriesList(
      current,
      categoryId,
      target.id,
      direction < 0 ? "before" : "after",
    );
    if (reordered === current) return;
    setCategories(reordered);
    categoriesRef.current = reordered;
    void persistOrder(reordered);
  };

  if (loading && categories.length === 0) {
    return <AdminCollectionLoading label={t("categories.title")} />;
  }

  if (error && categories.length === 0) {
    return (
      <AdminCollectionError
        message={error}
        retry={load}
      />
    );
  }

  const parentOptions: AdminSelectOption[] = [
    {value: "", label: t("categories.noParent")},
    ...categories
      .filter(({id}) => {
        if (!editor) return true;
        if (id === editor.id) return false;
        if (editor.id) {
          const descendants = collectDescendantIds(categories, editor.id);
          if (descendants.has(id)) return false;
        }
        return true;
      })
      .map(({id, name}) => ({value: id, label: name})),
  ];
  const selectedParent = editor
    ? parentOptions.find(({value}) => value === (editor.parentId ?? "")) ?? null
    : null;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("categories.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("categories.intro")}
          </p>
        </div>
        <Button type="button" onClick={openCreate}>
          <PlusIcon aria-hidden="true" /> {t("categories.addCategory")}
        </Button>
      </div>

      <div
        aria-busy={loading || savingOrder}
        className={cn("transition-opacity", (loading || savingOrder) && "opacity-60")}
      >
        {error && (
          <div className="mb-4">
            <AdminCollectionError message={error} retry={load} />
          </div>
        )}

        {categories.length === 0 ? (
          <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
            <h2 className="font-semibold">{t("categories.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("categories.listEmpty")}
            </p>
          </section>
        ) : (
          <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
            <div className="border-b p-5">
              <h2 className="font-semibold">{t("categories.title")}</h2>
              <p aria-live="polite" className="mt-1 text-sm text-muted-foreground">
                {t("categories.dragToReorder")}
              </p>
            </div>
            {categories.map((category, index) => (
              <div
                key={category.id}
                data-category-id={category.id}
                className={cn(
                  "relative flex items-center gap-3 border-b px-3 py-3 transition last:border-b-0",
                  draggedId === category.id && "bg-muted/40 opacity-60",
                  dropTarget?.id === category.id &&
                    "z-10 bg-brand-light/8 ring-1 ring-inset ring-brand-light/40",
                  dropTarget?.id === category.id && dropTarget.position === "before" &&
                    "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:rounded-full before:bg-brand-light",
                  dropTarget?.id === category.id && dropTarget.position === "after" &&
                    "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-light",
                )}
              >
                <Button
                  aria-label={t("categories.dragToReorder")}
                  aria-roledescription="sortable item"
                  className="shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
                  disabled={savingOrder}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp" && index > 0) {
                      event.preventDefault();
                      moveWithKeyboard(category.id, -1);
                    } else if (
                      event.key === "ArrowDown" &&
                      index < categories.length - 1
                    ) {
                      event.preventDefault();
                      moveWithKeyboard(category.id, 1);
                    }
                  }}
                  onPointerDown={(event) => beginDragging(category.id, event)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <GripVerticalIcon aria-hidden="true" className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-semibold">{category.name}</h3>
                    {!category.visible && (
                      <span className="rounded-full border px-2 py-0.5 text-xs">
                        {t("categories.visibleOff")}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    /{category.slug}/
                  </p>
                </div>
                <AdminSwitch
                  checked={category.visible}
                  disabled={savingOrder}
                  label={category.visible
                    ? t("categories.visibleOn")
                    : t("categories.visibleOff")}
                  onCheckedChange={(checked) => void toggleVisible(category, checked)}
                />
                <Button
                  aria-label={t("categories.editCategory")}
                  className="shrink-0"
                  onClick={() => openEdit(category)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <PencilIcon aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  aria-label={t("categories.delete")}
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => void removeCategory(category)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2Icon aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ))}
          </section>
        )}
      </div>

      <AdminDialog
        open={editor !== null}
        onOpenChange={(open: boolean) => {
          if (!open) closeEditor();
        }}
        title={editor?.id ? t("categories.editCategory") : t("categories.newCategory")}
      >
        {editor && (
          <div className="grid gap-4 pt-2">
            <AdminInput
              label={t("categories.name")}
              onChange={(event: any) =>
                setEditor((prev) => prev && {...prev, name: event.target.value})}
              placeholder={t("categories.name")}
              value={editor.name}
            />
            <AdminInput
              label={t("categories.slug")}
              onChange={(event: any) =>
                setEditor((prev) => prev && {...prev, slug: event.target.value})}
              placeholder={t("categories.slug")}
              value={editor.slug}
            />
            <AdminSelect
              label={t("categories.parent")}
              options={parentOptions}
              value={selectedParent}
              onChange={(option: AdminSelectOption) =>
                setEditor((prev) =>
                  prev && {...prev, parentId: option.value || null})}
            />
            <AdminSwitch
              checked={editor.visible}
              label={editor.visible
                ? t("categories.visibleOn")
                : t("categories.visibleOff")}
              onCheckedChange={(checked) =>
                setEditor((prev) => prev && {...prev, visible: checked})}
            />
            <p className="text-xs text-muted-foreground">
              {t("categories.tagsHint")}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                disabled={saving}
                onClick={closeEditor}
                type="button"
                variant="ghost"
              >
                {t("common.cancel")}
              </Button>
              <Button
                disabled={saving || !editor.name.trim()}
                onClick={() => void persistEditor()}
                type="button"
              >
                {t("categories.save")}
              </Button>
            </div>
          </div>
        )}
      </AdminDialog>
    </div>
  );
}
