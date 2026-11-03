import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import {ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSelect from "@/components/admin/shared/AdminSelect";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import {AdminGroupTree} from "@/components/admin/shared/AdminGroupTree";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {
  bookInfoGroupSchema,
  bookInfoStatusSchema,
  type BookInfoAdmin,
  type BookInfoBoard,
  type BookInfoGroup,
  type BookInfoStatus,
} from "@/shared/BookInfo";

/**
 * 书本信息表单状态。`chapter`/`orgId` 以字符串承载（数字输入框可自由编辑），
 * `caseTag`/`bookNo` 迁移 0173 起是文本列，直接用字符串；`hotBook` 是状态下拉的
 * 取值（十进制字符串，提交时转 number）。`parentGroup` 只服务「分组→书」两层选
 * 父级的第一层（提交不带它），`parentId` 是第二层选出的书 id。
 */
interface BookInfoFormState {
  bookName: string;
  chapter: string;
  author: string;
  chengShu: string;
  caseDivision: string;
  caseTag: string;
  bookNo: string;
  imageUrl: string;
  hotBook: string;
  parentGroup: string;
  parentId: string;
  orgId: string;
  isEnable: boolean;
  comment: string;
}

const EMPTY_FORM: BookInfoFormState = {
  bookName: "",
  chapter: "",
  author: "",
  chengShu: "",
  caseDivision: "",
  caseTag: "",
  bookNo: "",
  imageUrl: "",
  hotBook: "",
  parentGroup: "",
  parentId: "",
  orgId: "",
  isEnable: true,
  comment: "",
};

function formFromBook(
  book: BookInfoAdmin,
  resolveGroupOfDivision: (division: string) => string,
  divisionOfBook: (id: string) => string | undefined,
): BookInfoFormState {
  // 父级第一层默认落到父级书所在的分组（父级书不在则落到编辑中书自己的分组）。
  const parentDivision = book.parentId
    ? divisionOfBook(book.parentId) ?? book.caseDivision
    : book.caseDivision;
  return {
    bookName: book.bookName,
    chapter: book.chapter == null ? "" : String(book.chapter),
    author: book.author,
    chengShu: book.chengShu,
    caseDivision: book.caseDivision,
    caseTag: book.caseTag,
    bookNo: book.bookNo,
    imageUrl: book.imageUrl,
    hotBook: String(book.hotBook),
    parentGroup: resolveGroupOfDivision(parentDivision),
    parentId: book.parentId ?? "",
    orgId: book.orgId == null ? "" : String(book.orgId),
    isEnable: book.isEnable,
    comment: book.comment,
  };
}

function formToPayload(form: BookInfoFormState): Record<string, unknown> {
  return {
    bookName: form.bookName.trim(),
    chapter: form.chapter.trim() === "" ? null : Number(form.chapter),
    author: form.author.trim() || null,
    chengShu: form.chengShu.trim() || null,
    caseDivision: form.caseDivision.trim(),
    caseTag: form.caseTag.trim(),
    bookNo: form.bookNo.trim(),
    imageUrl: form.imageUrl.trim() || null,
    hotBook: Number(form.hotBook),
    parentId: form.parentId.trim() || null,
    orgId: form.orgId.trim() === "" ? null : Number(form.orgId),
    isEnable: form.isEnable,
    comment: form.comment.trim() || null,
  };
}

/** 客户端兜底：必填文本非空、状态下拉已选。真正的校验以服务端 Zod 为准。 */
function validateForm(form: BookInfoFormState): boolean {
  if (!form.bookName.trim()) return false;
  if (!form.caseDivision.trim()) return false;
  if (!form.bookNo.trim()) return false;
  if (form.hotBook.trim() === "" || Number.isNaN(Number(form.hotBook))) {
    return false;
  }
  return true;
}

/** 共享表单：新建时置顶渲染，编辑时在行内展开。 */
function BookInfoForm({
  form,
  setForm,
  saving,
  groups,
  statuses,
  liveBooks,
  selfId,
  onSave,
  onCancel,
  title,
}: {
  form: BookInfoFormState;
  setForm: Dispatch<SetStateAction<BookInfoFormState>>;
  saving: boolean;
  /** 分组清单（settings）——书籍分类是分组键下拉，不是自由文本。 */
  groups: BookInfoGroup[];
  /** 状态清单（settings）——状态下拉的默认数据源。 */
  statuses: BookInfoStatus[];
  /** 存活书（排除已软删）——选父级第二层的候选池。 */
  liveBooks: BookInfoAdmin[];
  /** 当前编辑的书 id——选父级时排除自身（防自引用）。新建时为 null。 */
  selfId: string | null;
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const {t} = useTranslation();
  const set = (key: keyof BookInfoFormState, value: string | boolean) =>
    setForm((current) => ({...current, [key]: value}));
  // 宽松：游离值（分组被删未改派的历史数据）仍显示为当前值，逼着操作者显式改派。
  const divisionOptions = useMemo(() => {
    const base = groups.map((group) => ({label: group.label, value: group.key}));
    const current = form.caseDivision.trim();
    if (current && !base.some((option) => option.value === current)) {
      return [...base, {label: current, value: current}];
    }
    return base;
  }, [groups, form.caseDivision]);
  const selectedDivision = divisionOptions.find(
    (option) => option.value === form.caseDivision,
  ) ?? null;
  // 状态下拉（迁移 0173/0174）：宽松同上，游离状态值仍显示当前 label，逼着显式改选。
  const statusOptions = useMemo(() => {
    const base = [...statuses]
      .sort((a, b) => a.sort - b.sort || a.value - b.value)
      .map((status) => ({label: status.label, value: String(status.value)}));
    const current = form.hotBook.trim();
    if (current !== "" && !base.some((option) => option.value === current)) {
      return [...base, {label: current, value: current}];
    }
    return base;
  }, [statuses, form.hotBook]);
  const selectedStatus = statusOptions.find(
    (option) => option.value === form.hotBook,
  ) ?? null;

  // 父级 = 「分组 → 书」两层选。第一层选分组，第二层从该组存活书里选一本书作
  // 父级，候选排除自身（自引用由 handler/触发器再拦一道）。
  const parentGroupOptions = useMemo(
    () => groups.map((group) => ({label: group.label, value: group.key})),
    [groups],
  );
  const selectedParentGroup = parentGroupOptions.find(
    (option) => option.value === form.parentGroup,
  ) ?? null;
  const parentOptions = useMemo(() => {
    const inGroup = liveBooks.filter(
      (book) => book.caseDivision === form.parentGroup);
    return inGroup
      .filter((book) => book.id !== selfId)
      .map((book) => ({
        label: book.bookName || t("bookInfo.untitled"),
        value: book.id,
      }));
  }, [liveBooks, form.parentGroup, selfId, t]);
  const selectedParent = parentOptions.find(
    (option) => option.value === form.parentId,
  ) ?? null;
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h3 className="font-medium">{title}</h3>
      <AdminInput
        label={t("bookInfo.nameLabel")}
        onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          set("bookName", event.target.value)}
        value={form.bookName}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {/* 书本编号 / 内容标签：迁移 0173 起为文本列，去 number 输入。 */}
        <AdminInput
          label={t("bookInfo.bookNoLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("bookNo", event.target.value)}
          value={form.bookNo}
        />
        <AdminInput
          label={t("bookInfo.chapterLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("chapter", event.target.value)}
          type="number"
          value={form.chapter}
        />
        <AdminInput
          label={t("bookInfo.caseTagLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("caseTag", event.target.value)}
          value={form.caseTag}
        />
        {/* 状态（迁移 0173/0174）：下拉，取值存 `hot_book`（NOT NULL）。 */}
        <AdminSelect
          ariaLabel={t("bookInfo.hotBookLabel")}
          label={t("bookInfo.hotBookLabel")}
          onChange={(option) => set("hotBook", option.value)}
          options={statusOptions}
          value={selectedStatus}
        />
      </div>
      <AdminInput
        label={t("bookInfo.authorLabel")}
        onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          set("author", event.target.value)}
        value={form.author}
      />
      <AdminInput
        label={t("bookInfo.chengShuLabel")}
        onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          set("chengShu", event.target.value)}
        value={form.chengShu}
      />
      {/* 书籍分类 = 分组键（ADR-0059）：改成哪个组，这本书就归到左栏哪个分组。 */}
      <AdminSelect
        ariaLabel={t("bookInfo.caseDivisionLabel")}
        label={t("bookInfo.caseDivisionLabel")}
        onChange={(option) => set("caseDivision", option.value)}
        options={divisionOptions}
        value={selectedDivision}
      />
      <AdminInput
        label={t("bookInfo.imageUrlLabel")}
        onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          set("imageUrl", event.target.value)}
        value={form.imageUrl}
      />
      {/* 父级 = 「分组 → 书」两层（需求 4）：先选父级所在分组，再从该组选书。
          换分组即清空已选父级书（旧父级不在新组），避免留下跨组悬空引用。 */}
      <div className="grid gap-4 sm:grid-cols-2">
        <AdminSelect
          ariaLabel={t("bookInfo.parentGroupLabel")}
          label={t("bookInfo.parentGroupLabel")}
          onChange={(option) =>
            setForm((current) => ({
              ...current,
              parentGroup: option.value,
              parentId: "",
            }))}
          options={parentGroupOptions}
          value={selectedParentGroup}
        />
        <AdminSelect
          ariaLabel={t("bookInfo.parentIdLabel")}
          label={t("bookInfo.parentIdLabel")}
          disabled={parentOptions.length === 0}
          emptyText={t("bookInfo.parentEmpty")}
          onChange={(option) => set("parentId", option.value)}
          options={parentOptions}
          placeholder={t("bookInfo.parentIdHint")}
          value={selectedParent}
        />
      </div>
      <AdminInput
        label={t("bookInfo.orgIdLabel")}
        onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          set("orgId", event.target.value)}
        placeholder={t("bookInfo.orgIdHint")}
        value={form.orgId}
      />
      <AdminSwitch
        checked={form.isEnable}
        label={t("bookInfo.isEnableLabel")}
        onCheckedChange={(checked) => set("isEnable", checked)}
      />
      <AdminInput
        label={t("bookInfo.commentLabel")}
        onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          set("comment", event.target.value)}
        value={form.comment}
      />
      <div className="flex gap-2">
        <Button disabled={saving} onClick={onSave} type="button">
          {t("bookInfo.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("bookInfo.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 独立书本信息 CRUD 看板（ADR-0058）+ 分组树（ADR-0059）。
 *
 * 与 `BooksApp`（channels 行）是两个并行模块：这里只读写 `book_info` 表，
 * 不碰作品频道/章节。删除分两步——软删写 `deleted_at`（行保留），已软删的
 * 行只能物理删除（本模块暂未提供恢复）。
 *
 * 布局是左右双栏：左栏 `AdminGroupTree` 按 `settings.book_groups` 分组导航，
 * 右栏是被选中那本书的编辑表单。分组清单独立管理（ADR-0059 决策 3），
 * 书的归属 = 自身 `case_division`（= 分组 `key`）。
 */
export default function BookInfoApp() {
  const {t} = useTranslation();
  const [board, setBoard] = useState<BookInfoBoard>({groups: [], statuses: [], books: []});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<BookInfoAdmin | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState<BookInfoAdmin | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [form, setForm] = useState<BookInfoFormState>(EMPTY_FORM);

  // 「分组管理」弹层：分组清单的草稿副本，点保存才整表覆盖写 settings。
  const [groupOpen, setGroupOpen] = useState(false);
  const [draftGroups, setDraftGroups] = useState<BookInfoGroup[]>([]);
  const [newGroup, setNewGroup] = useState<{key: string; label: string}>({key: "", label: ""});
  // 待删分组 → 该组书要改派到的目标组 key（删组前先改派，ADR-0059 决策 5）。
  const [pendingReassign, setPendingReassign] = useState<Record<string, string>>({});
  const [groupError, setGroupError] = useState<string | null>(null);

  // 「状态管理」弹层（迁移 0173/0174）：状态清单的草稿副本，点保存才整表覆盖写 settings。
  const [statusOpen, setStatusOpen] = useState(false);
  const [draftStatuses, setDraftStatuses] = useState<BookInfoStatus[]>([]);
  const [newStatus, setNewStatus] = useState<{value: string; label: string}>({value: "", label: ""});
  const [statusError, setStatusError] = useState<string | null>(null);

  const groups = board.groups;
  const statuses = board.statuses;
  const books = board.books;
  const liveBooks = books.filter((book) => !book.isDeleted);
  const deletedBooks = books.filter((book) => book.isDeleted);

  /** 分组 key 集合；用于把书按 `case_division` 归到对应分组。 */
  const groupKeys = useMemo(
    () => new Set(groups.map((group) => group.key)),
    [groups],
  );
  const booksOf = useCallback(
    (key: string) => liveBooks.filter((book) => book.caseDivision === key),
    [liveBooks],
  );
  const groupLabel = useCallback(
    (key: string) =>
      groups.find((group) => group.key === key)?.label ?? key,
    [groups],
  );

  /** 从失败的 book-info ajax 响应里取出本地化消息。服务端
   *  错误是 i18n key（如 errors.bookInfo.invalidInput），这里翻译后给 toast。 */
  const parseError = async (response: Response, fallback: string): Promise<string> => {
    try {
      const data = (await response.json()) as {error?: string};
      return data.error ? t(data.error) : fallback;
    } catch {
      return fallback;
    }
  };

  /** 左栏树：分组清单（settings，按 sort）。顶层节点「书籍分类」由 AdminGroupTree 的 root 承载。 */
  const treeGroups = useMemo(
    () => groups.map((group) => ({
      count: booksOf(group.key).length,
      key: group.key,
      label: group.label,
      leaves: booksOf(group.key).map((book) => ({
        description: `${book.bookNo} · ${book.author || "—"}`,
        id: book.id,
        label: book.bookName || t("bookInfo.untitled"),
      })),
    })),
    [groups, booksOf, t],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookInfo());
      const data = await response.json().catch(() => ({})) as BookInfoBoard &
        Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("bookInfo.loadFailed")));
      setBoard({
        groups: Array.isArray(data.groups) ? data.groups : [],
        statuses: Array.isArray(data.statuses) ? data.statuses : [],
        books: Array.isArray(data.books) ? data.books : [],
      });
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("bookInfo.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 书 id → 所在书籍分类（选父级第一层默认值用；已软删书不在候选，故查全量 books）。 */
  const divisionById = useCallback(
    (id: string) => books.find((book) => book.id === id)?.caseDivision,
    [books],
  );
  /** 书籍分类 → 分组 key（必填；不在清单的历史游离值按原值回落显示）。 */
  const resolveGroupOfDivision = useCallback(
    (division: string) => (groupKeys.has(division) ? division : ""),
    [groupKeys],
  );

  // 点分组头：手风琴单展开，展开即选中该组第一本书（镜像 UsersApp 语义）。
  const toggleGroup = (key: string) => {
    const next = expandedKey === key ? null : key;
    setExpandedKey(next);
    if (next) {
      const first = booksOf(next)[0];
      setSelectedId(first?.id ?? null);
      setCreating(false);
      setForm(
        first
          ? formFromBook(first, resolveGroupOfDivision, divisionById)
          : {...EMPTY_FORM, parentGroup: resolveGroupOfDivision(key)},
      );
    }
  };

  const selectLeaf = (id: string) => {
    const book = liveBooks.find((entry) => entry.id === id);
    if (!book) return;
    setCreating(false);
    setSelectedId(book.id);
    setForm(formFromBook(book, resolveGroupOfDivision, divisionById));
  };

  const startCreate = () => {
    setCreating(true);
    setSelectedId(null);
    // 新建默认归到当前展开的分组；没有展开组则留空由操作者选。状态下拉默认取
    // 清单里 sort 最小的状态（hot_book NOT NULL，须有值）；父级第一层随当前分组。
    const defaultStatus = [...statuses]
      .sort((a, b) => a.sort - b.sort || a.value - b.value)[0];
    setForm({
      ...EMPTY_FORM,
      caseDivision: expandedKey ?? "",
      hotBook: defaultStatus == null ? "" : String(defaultStatus.value),
      parentGroup: expandedKey
        ? resolveGroupOfDivision(expandedKey)
        : "",
    });
  };

  const cancel = () => {
    setCreating(false);
    setSelectedId(null);
    setForm(EMPTY_FORM);
  };

  const save = async () => {
    if (!validateForm(form)) {
      showToast(t("errors.bookInfo.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = selectedId
        ? await fetch(ADMIN_URLS.ajaxBookInfoItem(selectedId), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxBookInfo(), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("bookInfo.saveFailed")));
      showToast(t("saveAction.saved"), "success");
      setCreating(false);
      await load();
    } catch (saveError) {
      // 服务端错误是 i18n key（如 errors.bookInfo.invalidInput），直接翻译。
      showToast(
        saveError instanceof Error
          ? t(saveError.message)
          : t("bookInfo.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (book: BookInfoAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookInfoItem(book.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("bookInfo.deleteFailed")));
      showToast(t("saveAction.saved"), "success");
      setConfirming(null);
      if (selectedId === book.id) setSelectedId(null);
      await load();
    } catch (deleteError) {
      showToast(
        deleteError instanceof Error
          ? t(deleteError.message)
          : t("bookInfo.deleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const purge = async (book: BookInfoAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookInfoPurge(book.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("bookInfo.purgeFailed")));
      showToast(t("bookInfo.purgeDone"), "success");
      setConfirmingPurge(null);
      setShowDeleted(false);
      if (selectedId === book.id) setSelectedId(null);
      await load();
    } catch (purgeError) {
      showToast(
        purgeError instanceof Error
          ? t(purgeError.message)
          : t("bookInfo.purgeFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  // ---- 分组维护（settings.book_groups） ----

  const openGroupManager = () => {
    setDraftGroups(groups.map((group) => ({...group})));
    setNewGroup({key: "", label: ""});
    setPendingReassign({});
    setGroupError(null);
    setGroupOpen(true);
  };

  const updateDraftLabel = (index: number, label: string) => {
    setDraftGroups((previous) =>
      previous.map((group, at) => (at === index ? {...group, label} : group)));
  };

  /** 上移/下移：只换草稿顺序，`sort` 在保存时按新序重排。 */
  const moveDraft = (index: number, delta: -1 | 1) => {
    setDraftGroups((previous) => {
      const next = [...previous];
      const target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      const moving = next[index];
      const swapped = next[target];
      if (moving === undefined || swapped === undefined) return previous;
      next[index] = swapped;
      next[target] = moving;
      return next;
    });
  };

  /**
   * 标记删一个分组。组里有书则必须先选「改派到」目标组；末组禁删（fail-closed，
   * `case_division` NOT NULL 无处改派）。再点一次同一组 = 撤销删除。
   */
  const toggleRemoveDraft = (key: string) => {
    setGroupError(null);
    setPendingReassign((previous) => {
      if (previous[key] !== undefined) {
        const {[key]: _dropped, ...rest} = previous;
        return rest;
      }
      if (draftGroups.length <= 1) {
        setGroupError("errors.bookInfo.lastGroup");
        return previous;
      }
      return {...previous, [key]: ""};
    });
  };

  /** 新增一行草稿：先本地校验（key 形状 + 重复），通过才并入。 */
  const addDraft = () => {
    const key = newGroup.key.trim();
    const label = newGroup.label.trim();
    if (!bookInfoGroupSchema.shape.key.safeParse(key).success) {
      setGroupError("bookInfo.groupKeyInvalid");
      return;
    }
    if (!bookInfoGroupSchema.shape.label.safeParse(label).success) {
      setGroupError("bookInfo.groupLabelInvalid");
      return;
    }
    if (draftGroups.some((group) => group.key === key)) {
      setGroupError("bookInfo.groupKeyDuplicated");
      return;
    }
    setDraftGroups((previous) => [...previous, {key, label, sort: previous.length}]);
    setNewGroup({key: "", label: ""});
    setGroupError(null);
  };

  /**
   * 保存：先把待删组的书改派到目标组，再整表覆盖写 settings。两步任一失败都
   * 中止并提示，左栏等下次 `load()` 用服务端返回的清单刷新。
   */
  const saveGroups = async () => {
    const remaining = draftGroups.filter((group) => pendingReassign[group.key] === undefined);
    if (remaining.length === 0) {
      setGroupError("errors.bookInfo.lastGroup");
      return;
    }
    for (const group of draftGroups) {
      const to = pendingReassign[group.key];
      if (to === undefined) continue;
      if (!to) {
        setGroupError("bookInfo.groupReassignRequired");
        return;
      }
      if (to === group.key) {
        setGroupError("bookInfo.groupReassignRequired");
        return;
      }
      // 目标组必须在本批保存后仍存活：改派到一个同批被删的组，书会落到不在清单
      // 的 case_division，悬空无处归属，违背「改派到存活组」。
      if (!remaining.some((survivor) => survivor.key === to)) {
        setGroupError("bookInfo.groupReassignRequired");
        return;
      }
    }
    if (remaining.some((group) => !group.label.trim())) {
      setGroupError("bookInfo.groupLabelInvalid");
      return;
    }
    setSaving(true);
    try {
      for (const group of draftGroups) {
        const to = pendingReassign[group.key];
        if (to === undefined || !to) continue;
        const reassignResponse = await fetch(ADMIN_URLS.ajaxBookInfoReassign(), {
          body: JSON.stringify({from: group.key, to}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        if (!reassignResponse.ok) {
          showToast(
            await parseError(reassignResponse, t("bookInfo.groupSaveFailed")),
            "error",
          );
          return;
        }
      }
      const payload = remaining.map((group, index) => ({
        key: group.key,
        label: group.label.trim(),
        sort: index,
      }));
      const response = await fetch(ADMIN_URLS.ajaxBookInfoGroups(), {
        body: JSON.stringify({groups: payload}),
        headers: {"content-type": "application/json"},
        method: "PUT",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("bookInfo.groupSaveFailed")), "error");
        return;
      }
      setGroupOpen(false);
      setGroupError(null);
      showToast(t("bookInfo.groupSaved"), "success");
      await load();
    } catch {
      showToast(t("bookInfo.groupSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  // ---- 状态维护（settings.book_info_statuses，迁移 0173/0174） ----

  const openStatusManager = () => {
    setDraftStatuses(statuses.map((status) => ({...status})));
    setNewStatus({value: "", label: ""});
    setStatusError(null);
    setStatusOpen(true);
  };

  const updateDraftStatusLabel = (index: number, label: string) => {
    setDraftStatuses((previous) =>
      previous.map((status, at) => (at === index ? {...status, label} : status)));
  };

  /** 上移/下移：只换草稿顺序，`sort` 在保存时按新序重排。 */
  const moveDraftStatus = (index: number, delta: -1 | 1) => {
    setDraftStatuses((previous) => {
      const next = [...previous];
      const target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      const moving = next[index];
      const swapped = next[target];
      if (moving === undefined || swapped === undefined) return previous;
      next[index] = swapped;
      next[target] = moving;
      return next;
    });
  };

  /**
   * 标记删一个状态。末状态禁删（fail-closed，`hot_book` NOT NULL 无值可写）。
   * 再点一次同一状态 = 撤销删除。
   */
  const toggleRemoveDraftStatus = (value: number) => {
    setStatusError(null);
    setDraftStatuses((previous) => {
      if (previous.length <= 1) {
        setStatusError("errors.bookInfo.lastStatus");
        return previous;
      }
      return previous.filter((status) => status.value !== value);
    });
  };

  /** 新增一行草稿：先本地校验（value 形状 + 重复 + label），通过才并入。 */
  const addDraftStatus = () => {
    const rawValue = newStatus.value.trim();
    const label = newStatus.label.trim();
    const parsedValue = rawValue === "" ? Number.NaN : Number(rawValue);
    const valueShape = bookInfoStatusSchema.shape.value.safeParse(parsedValue);
    if (!valueShape.success) {
      setStatusError("bookInfo.statusValueInvalid");
      return;
    }
    if (!bookInfoStatusSchema.shape.label.safeParse(label).success) {
      setStatusError("bookInfo.statusLabelInvalid");
      return;
    }
    const value = valueShape.data;
    if (draftStatuses.some((status) => status.value === value)) {
      setStatusError("bookInfo.statusValueDuplicated");
      return;
    }
    setDraftStatuses((previous) => [...previous, {value, label, sort: previous.length}]);
    setNewStatus({value: "", label: ""});
    setStatusError(null);
  };

  /**
   * 保存：整表覆盖写 settings。清单清空 = 删光状态 → 400（`hot_book` NOT NULL，
   * 无值可写），客户端先拦一道；其余失败都中止并提示，状态清单等下次 `load()` 刷新。
   */
  const saveStatuses = async () => {
    if (draftStatuses.length === 0) {
      setStatusError("errors.bookInfo.lastStatus");
      return;
    }
    if (draftStatuses.some((status) => !status.label.trim())) {
      setStatusError("bookInfo.statusLabelInvalid");
      return;
    }
    setSaving(true);
    try {
      const payload = draftStatuses.map((status, index) => ({
        value: status.value,
        label: status.label.trim(),
        sort: index,
      }));
      const response = await fetch(ADMIN_URLS.ajaxBookInfoStatuses(), {
        body: JSON.stringify({statuses: payload}),
        headers: {"content-type": "application/json"},
        method: "PUT",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("bookInfo.statusSaveFailed")), "error");
        return;
      }
      setStatusOpen(false);
      setStatusError(null);
      showToast(t("bookInfo.statusSaved"), "success");
      await load();
    } catch {
      showToast(t("bookInfo.statusSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <AdminCollectionLoading label={t("bookInfo.title")} />;
  }
  if (error) {
    return (
      <AdminCollectionError
        message={error}
        retry={() => void load()}
      />
    );
  }

  const selectedBook = selectedId
    ? liveBooks.find((book) => book.id === selectedId) ?? null
    : null;
  const expandedGroupBooks = expandedKey ? booksOf(expandedKey) : [];

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* 左栏：分组树 + 分组/状态管理入口。分组、计数与成员过滤都在本组件算好传入，
          AdminGroupTree 只渲染传入状态（约定不可改）。需求 1：宽屏冻结在视口顶，
          树长时栏内自行滚动，不随右栏内容往上滚。 */}
      <nav className="w-full shrink-0 self-start rounded-[14px] border bg-card p-2 shadow-xs lg:sticky lg:top-4 lg:max-h-[calc(100svh-6rem)] lg:w-72 lg:overflow-y-auto">
        <div className="flex items-center justify-end gap-2 px-1 pb-2">
          <Button
            disabled={saving}
            onClick={openStatusManager}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon aria-hidden="true" />
            {t("bookInfo.statusManage")}
          </Button>
          <Button
            disabled={saving}
            onClick={openGroupManager}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon aria-hidden="true" />
            {t("bookInfo.groupManage")}
          </Button>
        </div>
        <AdminGroupTree
          emptyLeafText={t("bookInfo.groupEmpty")}
          expandedKeys={expandedKey ? [expandedKey] : []}
          groups={treeGroups}
          onSelectLeaf={selectLeaf}
          onToggleGroup={toggleGroup}
          root={{label: t("bookInfo.treeRoot"), count: liveBooks.length}}
          selectedLeafId={selectedId}
        />
      </nav>

      {/* 右栏：被选中分组的书列表 + 编辑表单。 */}
      <section className="min-w-0 flex-1 space-y-4 rounded-[14px] border bg-card p-5 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">
            {expandedKey ? groupLabel(expandedKey) : t("bookInfo.title")}
          </h2>
          {expandedKey && !creating && (
            <Button onClick={startCreate} type="button" variant="outline">
              {t("bookInfo.newBookInfo")}
            </Button>
          )}
        </div>

        {!expandedKey && (
          <p className="text-sm text-muted-foreground">{t("bookInfo.intro")}</p>
        )}
        {expandedKey && expandedGroupBooks.length === 0 && !creating && (
          <p className="text-sm text-muted-foreground">{t("bookInfo.empty")}</p>
        )}

        {creating && (
          <BookInfoForm
            form={form}
            groups={groups}
            liveBooks={liveBooks}
            selfId={null}
            statuses={statuses}
            onCancel={cancel}
            onSave={() => void save()}
            saving={saving}
            setForm={setForm}
            title={t("bookInfo.newBookInfo")}
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
              {t("bookInfo.deletedChip")}
              <small className="ml-1 opacity-70">{deletedBooks.length}</small>
            </button>
          </div>
        )}

        {showDeleted && (
          <p className="text-xs text-muted-foreground">{t("bookInfo.purgeHint")}</p>
        )}

        {(showDeleted ? deletedBooks : expandedGroupBooks).length > 0 && (
          <div className="rounded-lg border">
            {(showDeleted ? deletedBooks : expandedGroupBooks).map((book) => {
              const isSelected = !showDeleted && selectedId === book.id;
              return (
                <div
                  className={isSelected ? "" : "border-b last:border-b-0"}
                  key={book.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {book.bookName || t("bookInfo.untitled")}
                        </span>
                        {!book.isEnable && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {t("bookInfo.isEnableLabel")} ✕
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("bookInfo.bookNoLabel")}: {book.bookNo}
                        {" · "}
                        {book.author || "—"}
                        {" · "}
                        {groupLabel(book.caseDivision)}
                        {book.chengShu ? ` · ${book.chengShu}` : ""}
                      </div>
                    </div>
                    {!isSelected && (
                      <div className="flex gap-2">
                        {book.isDeleted ? (
                          <Button
                            onClick={() => setConfirmingPurge(book)}
                            size="sm"
                            type="button"
                            variant="destructive"
                          >
                            {t("bookInfo.purgeAction")}
                          </Button>
                        ) : (
                          <>
                            <Button
                              onClick={() => selectLeaf(book.id)}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              {t("bookInfo.editBookInfo")}
                            </Button>
                            <Button
                              onClick={() => setConfirming(book)}
                              size="sm"
                              type="button"
                              variant="destructive"
                            >
                              {t("bookInfo.deleteAction")}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {selectedBook && !creating && (
          <BookInfoForm
            form={form}
            groups={groups}
            liveBooks={liveBooks}
            selfId={selectedBook.id}
            statuses={statuses}
            onCancel={cancel}
            onSave={() => void save()}
            saving={saving}
            setForm={setForm}
            title={t("bookInfo.editBookInfo")}
          />
        )}

        {confirming && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">{t("bookInfo.confirmDelete")}</p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void remove(confirming)}
                type="button"
                variant="destructive"
              >
                {t("bookInfo.deleteAction")}
              </Button>
              <Button
                onClick={() => setConfirming(null)}
                type="button"
                variant="ghost"
              >
                {t("bookInfo.cancelAction")}
              </Button>
            </div>
          </div>
        )}

        {confirmingPurge && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">
              {t("bookInfo.confirmPurge", {
                name: confirmingPurge.bookName || t("bookInfo.untitled"),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void purge(confirmingPurge)}
                type="button"
                variant="destructive"
              >
                {t("bookInfo.purgeAction")}
              </Button>
              <Button
                onClick={() => setConfirmingPurge(null)}
                type="button"
                variant="ghost"
              >
                {t("bookInfo.cancelAction")}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* 分组管理弹层：与选中书无关，挂在页面层，未选中也能打开。草稿副本 +
          点保存先改派再整表覆盖写。 */}
      <AdminDialog
        onOpenChange={(next) => {
          if (!next) setGroupOpen(false);
        }}
        open={groupOpen}
        title={t("bookInfo.groupDialogTitle")}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {t("bookInfo.groupDialogDescription")}
          </p>

          <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("bookInfo.groupKeyColumn")}</span>
            <span className="text-muted-foreground">{t("bookInfo.groupLabelColumn")}</span>
            <span />
            {draftGroups.map((group, index) => {
              const removing = pendingReassign[group.key] !== undefined;
              // 改派目标 = 存活组：既排除当前组自身，也排除其他已标记待删的组——
              // 否则把书改派到一个同批被删的组，保存后书落到不在清单的 case_division，悬空。
              const reassignOptions = draftGroups
                .filter((entry) => entry.key !== group.key && pendingReassign[entry.key] === undefined)
                .map((entry) => ({
                  label: entry.label,
                  value: entry.key,
                }));
              const bookCount = books.filter(
                (book) => !book.isDeleted && book.caseDivision === group.key,
              ).length;
              return (
                <div className="col-span-3 grid grid-cols-[1fr_1fr_auto] items-center gap-2" key={group.key}>
                  <code className="truncate font-mono text-foreground">{group.key}</code>
                  <Input
                    aria-label={t("bookInfo.groupLabelColumn")}
                    className="h-8"
                    disabled={saving || removing}
                    onChange={(event) => updateDraftLabel(index, event.target.value)}
                    value={group.label}
                  />
                  <div className="flex items-center gap-1">
                    <Button
                      aria-label={t("bookInfo.groupMoveUp")}
                      disabled={saving || index === 0}
                      onClick={() => moveDraft(index, -1)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={t("bookInfo.groupMoveDown")}
                      disabled={saving || index === draftGroups.length - 1}
                      onClick={() => moveDraft(index, 1)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={removing
                        ? t("bookInfo.groupUndoRemove")
                        : t("bookInfo.groupRemove")}
                      disabled={saving}
                      onClick={() => toggleRemoveDraft(group.key)}
                      size="icon"
                      type="button"
                      variant={removing ? "secondary" : "ghost"}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                  {removing && (
                    <div className="col-span-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
                      <span className="text-xs text-muted-foreground">
                        {t("bookInfo.groupReassignLabel", {count: bookCount})}
                      </span>
                      <div className="min-w-40 flex-1">
                        <AdminSelect
                          ariaLabel={t("bookInfo.groupReassignLabel", {count: bookCount})}
                          disabled={saving}
                          onChange={(option) =>
                            setPendingReassign((previous) => ({
                              ...previous,
                              [group.key]: option.value,
                            }))}
                          options={reassignOptions}
                          placeholder={t("bookInfo.groupReassignPlaceholder")}
                          value={
                            reassignOptions.find(
                              (option) => option.value === pendingReassign[group.key],
                            ) ?? null
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            <Input
              aria-label={t("bookInfo.groupKeyColumn")}
              className="h-8"
              disabled={saving}
              onChange={(event) =>
                setNewGroup((previous) => ({...previous, key: event.target.value}))}
              placeholder={t("bookInfo.groupKeyPlaceholder")}
              value={newGroup.key}
            />
            <Input
              aria-label={t("bookInfo.groupLabelColumn")}
              className="h-8"
              disabled={saving}
              onChange={(event) =>
                setNewGroup((previous) => ({...previous, label: event.target.value}))}
              placeholder={t("bookInfo.groupLabelPlaceholder")}
              value={newGroup.label}
            />
            <Button
              disabled={saving}
              onClick={addDraft}
              size="xs"
              type="button"
              variant="outline"
            >
              {t("bookInfo.groupAdd")}
            </Button>
          </div>

          {groupError && (
            <p className="text-xs text-destructive">
              {t(groupError, {count: 0})}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              disabled={saving}
              onClick={() => setGroupOpen(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("bookInfo.cancelAction")}
            </Button>
            <Button disabled={saving} onClick={() => void saveGroups()} size="sm" type="button">
              {t("bookInfo.saveAction")}
            </Button>
          </div>
        </div>
      </AdminDialog>

      {/* 状态管理弹层：与选中书无关，挂在页面层，未选中也能打开。草稿副本 +
          点保存整表覆盖写 settings。`value` 是 `hot_book` 存的整数（唯一），
          `label` 是下拉显示名。末状态禁删（hot_book NOT NULL 无值可写）。 */}
      <AdminDialog
        onOpenChange={(next) => {
          if (!next) setStatusOpen(false);
        }}
        open={statusOpen}
        title={t("bookInfo.statusDialogTitle")}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {t("bookInfo.statusDialogDescription")}
          </p>

          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("bookInfo.statusValueColumn")}</span>
            <span className="text-muted-foreground">{t("bookInfo.statusLabelColumn")}</span>
            <span />
            {draftStatuses.map((status, index) => (
              <div className="col-span-3 grid grid-cols-[auto_1fr_auto] items-center gap-2" key={status.value}>
                <code className="min-w-12 rounded bg-muted px-1.5 py-0.5 text-center font-mono text-foreground">
                  {status.value}
                </code>
                <Input
                  aria-label={t("bookInfo.statusLabelColumn")}
                  className="h-8"
                  disabled={saving}
                  onChange={(event) => updateDraftStatusLabel(index, event.target.value)}
                  value={status.label}
                />
                <div className="flex items-center gap-1">
                  <Button
                    aria-label={t("bookInfo.statusMoveUp")}
                    disabled={saving || index === 0}
                    onClick={() => moveDraftStatus(index, -1)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowUpIcon aria-hidden="true" />
                  </Button>
                  <Button
                    aria-label={t("bookInfo.statusMoveDown")}
                    disabled={saving || index === draftStatuses.length - 1}
                    onClick={() => moveDraftStatus(index, 1)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowDownIcon aria-hidden="true" />
                  </Button>
                  <Button
                    aria-label={t("bookInfo.statusRemove")}
                    disabled={saving}
                    onClick={() => toggleRemoveDraftStatus(status.value)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            <Input
              aria-label={t("bookInfo.statusValueColumn")}
              className="h-8 w-20"
              disabled={saving}
              inputMode="numeric"
              onChange={(event) =>
                setNewStatus((previous) => ({...previous, value: event.target.value}))}
              placeholder={t("bookInfo.statusValuePlaceholder")}
              value={newStatus.value}
            />
            <Input
              aria-label={t("bookInfo.statusLabelColumn")}
              className="h-8"
              disabled={saving}
              onChange={(event) =>
                setNewStatus((previous) => ({...previous, label: event.target.value}))}
              placeholder={t("bookInfo.statusLabelPlaceholder")}
              value={newStatus.label}
            />
            <Button
              disabled={saving}
              onClick={addDraftStatus}
              size="xs"
              type="button"
              variant="outline"
            >
              {t("bookInfo.statusAdd")}
            </Button>
          </div>

          {statusError && (
            <p className="text-xs text-destructive">{t(statusError)}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              disabled={saving}
              onClick={() => setStatusOpen(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("bookInfo.cancelAction")}
            </Button>
            <Button disabled={saving} onClick={() => void saveStatuses()} size="sm" type="button">
              {t("bookInfo.saveAction")}
            </Button>
          </div>
        </div>
      </AdminDialog>
    </div>
  );
}
