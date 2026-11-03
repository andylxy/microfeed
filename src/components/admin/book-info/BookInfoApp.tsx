import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import {ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, PencilIcon, Trash2Icon} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSelect from "@/components/admin/shared/AdminSelect";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import {AdminGroupTree} from "@/components/admin/shared/AdminGroupTree";
import {AdminTreeNavLayout} from "@/components/admin/shared/AdminTreeNavLayout";
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
 * 书本信息表单状态。`chapter` 以字符串承载（数字输入框可自由编辑），
 * `caseTag`/`bookNo` 迁移 0173 起是文本列，直接用字符串；`hotBook` 是状态下拉的
 * 取值（十进制字符串，提交时转 number）。
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
  isEnable: true,
  comment: "",
};

function formFromBook(
  book: BookInfoAdmin,
): BookInfoFormState {
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
  return (
    <div className="space-y-4 rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{title}</h2>
      <AdminInput
        label={t("bookInfo.nameLabel")}
        onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          set("bookName", event.target.value)}
        value={form.bookName}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
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
      </div>
      <div className="mt-5 space-y-4">
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
      </div>
      <div className="mt-5 flex gap-2">
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
  /** 右栏是否处于编辑态。false = 只读详情（Label），true = 表单可改。 */
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<BookInfoAdmin | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState<BookInfoAdmin | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [form, setForm] = useState<BookInfoFormState>(EMPTY_FORM);
  // 左栏树搜索（镜像 UsersApp）：有查询词时每组分只留命中书，含命中的组强制展开。
  const [treeSearch, setTreeSearch] = useState("");
  const searchActive = treeSearch.trim().length > 0;
  const searchQuery = treeSearch.trim().toLowerCase();

  /** 回到只读详情：退出编辑/新建、清空表单。`clearSelection` = 连选中的书一起清
   *  （删除/物理删除后无书可看）；false = 保留选中、只退出表单（取消编辑回详情）。 */
  const resetDetail = (clearSelection: boolean) => {
    setCreating(false);
    setEditing(false);
    setForm(EMPTY_FORM);
    if (clearSelection) setSelectedId(null);
  };

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

  /** 左栏树：分组清单（settings，按 sort）。顶层节点「书籍分类」由 AdminGroupTree 的 root 承载。
   *  搜索态每组只留命中书（书名/编号/作者），且**没命中的组整组不传**——组件只渲染传入的
   *  分组，所以不传 = 组头也不显示（需求①：命中组数 >0 才显示，=0 隐藏）；非搜索态给全量组。
   *  叶子两栏（需求②）：label=书名，description=作者（无作者不传 → 第二行留空）。 */
  const treeGroups = useMemo(
    () => groups.map((group) => {
      const members = booksOf(group.key);
      const visible = searchActive
        ? members.filter((book) =>
            (book.bookName || "").toLowerCase().includes(searchQuery)
            || (book.bookNo || "").toLowerCase().includes(searchQuery)
            || (book.author || "").toLowerCase().includes(searchQuery))
        : members;
      return {
        count: members.length,
        key: group.key,
        label: group.label,
        leaves: visible.map((book) => ({
          ...(book.author ? {description: book.author} : {}),
          id: book.id,
          label: book.bookName || t("bookInfo.untitled"),
        })),
      };
    // 搜索态丢弃零命中组（组头一并隐藏）；非搜索态保留全部组（含空组给 emptyLeafText 提示）。
    }).filter((group) => !searchActive || group.leaves.length > 0),
    [groups, booksOf, t, searchActive, searchQuery],
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

  // 点分组头：手风琴单展开/收起，**只切换展开态、不自动选中该组任何一本书**（需求③：
  // 自动选中会在右栏凭空打开一本，用户没点过；要打开就自己在树里点那本书）。
  const toggleGroup = (key: string) => {
    setExpandedKey(expandedKey === key ? null : key);
  };

  /** 树里点一本书：只读详情。表单留空，编辑时才 formFromBook 填充。 */
  const selectLeaf = (id: string) => {
    const book = liveBooks.find((entry) => entry.id === id);
    if (!book) return;
    setSelectedId(book.id);
    resetDetail(false);
  };

  /** 左栏工具栏「新建」：清空选中，右栏出空白表单（编辑态）。 */
  const startCreate = () => {
    setCreating(true);
    setEditing(true);
    setSelectedId(null);
    // 新建默认归到当前展开的分组；没有展开组则留空由操作者选。状态下拉默认取
    // 清单里 sort 最小的状态（hot_book NOT NULL，须有值）。
    const defaultStatus = [...statuses]
      .sort((a, b) => a.sort - b.sort || a.value - b.value)[0];
    setForm({
      ...EMPTY_FORM,
      caseDivision: expandedKey ?? "",
      hotBook: defaultStatus == null ? "" : String(defaultStatus.value),
    });
  };

  /** 详情页「编辑」：把当前选中的书灌进表单，进入编辑态（需求 4）。 */
  const startEdit = () => {
    const book = selectedBook;
    if (!book || book.isDeleted) return;
    setCreating(false);
    setEditing(true);
    setForm(formFromBook(book));
  };

  /** 取消：新建回退到未选中引导页；编辑回退到只读详情。 */
  const cancel = () => {
    resetDetail(!selectedBook);
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
      // 保存成功回到只读详情：编辑保持在原书，新建选中新返回的那本（响应含 id）。
      const savedId = selectedId ?? (typeof data.id === "string" ? data.id : null);
      setSelectedId(savedId);
      resetDetail(false);
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
      if (selectedId === book.id) resetDetail(true);
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
      if (selectedId === book.id) resetDetail(true);
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

  /** 状态值 → 显示名（详情页 Label 用；游离值按原值回落）。普通函数、非 hook，
   *  因为它位于 loading/error 早返回之后——早返回之后不能再调 hook（Rules of Hooks），
   *  否则数据到位后的重渲染会比首次渲染多出 hook，React 卸载整棵岛 → 白屏。 */
  const statusLabel = (value: number) =>
    statuses.find((status) => status.value === value)?.label ?? String(value);
  const selectedBook = selectedId
    ? liveBooks.find((book) => book.id === selectedId)
      ?? deletedBooks.find((book) => book.id === selectedId)
      ?? null
    : null;

  return (
    <>
      {/* 两个页面级弹层（分组/状态维护）与选中书无关、未选中也能打开，挂在布局外，
          与两栏布局并列。两栏壳（外层 flex + 左栏冻结卡 + 右栏主区）交给
          AdminTreeNavLayout，本组件只提供 nav 与右栏内容（与 AdminGroupTree 同一分工：
          布局与树都不认识业务）。 */}
      <AdminTreeNavLayout
        nav={
          <>
        {/* 左栏：分组树 + 新建/分组/状态管理入口。分组、计数与成员过滤都在本组件
            算好传入，AdminGroupTree 只渲染传入状态（约定不可改）。宽屏冻结在视口顶，
            树长时栏内自行滚动，不随右栏内容往上滚。 */}
        <div className="p-1">
          <Input
            aria-label={t("bookInfo.searchAria")}
            className="w-full"
            onChange={(event) => setTreeSearch(event.target.value)}
            placeholder={t("bookInfo.searchPlaceholder")}
            value={treeSearch}
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-1 pb-2">
          <Button
            aria-label={t("bookInfo.statusManage")}
            disabled={saving}
            onClick={openStatusManager}
            size="sm"
            title={t("bookInfo.statusManage")}
            type="button"
            variant="outline"
          >
            {t("bookInfo.statusManage")}
          </Button>
          <Button
            aria-label={t("bookInfo.groupManage")}
            disabled={saving}
            onClick={openGroupManager}
            size="sm"
            title={t("bookInfo.groupManage")}
            type="button"
            variant="outline"
          >
            {t("bookInfo.groupManage")}
          </Button>
          {/* 需求 2：「新建书本信息」放在「管理分组」右侧（justify-end 下最后渲染 =
              最右）。文字缩短为「新建书本」避免溢出，保留实心主按钮样式。 */}
          <Button
            disabled={saving}
            onClick={startCreate}
            size="sm"
            type="button"
          >
            {t("bookInfo.createBook")}
          </Button>
        </div>
        <AdminGroupTree
          emptyLeafText={t("bookInfo.groupEmpty")}
          emptyTreeText={searchActive ? t("bookInfo.searchNoResults") : undefined}
          expandedKeys={
            searchActive
              ? treeGroups.filter((group) => group.leaves.length > 0).map((group) => group.key)
              : expandedKey
                ? [expandedKey]
                : []
          }
          groups={treeGroups}
          onSelectLeaf={selectLeaf}
          onToggleGroup={toggleGroup}
          root={{label: t("bookInfo.treeRoot"), count: liveBooks.length}}
          selectedLeafId={selectedId}
        />

        {/* 已软删的书不进树（树只导航存活书），折叠收在这里；选中后右栏给详情 +
            「物理删除」。本模块无恢复，所以没有编辑入口。 */}
        {deletedBooks.length > 0 && (
          <div className="mt-2 border-t pt-2">
            <button
              className="flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-sm text-muted-foreground transition hover:text-foreground"
              onClick={() => setShowDeleted((current) => !current)}
              type="button"
            >
              <span>
                {t("bookInfo.deletedChip")}
                <small className="ml-1 opacity-70">{deletedBooks.length}</small>
              </span>
              <ChevronRightIcon
                aria-hidden="true"
                className={`size-4 transition-transform ${showDeleted ? "rotate-90" : ""}`}
              />
            </button>
            {showDeleted && (
              <div className="space-y-1">
                <p className="px-3 pb-1 text-xs text-muted-foreground">
                  {t("bookInfo.purgeHint")}
                </p>
                {deletedBooks.map((book) => {
                  const isSelected = selectedId === book.id;
                  return (
                    <div
                      className={`flex items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-sm ${isSelected
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                      key={book.id}
                    >
                      <button
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => {
                          setSelectedId(book.id);
                          resetDetail(false);
                        }}
                        type="button"
                      >
                        {book.bookName || t("bookInfo.untitled")}
                      </button>
                      <Button
                        aria-label={t("bookInfo.purgeAction")}
                        disabled={saving}
                        onClick={() => setConfirmingPurge(book)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
          </>
        }
      >
      {/* 右栏：选中书的只读详情（Label + 值）；点「编辑」或左栏「新建」才换成表单。
          未选中且非新建/编辑时右栏留空——不显示任何说明性提示（需求①）。 */}
      <section className="space-y-4 rounded-[14px] border bg-card p-5 shadow-xs">
        {selectedBook && !editing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {selectedBook.bookName || t("bookInfo.untitled")}
              </h2>
              <div className="flex gap-2">
                {selectedBook.isDeleted ? (
                  <Button
                    disabled={saving}
                    onClick={() => setConfirmingPurge(selectedBook)}
                    type="button"
                    variant="destructive"
                  >
                    <Trash2Icon aria-hidden="true" />
                    {t("bookInfo.purgeAction")}
                  </Button>
                ) : (
                  <>
                    <Button
                      onClick={startEdit}
                      type="button"
                      variant="outline"
                    >
                      <PencilIcon aria-hidden="true" />
                      {t("bookInfo.editAction")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => setConfirming(selectedBook)}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2Icon aria-hidden="true" />
                      {t("bookInfo.deleteAction")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">{t("bookInfo.nameLabel")}</dt>
                <dd className="text-sm font-medium">
                  {selectedBook.bookName || t("bookInfo.untitled")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookInfo.bookNoLabel")}</dt>
                <dd className="text-sm">{selectedBook.bookNo}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookInfo.caseDivisionLabel")}</dt>
                <dd className="text-sm">
                  {groupLabel(selectedBook.caseDivision)}
                  {!groupKeys.has(selectedBook.caseDivision) && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({selectedBook.caseDivision})
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookInfo.authorLabel")}</dt>
                <dd className="text-sm">{selectedBook.author || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookInfo.chengShuLabel")}</dt>
                <dd className="text-sm">{selectedBook.chengShu || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookInfo.chapterLabel")}</dt>
                <dd className="text-sm">{selectedBook.chapter ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookInfo.caseTagLabel")}</dt>
                <dd className="text-sm">{selectedBook.caseTag || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookInfo.hotBookLabel")}</dt>
                <dd className="text-sm">{statusLabel(selectedBook.hotBook)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookInfo.isEnableLabel")}</dt>
                <dd className="text-sm">
                  {selectedBook.isEnable
                    ? t("bookInfo.enableOn")
                    : t("bookInfo.enableOff")}
                </dd>
              </div>
              {selectedBook.imageUrl && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("bookInfo.imageUrlLabel")}</dt>
                  <dd className="text-sm">
                    <img
                      alt={selectedBook.bookName || t("bookInfo.untitled")}
                      className="max-h-48 rounded border"
                      src={selectedBook.imageUrl}
                    />
                  </dd>
                </div>
              )}
              {selectedBook.comment && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("bookInfo.commentLabel")}</dt>
                  <dd className="whitespace-pre-wrap text-sm">{selectedBook.comment}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* 表单只在新手新建或编辑一本存活书时出现；编辑已软删书不给入口。 */}
        {(creating || (editing && selectedBook && !selectedBook.isDeleted)) && (
          <BookInfoForm
            form={form}
            groups={groups}
            statuses={statuses}
            onCancel={cancel}
            onSave={() => void save()}
            saving={saving}
            setForm={setForm}
            title={creating ? t("bookInfo.newBookInfo") : t("bookInfo.editBookInfo")}
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
      </AdminTreeNavLayout>

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
    </>
  );
}
