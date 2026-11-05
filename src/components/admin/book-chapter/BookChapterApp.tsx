import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import {ChevronRightIcon, PencilIcon, PlusIcon, Trash2Icon} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSelect from "@/components/admin/shared/AdminSelect";
import {AdminGroupTree} from "@/components/admin/shared/AdminGroupTree";
import type {AdminTreeGroup} from "@/components/admin/shared/AdminGroupTree";
import {AdminTreeNavLayout} from "@/components/admin/shared/AdminTreeNavLayout";
import {AdminTreeSearchInput} from "@/components/admin/shared/AdminTreeSearchInput";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import AdminTextarea from "@/components/admin/shared/AdminTextarea";
import {Button} from "@/components/ui/button";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {
  BookChapterAdmin,
  BookChapterBoard,
  BookChapterBodyAdmin,
  BookChapterSourceBook,
} from "@/shared/BookChapter";

/**
 * 卷章表单状态。`chapterSection` 是源保真文本（VARCHAR(64)），空串 = 无值；
 * `sourceBookId` 空串 = 未归属书本（提交时转 null）。
 *
 * **文本一律不 trim**（ADR-0062 决策 6）：`chapterHeader` 原样提交，源数据里
 * 就有 6 行前导空格。客户端只判「是否全空白」，不改写。
 */
interface ChapterFormState {
  chapterHeader: string;
  sourceBookId: string;
  chapterSection: string;
  isEnable: boolean;
}

const EMPTY_CHAPTER_FORM: ChapterFormState = {
  chapterHeader: "",
  sourceBookId: "",
  chapterSection: "",
  isEnable: true,
};

/** 正文表单状态。所有文本原样提交，不 trim——正文的缩进、换行、句号后空格
 *  都是内容（源 SectionNote 1026 行前导缩进、SectionText 451 行句尾空格）。 */
interface BodyFormState {
  receiptNo: string;
  sectionText: string;
  sectionNote: string;
  fangJi: string;
  fangJiZhujie: string;
  bieMing: string;
  isEnable: boolean;
}

const EMPTY_BODY_FORM: BodyFormState = {
  receiptNo: "",
  sectionText: "",
  sectionNote: "",
  fangJi: "",
  fangJiZhujie: "",
  bieMing: "",
  isEnable: true,
};

/** 三层树的两类兜底桶：书没命中任何 settings 分类 / 卷章没命中任何来源书。
 *  实测生产数据 445/445 卷章与 12/12 本书都命中（0 悬空），这里只为
 *  宽松引用留后路（ADR-0062 决策 5：无来源书硬外键）。 */
const UNCATEGORIZED_KEY = "__uncategorized__";
const NO_BOOK_KEY = "__none__";
const CATEGORY_KEY_PREFIX = "cat:";
const BOOK_KEY_PREFIX = "book:";

/**
 * 正文弹层的自适应尺寸（经 `AdminDialog.contentClassName` 与默认值合并）：
 * 宽度按视口缩放、上限 48rem；高度由内容撑开，`dvh` 上限防超屏（移动端地址栏
 * 收起时比 `vh` 准）。`sm/lg:max-w-none` 清掉默认与 `DialogContent` 基础的固定
 * 宽度档位，否则 576px 上限会让 `w-[min(...)]` 失效。其余弹层不传，行为不变。
 */
const BODY_DIALOG_CONTENT_CLASS =
  "w-[min(90vw,48rem)] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] sm:max-w-none lg:max-w-none";

function formFromChapter(chapter: BookChapterAdmin): ChapterFormState {
  return {
    chapterHeader: chapter.chapterHeader,
    sourceBookId: chapter.sourceBookId ?? "",
    chapterSection: chapter.chapterSection ?? "",
    isEnable: chapter.isEnable,
  };
}

function formFromBody(body: BookChapterBodyAdmin): BodyFormState {
  return {
    receiptNo: String(body.receiptNo),
    sectionText: body.sectionText,
    sectionNote: body.sectionNote ?? "",
    fangJi: body.fangJi ?? "",
    fangJiZhujie: body.fangJiZhujie ?? "",
    bieMing: body.bieMing ?? "",
    isEnable: body.isEnable,
  };
}

function chapterToPayload(form: ChapterFormState): Record<string, unknown> {
  return {
    chapterHeader: form.chapterHeader,
    sourceBookId: form.sourceBookId.trim() || null,
    chapterSection: form.chapterSection === "" ? null : form.chapterSection,
    isEnable: form.isEnable,
  };
}

/** 正文载荷。序号（receipt_no）系统托管：新建不传（后端取卷章内 MAX+1）、
 *  编辑不传（后端保持原值），故这里一律不带 receiptNo。文本原样，不 trim。 */
function bodyToPayload(form: BodyFormState): Record<string, unknown> {
  return {
    sectionText: form.sectionText,
    sectionNote: form.sectionNote === "" ? null : form.sectionNote,
    fangJi: form.fangJi === "" ? null : form.fangJi,
    fangJiZhujie: form.fangJiZhujie === "" ? null : form.fangJiZhujie,
    bieMing: form.bieMing === "" ? null : form.bieMing,
    isEnable: form.isEnable,
  };
}

/** 客户端兜底：标题非纯空白、正文非空。真正的校验以服务端 Zod 为准。 */
function validateChapter(form: ChapterFormState): boolean {
  return form.chapterHeader.trim() !== "";
}

function validateBody(form: BodyFormState): boolean {
  return form.sectionText !== "";
}

/** 本草等级取值 → 可读文案（`'0'`=正文/上经 545、`'1'`=别本 385）。 */
function bencaoLevelText(
  level: string | null,
  t: (key: string) => string,
): string | null {
  if (level === "0") return t("bookChapter.bencaoLevelMain");
  if (level === "1") return t("bookChapter.bencaoLevelAlt");
  return level;
}

/** 卷章表单：新建置顶渲染，编辑在右栏展开。`creating` 区分新建/编辑——
 *  编辑时来源书与源分节号锁定不可改（需求：这两个字段只在新建时定）。 */
function ChapterForm({
  form,
  setForm,
  saving,
  sourceBooks,
  creating,
  onSave,
  onCancel,
  title,
}: {
  form: ChapterFormState;
  setForm: Dispatch<SetStateAction<ChapterFormState>>;
  saving: boolean;
  sourceBooks: BookChapterSourceBook[];
  creating: boolean;
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const {t} = useTranslation();
  const set = (key: keyof ChapterFormState, value: string | boolean) =>
    setForm((current) => ({...current, [key]: value}));
  // 来源书下拉：数据源是书本信息（book_info）动态获取，去掉「未归属书本」空串
  // 兜底项；book_no 为空的书（如「中药」「名词」）也不进下拉——它们没有可追溯
  // 的书本编号，选了也无法预填源分节号。当前值不在下拉里（来源书被软删，或该书
  // book_no 后来被清空）时把原 id 并入选项，保证编辑锁定态仍能显示原归属。
  const sourceOptions = useMemo(() => {
    const base = sourceBooks
      .filter((book) => book.bookNo.trim() !== "")
      .map((book) => ({label: book.bookName, value: book.id}));
    const current = form.sourceBookId.trim();
    if (current && !base.some((option) => option.value === current)) {
      return [...base, {label: current, value: current}];
    }
    return base;
  }, [sourceBooks, form.sourceBookId]);
  // 选来源书时把该书编号预填进源分节号（可改）。编辑态字段锁定，不触发预填。
  const onSourceBookChange = (option: {value: string}) => {
    const book = sourceBooks.find((entry) => entry.id === option.value);
    const section = book ? book.bookNo : "";
    setForm((current) => ({
      ...current,
      sourceBookId: option.value,
      chapterSection: creating ? section : current.chapterSection,
    }));
  };
  const selectedSource = sourceOptions.find(
    (option) => option.value === form.sourceBookId,
  ) ?? null;
  return (
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-5">
        <AdminInput
          label={t("bookChapter.headerLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("chapterHeader", event.target.value)}
          value={form.chapterHeader}
        />
      </div>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <AdminSelect
          ariaLabel={t("bookChapter.sourceBookLabel")}
          disabled={!creating}
          label={t("bookChapter.sourceBookLabel")}
          onChange={onSourceBookChange}
          options={sourceOptions}
          value={selectedSource}
        />
        <AdminInput
          disabled={!creating}
          label={t("bookChapter.chapterSectionLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("chapterSection", event.target.value)}
          value={form.chapterSection}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("bookChapter.chapterSectionHint")}
      </p>
      <div className="mt-5">
        <AdminSwitch
          checked={form.isEnable}
          label={t("bookChapter.isEnableLabel")}
          onCheckedChange={(checked) => set("isEnable", checked)}
        />
      </div>
      <div className="mt-5 flex gap-2">
        <Button disabled={saving} onClick={onSave} type="button">
          {t("bookChapter.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("bookChapter.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/** 正文表单，作为 `AdminDialog` 的内容（卡片与标题由弹层提供）。
 *  多行文本用 textarea，**原样提交不 trim**。`creating` 区分新建/编辑——
 *  序号（receipt_no）一律由系统给：新建自动 `MAX(receipt_no)+1`、编辑锁死
 *  不可改，故该输入框始终禁用（新建留空占位，编辑显示原值）。 */
function BodyForm({
  form,
  setForm,
  saving,
  creating,
  onSave,
  onCancel,
}: {
  form: BodyFormState;
  setForm: Dispatch<SetStateAction<BodyFormState>>;
  saving: boolean;
  creating: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const {t} = useTranslation();
  const set = (key: keyof BodyFormState, value: string | boolean) =>
    setForm((current) => ({...current, [key]: value}));
  return (
    <div>
      <div>
        {/* 序号系统托管：新建由后端取卷章内 MAX+1，编辑锁死。禁用框给出
            「自动生成」提示，避免操作者误以为漏填。 */}
        <AdminInput
          disabled
          label={t("bookChapter.bodyReceiptLabel")}
          placeholder={creating ? t("bookChapter.bodyReceiptAuto") : undefined}
          value={form.receiptNo}
        />
      </div>
      <div className="mt-4">
        {/* 正文普遍是单行短文本（中位 37 字），注释 82% 为空、非空时反而很长
            （p90 328 字 / 9 行）。故复用 AdminTextarea 的 field-sizing: content
            按内容增高，min/maxRows 定上下限，不再写死 14 / 6 行。
            `min-h-12` 覆盖 Textarea 基础的 min-h-24（96px），让 2 行下限生效。 */}
        <AdminTextarea
          customCss="min-h-12 text-sm"
          label={t("bookChapter.bodyTextLabel")}
          maxRows={12}
          minRows={2}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            set("sectionText", event.target.value)}
          value={form.sectionText}
        />
      </div>
      <div className="mt-4">
        <AdminTextarea
          customCss="min-h-12 text-sm"
          label={t("bookChapter.bodyNoteLabel")}
          maxRows={18}
          minRows={2}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            set("sectionNote", event.target.value)}
          value={form.sectionNote}
        />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <AdminInput
          label={t("bookChapter.bodyFangJiLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("fangJi", event.target.value)}
          value={form.fangJi}
        />
        <AdminInput
          label={t("bookChapter.bodyBieMingLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("bieMing", event.target.value)}
          value={form.bieMing}
        />
      </div>
      <div className="mt-4">
        <AdminInput
          label={t("bookChapter.bodyFangJiZhujieLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("fangJiZhujie", event.target.value)}
          value={form.fangJiZhujie}
        />
      </div>
      <div className="mt-4">
        <AdminSwitch
          checked={form.isEnable}
          label={t("bookChapter.isEnableLabel")}
          onCheckedChange={(checked) => set("isEnable", checked)}
        />
      </div>
      <div className="mt-4 flex gap-2">
        <Button disabled={saving} onClick={onSave} type="button">
          {t("bookChapter.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("bookChapter.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 独立「书本卷章」看板（ADR-0062）。
 *
 * 与既有 items-卷章（`tcm_kind='chapter'/'section'` 行）是两个并行模块：
 * 这里只读写 `book_chapter`/`book_chapter_body`，不碰 items/channels/zhong_yao。
 * 删除分两步——软删写 `deleted_at`（行保留），已软删的行只能物理删除。
 *
 * 布局是左右双栏：左栏 `AdminGroupTree` 是**三层树**——第一层书籍分类
 * （`settings.book_groups`）、第二层书名（`book_info`）、第三层卷章
 * （`book_chapter`）。链路 `source_book_id → book_info.id → case_division →
 * 分组 key` 全由看板一次返回，在页面侧派生分组，不落任何新列或新表
 * （ADR-0063）。右栏是选中卷章的详情 + 它的正文列表，正文按需拉取
 * （`bodies` 端点），不随看板一次返回 8066 行。
 *
 * **格式保真**：所有文本编辑框原样提交，不 trim、不归一换行。本草条目
 * （`bencaoYaoName` 非空）额外展示药名/等级，这两列导入派生、只读。
 */
export default function BookChapterApp() {
  const {t} = useTranslation();
  const [board, setBoard] = useState<BookChapterBoard>({
    groups: [],
    sourceBooks: [],
    chapters: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 三层树同时展开「分类 + 该书」两级。键前缀 `cat:` / `book:` 保证跨层唯一
   *  （分类 key 是 slug、书 id 是 11 位随机串，理论上不撞，但仍显式隔离）。 */
  const [expandedCategoryKey, setExpandedCategoryKey] = useState<string | null>(null);
  const [expandedBookKey, setExpandedBookKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 右栏是否处于编辑态。false = 只读详情，true = 表单可改。 */
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<BookChapterAdmin | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState<BookChapterAdmin | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [form, setForm] = useState<ChapterFormState>(EMPTY_CHAPTER_FORM);
  // 左栏树搜索：有查询词时每组只留命中卷章，含命中的组强制展开。
  const [treeSearch, setTreeSearch] = useState("");
  const searchActive = treeSearch.trim().length > 0;
  const searchQuery = treeSearch.trim().toLowerCase();

  // ---- 正文（按选中卷章按需拉取） ----
  const [bodies, setBodies] = useState<BookChapterBodyAdmin[]>([]);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [bodyForm, setBodyForm] = useState<BodyFormState>(EMPTY_BODY_FORM);
  const [bodyCreating, setBodyCreating] = useState(false);
  const [bodyEditingId, setBodyEditingId] = useState<string | null>(null);
  const [bodyConfirming, setBodyConfirming] = useState<BookChapterBodyAdmin | null>(null);
  const [bodyConfirmingPurge, setBodyConfirmingPurge] = useState<BookChapterBodyAdmin | null>(null);

  const sourceBooks = board.sourceBooks;
  const chapters = board.chapters;
  const liveChapters = chapters.filter((chapter) => !chapter.isDeleted);
  const deletedChapters = chapters.filter((chapter) => chapter.isDeleted);

  const selectedChapter = useMemo(
    () => chapters.find((chapter) => chapter.id === selectedId) ?? null,
    [chapters, selectedId],
  );

  const sourceBookLabel = useCallback(
    (id: string | null) => {
      if (!id) return null;
      return sourceBooks.find((book) => book.id === id)?.bookName ?? id;
    },
    [sourceBooks],
  );

  /** 从失败的 ajax 响应里取出本地化消息。服务端错误是 i18n key
   *  （如 errors.bookChapter.notFound），这里翻译后给 toast。 */
  const parseError = useCallback(
    async (response: Response, fallback: string): Promise<string> => {
      try {
        const data = (await response.json()) as {error?: string};
        return data.error ? t(data.error) : fallback;
      } catch {
        return fallback;
      }
    },
    [t],
  );

  /**
   * 左栏三层树（ADR-0063）：分类 → 书名 → 卷。三层数据全在页面侧由看板派生，
   * 组件只渲染传入状态：
   * - 第一层 = `settings.book_groups` 清单（按 sort），顶层总览 root 由组件承载；
   * - 第二层 = 来源书，按 `book_info.case_division` 归入分类；
   * - 第三层 = 卷章叶子，按 `source_book_id` 归入书。
   *
   * 徽章统一数「该节点下可见卷章数」（与 root 的 445 同口径）；搜索态跟随
   * 命中数。非搜索态保留全部分类与全部书（含 0 卷的书、0 书的分类），展开后
   * 由 `emptyText` / `emptyLeafText` 分别给空态；搜索态丢弃零命中分支并全展开。
   * 兜底分两种：书没命中分类时保留原名挂在「未分类」下；卷章没命中来源书
   * （为空或指向已软删的书）时并入「未归属书本」（生产数据 0 条）。
   */
  const treeGroups = useMemo<AdminTreeGroup[]>(() => {
    // 来源书是宽松引用（ADR-0062 决策 5）：sourceBookId 可能指向已软删或不存在的
    // 书。这类卷章在树上没有书节点可挂，不并入「未归属书本」就会被静默丢弃，
    // root 的 liveChapters.length 随之大于各级徽章之和。
    const knownBookIds = new Set(sourceBooks.map((book) => book.id));
    const chaptersByBook = new Map<string, BookChapterAdmin[]>();
    for (const chapter of liveChapters) {
      const bookKey =
        chapter.sourceBookId && knownBookIds.has(chapter.sourceBookId)
          ? chapter.sourceBookId
          : NO_BOOK_KEY;
      const bucket = chaptersByBook.get(bookKey);
      if (bucket) bucket.push(chapter);
      else chaptersByBook.set(bookKey, [chapter]);
    }

    const knownGroupKeys = new Set(board.groups.map((group) => group.key));
    const booksByCategory = new Map<string, BookChapterSourceBook[]>();
    for (const book of sourceBooks) {
      const categoryKey = knownGroupKeys.has(book.caseDivision)
        ? book.caseDivision
        : UNCATEGORIZED_KEY;
      const bucket = booksByCategory.get(categoryKey);
      if (bucket) bucket.push(book);
      else booksByCategory.set(categoryKey, [book]);
    }

    const hasOrphans = booksByCategory.has(UNCATEGORIZED_KEY)
      || chaptersByBook.has(NO_BOOK_KEY);
    const categories = [
      ...board.groups.map((group) => ({key: group.key, label: group.label})),
      ...(hasOrphans
        ? [{key: UNCATEGORIZED_KEY, label: t("bookChapter.uncategorizedGroup")}]
        : []),
    ];

    return categories
      .map((category) => {
        const books = booksByCategory.get(category.key) ?? [];
        const bookNodes = [
          ...books.map((book) => ({
            key: book.id,
            label: book.bookName || t("bookChapter.untitled"),
            chapters: chaptersByBook.get(book.id) ?? [],
          })),
          ...(category.key === UNCATEGORIZED_KEY && chaptersByBook.has(NO_BOOK_KEY)
            ? [{
                key: NO_BOOK_KEY,
                label: t("bookChapter.ungroupedBook"),
                chapters: chaptersByBook.get(NO_BOOK_KEY) ?? [],
              }]
            : []),
        ];
        const subgroups = bookNodes
          .map((book) => {
            const visible = searchActive
              ? book.chapters.filter((chapter) =>
                  (chapter.chapterHeader || "").toLowerCase().includes(searchQuery)
                  || String(chapter.chapterNo).includes(searchQuery)
                  || (chapter.chapterSection || "").toLowerCase().includes(searchQuery)
                  || book.label.toLowerCase().includes(searchQuery)
                  || category.label.toLowerCase().includes(searchQuery))
              : book.chapters;
            return {
              count: visible.length,
              key: `${BOOK_KEY_PREFIX}${book.key}`,
              label: book.label,
              // 第二行留空：树只导航卷章标题，序号与源分节号在右栏详情看。
              leaves: visible.map((chapter) => ({
                id: chapter.id,
                label: chapter.chapterHeader || t("bookChapter.untitled"),
              })),
            };
          })
          .filter((book) => !searchActive || book.leaves.length > 0);
        return {
          count: subgroups.reduce((total, book) => total + book.count, 0),
          emptyText: t("bookChapter.categoryEmpty"),
          key: `${CATEGORY_KEY_PREFIX}${category.key}`,
          label: category.label,
          leaves: [],
          subgroups,
        };
      })
      .filter((category) => !searchActive || (category.subgroups ?? []).length > 0);
  }, [board.groups, liveChapters, sourceBooks, searchActive, searchQuery, t]);

  /** 非搜索态手风琴：同时展开「当前分类 + 当前书」两级；搜索态全展开命中分支。 */
  const expandedKeys = useMemo(
    () => searchActive
      ? treeGroups.flatMap((category) => [
          category.key,
          ...(category.subgroups ?? []).map((book) => book.key),
        ])
      : [expandedCategoryKey, expandedBookKey].filter(
          (key): key is string => key !== null,
        ),
    [searchActive, treeGroups, expandedCategoryKey, expandedBookKey],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookChapter());
      const data = await response.json().catch(() => ({})) as BookChapterBoard &
        Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("bookChapter.loadFailed")));
      setBoard({
        groups: Array.isArray(data.groups) ? data.groups : [],
        sourceBooks: Array.isArray(data.sourceBooks) ? data.sourceBooks : [],
        chapters: Array.isArray(data.chapters) ? data.chapters : [],
      });
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("bookChapter.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 拉某卷章的正文列表（含已软删）。切换卷章时调用。 */
  const loadBodies = useCallback(
    async (chapterId: string) => {
      setBodyLoading(true);
      setBodyError(null);
      try {
        const response = await fetch(ADMIN_URLS.ajaxBookChapterBodies(chapterId));
        const data = await response.json().catch(() => ({})) as {
          bodies?: BookChapterBodyAdmin[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(data.error ? t(data.error) : t("bookChapter.bodyLoadFailed"));
        }
        setBodies(Array.isArray(data.bodies) ? data.bodies : []);
      } catch (bodyLoadError) {
        setBodies([]);
        setBodyError(
          bodyLoadError instanceof Error
            ? bodyLoadError.message
            : t("bookChapter.bodyLoadFailed"),
        );
      } finally {
        setBodyLoading(false);
      }
    },
    [t],
  );

  /** 选中卷章变化时清空正文编辑态并重新拉正文。 */
  useEffect(() => {
    setBodyCreating(false);
    setBodyEditingId(null);
    setBodyForm(EMPTY_BODY_FORM);
    setBodyConfirming(null);
    setBodyConfirmingPurge(null);
    if (selectedId) void loadBodies(selectedId);
    else setBodies([]);
  }, [selectedId, loadBodies]);

  const resetDetail = (clearSelection: boolean) => {
    setCreating(false);
    setEditing(false);
    setForm(EMPTY_CHAPTER_FORM);
    if (clearSelection) setSelectedId(null);
  };

  /** 分类与书各自手风琴：点分类只切分类（并收起上一本书），点书只切书。
   *  键前缀隔离两级，避免同名 slug / 11 位 id 撞车。 */
  const toggleGroup = (key: string) => {
    if (key.startsWith(CATEGORY_KEY_PREFIX)) {
      setExpandedCategoryKey((current) => current === key ? null : key);
      setExpandedBookKey(null);
      return;
    }
    setExpandedBookKey((current) => current === key ? null : key);
  };

  const selectLeaf = (id: string) => {
    const chapter = liveChapters.find((entry) => entry.id === id);
    if (!chapter) return;
    setSelectedId(chapter.id);
    resetDetail(false);
  };

  /** 新建时把「当前展开的书」预填成来源书，并同步预填该书编号到源分节号，
   *  省一次下拉与手填；未展开 / 兜底桶不预填（章节号留空，可后续手填）。 */
  const startCreate = () => {
    setCreating(true);
    setEditing(true);
    setSelectedId(null);
    const preset = expandedBookKey && expandedBookKey !== `${BOOK_KEY_PREFIX}${NO_BOOK_KEY}`
      ? expandedBookKey.slice(BOOK_KEY_PREFIX.length)
      : "";
    const presetBook = sourceBooks.find((book) => book.id === preset);
    setForm({
      ...EMPTY_CHAPTER_FORM,
      sourceBookId: preset,
      chapterSection: presetBook ? presetBook.bookNo : "",
    });
  };

  const startEdit = () => {
    if (!selectedChapter || selectedChapter.isDeleted) return;
    setCreating(false);
    setEditing(true);
    setForm(formFromChapter(selectedChapter));
  };

  const cancel = () => {
    resetDetail(!selectedChapter);
  };

  const save = async () => {
    if (!validateChapter(form)) {
      showToast(t("errors.bookChapter.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = selectedId
        ? await fetch(ADMIN_URLS.ajaxBookChapterItem(selectedId), {
            body: JSON.stringify(chapterToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxBookChapter(), {
            body: JSON.stringify(chapterToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("bookChapter.saveFailed")));
      showToast(t("saveAction.saved"), "success");
      const savedId = selectedId ?? (typeof data.id === "string" ? data.id : null);
      setSelectedId(savedId);
      resetDetail(false);
      await load();
    } catch (saveError) {
      showToast(
        saveError instanceof Error ? t(saveError.message) : t("bookChapter.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (chapter: BookChapterAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookChapterItem(chapter.id), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("bookChapter.deleteFailed")));
      }
      showToast(t("saveAction.saved"), "success");
      setConfirming(null);
      if (selectedId === chapter.id) resetDetail(true);
      await load();
    } catch (deleteError) {
      showToast(
        deleteError instanceof Error ? deleteError.message : t("bookChapter.deleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const purge = async (chapter: BookChapterAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookChapterPurge(chapter.id), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("bookChapter.purgeFailed")));
      }
      showToast(t("bookChapter.purgeDone"), "success");
      setConfirmingPurge(null);
      setShowDeleted(false);
      if (selectedId === chapter.id) resetDetail(true);
      await load();
    } catch (purgeError) {
      showToast(
        purgeError instanceof Error ? purgeError.message : t("bookChapter.purgeFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  // ---- 正文 CRUD ----

  const startCreateBody = () => {
    if (!selectedId) return;
    setBodyCreating(true);
    setBodyEditingId(null);
    setBodyForm(EMPTY_BODY_FORM);
  };

  const startEditBody = (body: BookChapterBodyAdmin) => {
    if (body.isDeleted) return;
    setBodyCreating(false);
    setBodyEditingId(body.id);
    setBodyForm(formFromBody(body));
  };

  const cancelBody = () => {
    setBodyCreating(false);
    setBodyEditingId(null);
    setBodyForm(EMPTY_BODY_FORM);
  };

  const saveBody = async () => {
    if (!selectedId) return;
    if (!validateBody(bodyForm)) {
      showToast(t("errors.bookChapter.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = bodyEditingId
        ? await fetch(ADMIN_URLS.ajaxBookChapterBodyItem(bodyEditingId), {
            body: JSON.stringify(bodyToPayload(bodyForm)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxBookChapterBodies(selectedId), {
            body: JSON.stringify(bodyToPayload(bodyForm)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      if (!response.ok) {
        throw new Error(await parseError(response, t("bookChapter.bodySaveFailed")));
      }
      showToast(t("saveAction.saved"), "success");
      cancelBody();
      await loadBodies(selectedId);
    } catch (bodySaveError) {
      showToast(
        bodySaveError instanceof Error
          ? bodySaveError.message
          : t("bookChapter.bodySaveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const removeBody = async (body: BookChapterBodyAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookChapterBodyItem(body.id), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("bookChapter.bodyDeleteFailed")));
      }
      showToast(t("saveAction.saved"), "success");
      setBodyConfirming(null);
      if (selectedId) await loadBodies(selectedId);
    } catch (bodyDeleteError) {
      showToast(
        bodyDeleteError instanceof Error
          ? bodyDeleteError.message
          : t("bookChapter.bodyDeleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const purgeBody = async (body: BookChapterBodyAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxBookChapterBodyPurge(body.id), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("bookChapter.purgeFailed")));
      }
      showToast(t("bookChapter.purgeDone"), "success");
      setBodyConfirmingPurge(null);
      if (selectedId) await loadBodies(selectedId);
    } catch (bodyPurgeError) {
      showToast(
        bodyPurgeError instanceof Error
          ? bodyPurgeError.message
          : t("bookChapter.purgeFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">{t("bookChapter.loading")}</p>;
  }
  if (error) {
    return <p className="p-4 text-sm text-destructive">{error}</p>;
  }

  const liveBodies = bodies.filter((body) => !body.isDeleted);
  const deletedBodies = bodies.filter((body) => body.isDeleted);

  return (
    <>
      <AdminTreeNavLayout
        nav={
        <>
          {/* 左栏：搜索 + 新建 + 「分类 → 书名 → 卷」三层树。三层的分组、
              计数与过滤都在本组件算好传入，AdminGroupTree 只渲染传入状态
              （约定不可改）；空分类与空书在非搜索态也保留，展开给空态提示。 */}
          <div className="p-1">
            <AdminTreeSearchInput
              ariaLabel={t("bookChapter.searchAria")}
              onValueChange={setTreeSearch}
              placeholder={t("bookChapter.searchPlaceholder")}
              value={treeSearch}
            />
          </div>
          <div className="flex items-center justify-end gap-2 px-1 pb-2">
            <Button
              disabled={saving}
              onClick={startCreate}
              size="sm"
              type="button"
            >
              {t("bookChapter.createChapter")}
            </Button>
          </div>
          <AdminGroupTree
            emptyLeafText={t("bookChapter.groupEmpty")}
            emptyTreeText={searchActive ? t("bookChapter.searchNoResults") : undefined}
            expandedKeys={expandedKeys}
            groups={treeGroups}
            onSelectLeaf={selectLeaf}
            onToggleGroup={toggleGroup}
            root={{label: t("bookChapter.treeRoot"), count: liveChapters.length}}
            selectedLeafId={selectedId}
          />

          {/* 已软删的卷章不进树（树只导航存活卷章），折叠收在这里；选中后右栏给
              详情 + 「物理删除」。本模块无恢复，所以没有编辑入口。 */}
          {deletedChapters.length > 0 && (
            <div className="mt-2 border-t pt-2">
              <button
                className="flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-sm text-muted-foreground transition hover:text-foreground"
                onClick={() => setShowDeleted((current) => !current)}
                type="button"
              >
                <span>
                  {t("bookChapter.deletedChip")}
                  <small className="ml-1 opacity-70">{deletedChapters.length}</small>
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className={`size-4 transition-transform ${showDeleted ? "rotate-90" : ""}`}
                />
              </button>
              {showDeleted && (
                <div className="space-y-1">
                  <p className="px-3 pb-1 text-xs text-muted-foreground">
                    {t("bookChapter.purgeHint")}
                  </p>
                  {deletedChapters.map((chapter) => {
                    const isSelected = selectedId === chapter.id;
                    return (
                      <div
                        className={`flex items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-sm ${isSelected
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                        key={chapter.id}
                      >
                        <button
                          className="min-w-0 flex-1 truncate text-left"
                          onClick={() => {
                            setSelectedId(chapter.id);
                            resetDetail(false);
                          }}
                          type="button"
                        >
                          {chapter.chapterHeader || t("bookChapter.untitled")}
                        </button>
                        <Button
                          aria-label={t("bookChapter.purgeAction")}
                          disabled={saving}
                          onClick={() => setConfirmingPurge(chapter)}
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
      {/* 右栏：选中卷章的只读详情 + 正文列表；点「编辑」或左栏「新建」才换成表单。 */}
      <section className="space-y-4 rounded-[14px] border bg-card p-5 shadow-xs">
        {selectedChapter && !editing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {selectedChapter.chapterHeader || t("bookChapter.untitled")}
              </h2>
              <div className="flex gap-2">
                {selectedChapter.isDeleted ? (
                  <Button
                    disabled={saving}
                    onClick={() => setConfirmingPurge(selectedChapter)}
                    type="button"
                    variant="destructive"
                  >
                    <Trash2Icon aria-hidden="true" />
                    {t("bookChapter.purgeAction")}
                  </Button>
                ) : (
                  <>
                    <Button onClick={startEdit} type="button" variant="outline">
                      <PencilIcon aria-hidden="true" />
                      {t("bookChapter.editAction")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => setConfirming(selectedChapter)}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2Icon aria-hidden="true" />
                      {t("bookChapter.deleteAction")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookChapter.chapterNoLabel")}</dt>
                <dd className="text-sm font-medium">{selectedChapter.chapterNo}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookChapter.sourceBookLabel")}</dt>
                <dd className="text-sm">
                  {sourceBookLabel(selectedChapter.sourceBookId)
                    || selectedChapter.sourceBookName
                    || t("bookChapter.noSourceBook")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("bookChapter.isEnableLabel")}</dt>
                <dd className="text-sm">
                  {selectedChapter.isEnable
                    ? t("bookChapter.enableOn")
                    : t("bookChapter.enableOff")}
                </dd>
              </div>
            </dl>

            {/* ---- 正文面板 ---- */}
            <div className="border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold">{t("bookChapter.bodiesTitle")}</h3>
                <Button
                  disabled={saving || selectedChapter.isDeleted}
                  onClick={startCreateBody}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlusIcon aria-hidden="true" />
                  {t("bookChapter.newBody")}
                </Button>
              </div>

              {bodyLoading && (
                <p className="mt-2 text-sm text-muted-foreground">…</p>
              )}
              {bodyError && (
                <p className="mt-2 text-sm text-destructive">{bodyError}</p>
              )}
              {!bodyLoading && !bodyError && liveBodies.length === 0 && (
                <p className="mt-2 text-sm text-muted-foreground">{t("bookChapter.bodiesEmpty")}</p>
              )}

              <ul className="mt-3 space-y-2">
                {liveBodies.map((body) => (
                  <li
                    className="rounded-[10px] border p-3"
                    key={body.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-mono text-xs text-muted-foreground">
                          {t("bookChapter.bodyReceiptLabel")} {body.receiptNo}
                        </span>
                        {body.bencaoYaoName && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                            {t("bookChapter.bencaoBadge")}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          aria-label={t("bookChapter.editBody")}
                          onClick={() => startEditBody(body)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <PencilIcon aria-hidden="true" />
                        </Button>
                        <Button
                          aria-label={t("bookChapter.deleteAction")}
                          disabled={saving}
                          onClick={() => setBodyConfirming(body)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                    {/* 正文原样显示（whitespace-pre-wrap 保住换行/缩进/句号后空格）。 */}
                    <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-sm">
                      {body.sectionText}
                    </p>
                    {body.bencaoYaoName && (
                      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                        <div>
                          <dt className="text-muted-foreground">{t("bookChapter.bencaoYaoNameLabel")}</dt>
                          <dd>{body.bencaoYaoName}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("bookChapter.bencaoLevelLabel")}</dt>
                          <dd>{bencaoLevelText(body.bencaoLevel, t) ?? "—"}</dd>
                        </div>
                        {body.bieMing && (
                          <div className="sm:col-span-2">
                            <dt className="text-muted-foreground">{t("bookChapter.bodyBieMingLabel")}</dt>
                            <dd>{body.bieMing}</dd>
                          </div>
                        )}
                      </dl>
                    )}
                    {bodyConfirming?.id === body.id && (
                      <div className="mt-2 space-y-2 rounded-lg border border-destructive p-3">
                        <p className="text-sm">{t("bookChapter.confirmBodyDelete")}</p>
                        <div className="flex gap-2">
                          <Button
                            disabled={saving}
                            onClick={() => void removeBody(body)}
                            size="sm"
                            type="button"
                            variant="destructive"
                          >
                            {t("bookChapter.deleteAction")}
                          </Button>
                          <Button
                            onClick={() => setBodyConfirming(null)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {t("bookChapter.cancelAction")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              {/* 已软删的正文：折叠，只能物理删除（同卷章口径）。 */}
              {deletedBodies.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-muted-foreground">
                    {t("bookChapter.deletedChip")} {deletedBodies.length}
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {deletedBodies.map((body) => (
                      <li
                        className="flex items-center justify-between gap-2 rounded-[10px] px-2 py-1 text-sm text-muted-foreground"
                        key={body.id}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {t("bookChapter.bodyReceiptLabel")} {body.receiptNo}
                        </span>
                        <Button
                          aria-label={t("bookChapter.purgeAction")}
                          disabled={saving}
                          onClick={() => setBodyConfirmingPurge(body)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {bodyConfirmingPurge && (
                <div className="mt-3 space-y-2 rounded-lg border border-destructive p-3">
                  <p className="text-sm">
                    {t("bookChapter.confirmPurge", {
                      name: `${t("bookChapter.bodyReceiptLabel")} ${bodyConfirmingPurge.receiptNo}`,
                    })}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      disabled={saving}
                      onClick={() => void purgeBody(bodyConfirmingPurge)}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      {t("bookChapter.purgeAction")}
                    </Button>
                    <Button
                      onClick={() => setBodyConfirmingPurge(null)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("bookChapter.cancelAction")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!selectedChapter && !creating && (
          <p className="text-sm text-muted-foreground">{t("bookChapter.noBodiesSelected")}</p>
        )}

        {/* 表单只在新手新建或编辑一条存活卷章时出现；编辑已软删卷章不给入口。 */}
        {(creating || (editing && selectedChapter && !selectedChapter.isDeleted)) && (
          <ChapterForm
            creating={creating}
            form={form}
            onCancel={cancel}
            onSave={() => void save()}
            saving={saving}
            setForm={setForm}
            sourceBooks={sourceBooks}
            title={creating ? t("bookChapter.newChapter") : t("bookChapter.editChapter")}
          />
        )}

        {confirming && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">{t("bookChapter.confirmDelete")}</p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void remove(confirming)}
                type="button"
                variant="destructive"
              >
                {t("bookChapter.deleteAction")}
              </Button>
              <Button
                onClick={() => setConfirming(null)}
                type="button"
                variant="ghost"
              >
                {t("bookChapter.cancelAction")}
              </Button>
            </div>
          </div>
        )}

        {confirmingPurge && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">
              {t("bookChapter.confirmPurge", {
                name: confirmingPurge.chapterHeader || t("bookChapter.untitled"),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void purge(confirmingPurge)}
                type="button"
                variant="destructive"
              >
                {t("bookChapter.purgeAction")}
              </Button>
              <Button
                onClick={() => setConfirmingPurge(null)}
                type="button"
                variant="ghost"
              >
                {t("bookChapter.cancelAction")}
              </Button>
            </div>
          </div>
        )}
      </section>
      </AdminTreeNavLayout>

      {/* 正文编辑/新建弹层：按组件指南 §7 挂在布局之外，避免被左栏卡片裁剪或
          随栏滚动。关闭复用 cancelBody，保存中禁关（closeDisabled）。 */}
      <AdminDialog
        closeDisabled={saving}
        contentClassName={BODY_DIALOG_CONTENT_CLASS}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) cancelBody();
        }}
        open={bodyCreating || bodyEditingId !== null}
        title={bodyCreating ? t("bookChapter.newBody") : t("bookChapter.editBody")}
      >
        <BodyForm
          creating={bodyCreating}
          form={bodyForm}
          onCancel={cancelBody}
          onSave={() => void saveBody()}
          saving={saving}
          setForm={setBodyForm}
        />
      </AdminDialog>
    </>
  );
}
