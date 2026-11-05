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
import {AdminTreeSearchInput} from "@/components/admin/shared/AdminTreeSearchInput";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import AdminMarkdownEditor from "@/components/admin/shared/AdminMarkdownEditor";
import MarkdownPreview from "@uiw/react-markdown-preview";
import remarkBreaks from "remark-breaks";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {
  mingCiGroupSchema,
  type MingCiAdmin,
  type MingCiBoard,
  type MingCiGroup,
  type MingCiSourceBook,
} from "@/shared/MingCi";

/**
 * 名词表单状态。`mingCiList` 以逗号分隔字符串承载（提交时 `split(',')` + trim，
 * 与迁移 0179 的 `JSON.stringify(split(',').map(trim))` 同口径）；`sourceBookId`
 * 空串 = 无来源书（提交时转 null）。
 */
interface MingCiFormState {
  mingCiName: string;
  mingCiBeiMing: string;
  mingCiText: string;
  mingCiList: string;
  sourceBookId: string;
  mingCiType: string;
  showImage: string;
  remark: string;
  isEnable: boolean;
}

const EMPTY_FORM: MingCiFormState = {
  mingCiName: "",
  mingCiBeiMing: "",
  mingCiText: "",
  mingCiList: "",
  sourceBookId: "",
  mingCiType: "",
  showImage: "",
  remark: "",
  isEnable: true,
};

function formFromNoun(noun: MingCiAdmin): MingCiFormState {
  return {
    mingCiName: noun.mingCiName,
    mingCiBeiMing: noun.mingCiBeiMing ?? "",
    mingCiText: noun.mingCiText,
    mingCiList: noun.mingCiList.join(", "),
    sourceBookId: noun.sourceBookId ?? "",
    mingCiType: noun.mingCiType,
    showImage: noun.showImage ?? "",
    remark: noun.remark ?? "",
    isEnable: noun.isEnable,
  };
}

/** 逗号分隔的「别名词条」→ `string[]`：split + trim，滤掉空串（`[""]` 无意义）。
 *  空输入 → `[]`。与迁移 0179 的 `split(',').map(trim)` 同口径。 */
function listToPayload(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function formToPayload(form: MingCiFormState): Record<string, unknown> {
  return {
    mingCiName: form.mingCiName.trim(),
    mingCiBeiMing: form.mingCiBeiMing.trim() || null,
    mingCiText: form.mingCiText,
    mingCiList: listToPayload(form.mingCiList),
    sourceBookId: form.sourceBookId.trim() || null,
    mingCiType: form.mingCiType.trim(),
    showImage: form.showImage.trim() || null,
    remark: form.remark.trim() || null,
    isEnable: form.isEnable,
  };
}

/** 客户端兜底：名词、名词内容、归纳分类必填。真正的校验以服务端 Zod 为准。 */
function validateForm(form: MingCiFormState): boolean {
  if (!form.mingCiName.trim()) return false;
  if (!form.mingCiText.trim()) return false;
  if (!form.mingCiType.trim()) return false;
  return true;
}

/** 共享表单：新建时置顶渲染，编辑时在行内展开。 */
function MingCiForm({
  form,
  setForm,
  saving,
  groups,
  sourceBooks,
  onSave,
  onCancel,
  title,
}: {
  form: MingCiFormState;
  setForm: Dispatch<SetStateAction<MingCiFormState>>;
  saving: boolean;
  /** 分组清单（settings）——归纳分类是分组键下拉，不是自由文本。 */
  groups: MingCiGroup[];
  /** 来源书下拉（book_info 存活行）。 */
  sourceBooks: MingCiSourceBook[];
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const {t} = useTranslation();
  const set = (key: keyof MingCiFormState, value: string | boolean) =>
    setForm((current) => ({...current, [key]: value}));
  // 归纳分类严格命中清单（ADR-0060 决策 4）：只给分组键。防御性兜底：若当前值
  // 不在清单（服务端严格校验下不应发生），仍显示原值逼着操作者显式改选。
  const typeOptions = useMemo(() => {
    const base = groups.map((group) => ({label: group.label, value: group.key}));
    const current = form.mingCiType.trim();
    if (current && !base.some((option) => option.value === current)) {
      return [...base, {label: current, value: current}];
    }
    return base;
  }, [groups, form.mingCiType]);
  const selectedType = typeOptions.find(
    (option) => option.value === form.mingCiType,
  ) ?? null;
  // 来源书下拉：空串 = 无来源书（nullable）。来源书是宽松校验（可空/悬空回落），
  // 当前值不在下拉里（来源书被删悬空）时把原 id 并入选项，逼着操作者显式改选或清空。
  const sourceOptions = useMemo(() => {
    const base = [
      {label: t("mingCi.noSourceBook"), value: ""},
      ...sourceBooks.map((book) => ({
        label: book.bookName,
        value: book.id,
      })),
    ];
    const current = form.sourceBookId.trim();
    if (current && !base.some((option) => option.value === current)) {
      return [...base, {label: current, value: current}];
    }
    return base;
  }, [sourceBooks, t, form.sourceBookId]);
  const selectedSource = sourceOptions.find(
    (option) => option.value === form.sourceBookId,
  ) ?? null;
  return (
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-5">
        <AdminInput
          label={t("mingCi.nameLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("mingCiName", event.target.value)}
          value={form.mingCiName}
        />
      </div>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <AdminInput
          label={t("mingCi.beiMingLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("mingCiBeiMing", event.target.value)}
          value={form.mingCiBeiMing}
        />
        <AdminInput
          label={t("mingCi.listLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("mingCiList", event.target.value)}
          value={form.mingCiList}
        />
        {/* 归纳分类 = 分组键（ADR-0060 决策 4）：改成哪个组，这条名词就归到左栏哪个分组。 */}
        <AdminSelect
          ariaLabel={t("mingCi.typeLabel")}
          label={t("mingCi.typeLabel")}
          onChange={(option) => set("mingCiType", option.value)}
          options={typeOptions}
          value={selectedType}
        />
        {/* 来源书 = book_info.id 逻辑引用（可空；宽松校验，无硬外键）。 */}
        <AdminSelect
          ariaLabel={t("mingCi.sourceBookLabel")}
          label={t("mingCi.sourceBookLabel")}
          onChange={(option) => set("sourceBookId", option.value)}
          options={sourceOptions}
          value={selectedSource}
        />
      </div>
      <div className="mt-5">
        <div className="mb-2 text-sm font-semibold text-foreground">
          {t("mingCi.textLabel")}
        </div>
        {/* 名词内容：Markdown 源码编辑器（含 $m{}/$n{}/$x{}/$a{} 标注工具栏，
          与 tcm 正文同款）。onChange 收到的是 Markdown 源码，原样存入 mingCiText，
          数据契约不变（ADR-0060：名词内容逐字存储，标记不解析）。 */}
        <AdminMarkdownEditor
          hint={t("mingCi.textMarkdownHint")}
          placeholder={t("mingCi.textMarkdownPlaceholder")}
          value={form.mingCiText}
          onChange={(value: string) => set("mingCiText", value)}
        />
      </div>
      <div className="mt-5">
        <AdminInput
          label={t("mingCi.showImageLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("showImage", event.target.value)}
          value={form.showImage}
        />
      </div>
      <div className="mt-5">
        <AdminSwitch
          checked={form.isEnable}
          label={t("mingCi.isEnableLabel")}
          onCheckedChange={(checked) => set("isEnable", checked)}
        />
      </div>
      <div className="mt-5">
        <AdminInput
          label={t("mingCi.remarkLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("remark", event.target.value)}
          value={form.remark}
        />
      </div>
      <div className="mt-5 flex gap-2">
        <Button disabled={saving} onClick={onSave} type="button">
          {t("mingCi.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("mingCi.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 独立「名词」CRUD 看板（ADR-0060）+ 分组树（镜像 ADR-0059 的 book-info 范式）。
 *
 * 与既有 `items`-名词（`tcm_kind='term'` 行）是两个并行模块：这里只读写
 * `ming_ci` 表，不碰 items/channels/ext_*。删除分两步——软删写 `deleted_at`
 * （行保留），已软删的行只能物理删除（本模块暂未提供恢复）。
 *
 * 布局是左右双栏：左栏 `AdminGroupTree` 按 `settings.mingci_groups` 分组导航，
 * 右栏是被选中那条名词的编辑表单。分组清单独立管理（ADR-0060 决策 4），
 * 名词的归属 = 自身 `ming_ci_type`（= 分组 `key`）。
 *
 * 与 BookInfoApp 的刻意差异：**无状态清单**（参考 `BeiMingCi` 只有 `IsEnable`，
 * 不建 `mingci_statuses`、不设状态下拉）；分组维度 = `ming_ci_type`（非
 * `case_division`）；来源书引用 `book_info.id`（`source_book_id`，非 channels）。
 */
export default function MingCiApp() {
  const {t} = useTranslation();
  const [board, setBoard] = useState<MingCiBoard>({groups: [], sourceBooks: [], nouns: []});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 右栏是否处于编辑态。false = 只读详情（Label），true = 表单可改。 */
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<MingCiAdmin | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState<MingCiAdmin | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [form, setForm] = useState<MingCiFormState>(EMPTY_FORM);
  // 左栏树搜索（镜像 UsersApp）：有查询词时每组分只留命中名词，含命中的组强制展开。
  const [treeSearch, setTreeSearch] = useState("");
  const searchActive = treeSearch.trim().length > 0;
  const searchQuery = treeSearch.trim().toLowerCase();

  /** 回到只读详情：退出编辑/新建、清空表单。`clearSelection` = 连选中的名词一起清
   *  （删除/物理删除后无名词可看）；false = 保留选中、只退出表单（取消编辑回详情）。 */
  const resetDetail = (clearSelection: boolean) => {
    setCreating(false);
    setEditing(false);
    setForm(EMPTY_FORM);
    if (clearSelection) setSelectedId(null);
  };

  // 「分组管理」弹层：分组清单的草稿副本，点保存才整表覆盖写 settings。
  const [groupOpen, setGroupOpen] = useState(false);
  const [draftGroups, setDraftGroups] = useState<MingCiGroup[]>([]);
  const [newGroup, setNewGroup] = useState<{key: string; label: string}>({key: "", label: ""});
  // 待删分组 → 该组名词要改派到的目标组 key（删组前先改派，ADR-0060 决策 4）。
  const [pendingReassign, setPendingReassign] = useState<Record<string, string>>({});
  const [groupError, setGroupError] = useState<string | null>(null);

  // 只读详情视图的 Markdown 预览明暗：与 AdminMarkdownEditor 同源——观察
  // <html data-color-mode>，用户切换/系统偏好变化都跟上，避免预览与后台主题错位。
  const [colorMode, setColorMode] = useState<"dark" | "light" | undefined>(undefined);
  useEffect(() => {
    const read = () => setColorMode(
      document.documentElement.dataset.colorMode === "dark" ? "dark" : "light",
    );
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-mode"],
    });
    return () => observer.disconnect();
  }, []);

  const groups = board.groups;
  const sourceBooks = board.sourceBooks;
  const nouns = board.nouns;
  const liveNouns = nouns.filter((noun) => !noun.isDeleted);
  const deletedNouns = nouns.filter((noun) => noun.isDeleted);

  /** 分组 key 集合；用于把名词按 `ming_ci_type` 归到对应分组。 */
  const groupKeys = useMemo(
    () => new Set(groups.map((group) => group.key)),
    [groups],
  );
  const nounsOf = useCallback(
    (key: string) => liveNouns.filter((noun) => noun.mingCiType === key),
    [liveNouns],
  );
  const groupLabel = useCallback(
    (key: string) =>
      groups.find((group) => group.key === key)?.label ?? key,
    [groups],
  );
  const sourceBookLabel = useCallback(
    (id: string | null) => {
      if (!id) return null;
      return sourceBooks.find((book) => book.id === id)?.bookName ?? id;
    },
    [sourceBooks],
  );

  /** 从失败的 ming-ci ajax 响应里取出本地化消息。服务端
   *  错误是 i18n key（如 errors.mingCi.invalidType），这里翻译后给 toast。 */
  const parseError = async (response: Response, fallback: string): Promise<string> => {
    try {
      const data = (await response.json()) as {error?: string};
      return data.error ? t(data.error) : fallback;
    } catch {
      return fallback;
    }
  };

  /** 左栏树：分组清单（settings，按 sort）。顶层节点「名词分类」由 AdminGroupTree 的 root 承载。
   *  搜索态每组只留命中名词（名称/编号/别名/内容），且**没命中的组整组不传**——组件只渲染传入的
   *  分组，所以不传 = 组头也不显示；非搜索态给全量组。
   *  徽章 count = visible.length：搜索态跟随命中数（与该组 leaves 一致），非搜索态 visible
   *  即全量 members，徽章仍是全量口径。
   *  叶子两栏：label=名词，description=别名（无别名不传 → 第二行留空）。 */
  const treeGroups = useMemo(
    () => groups.map((group) => {
      const members = nounsOf(group.key);
      const visible = searchActive
        ? members.filter((noun) =>
            (noun.mingCiName || "").toLowerCase().includes(searchQuery)
            || String(noun.mingCiNo).includes(searchQuery)
            || (noun.mingCiBeiMing || "").toLowerCase().includes(searchQuery)
            || (noun.mingCiText || "").toLowerCase().includes(searchQuery))
        : members;
      return {
        count: visible.length,
        key: group.key,
        label: group.label,
        leaves: visible.map((noun) => ({
          ...(noun.mingCiBeiMing ? {description: noun.mingCiBeiMing} : {}),
          id: noun.id,
          label: noun.mingCiName || t("mingCi.untitled"),
        })),
      };
    // 搜索态丢弃零命中组（组头一并隐藏）；非搜索态保留全部组（含空组给 emptyLeafText 提示）。
    }).filter((group) => !searchActive || group.leaves.length > 0),
    [groups, nounsOf, t, searchActive, searchQuery],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxMingCi());
      const data = await response.json().catch(() => ({})) as MingCiBoard &
        Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("mingCi.loadFailed")));
      setBoard({
        groups: Array.isArray(data.groups) ? data.groups : [],
        sourceBooks: Array.isArray(data.sourceBooks) ? data.sourceBooks : [],
        nouns: Array.isArray(data.nouns) ? data.nouns : [],
      });
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("mingCi.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 点分组头：手风琴单展开/收起，**只切换展开态、不自动选中该组任何一条名词**。
  const toggleGroup = (key: string) => {
    setExpandedKey(expandedKey === key ? null : key);
  };

  /** 树里点一条名词：只读详情。表单留空，编辑时才 formFromNoun 填充。 */
  const selectLeaf = (id: string) => {
    const noun = liveNouns.find((entry) => entry.id === id);
    if (!noun) return;
    setSelectedId(noun.id);
    resetDetail(false);
  };

  /** 左栏工具栏「新建」：清空选中，右栏出空白表单（编辑态）。
   *  新建默认归到当前展开的分组；没有展开组则留空由操作者选。 */
  const startCreate = () => {
    setCreating(true);
    setEditing(true);
    setSelectedId(null);
    setForm({...EMPTY_FORM, mingCiType: expandedKey ?? ""});
  };

  /** 详情页「编辑」：把当前选中的名词灌进表单，进入编辑态。 */
  const startEdit = () => {
    const noun = selectedNoun;
    if (!noun || noun.isDeleted) return;
    setCreating(false);
    setEditing(true);
    setForm(formFromNoun(noun));
  };

  /** 取消：新建回退到未选中引导页；编辑回退到只读详情。 */
  const cancel = () => {
    resetDetail(!selectedNoun);
  };

  const save = async () => {
    if (!validateForm(form)) {
      showToast(t("errors.mingCi.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = selectedId
        ? await fetch(ADMIN_URLS.ajaxMingCiItem(selectedId), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxMingCi(), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("mingCi.saveFailed")));
      showToast(t("saveAction.saved"), "success");
      // 保存成功回到只读详情：编辑保持在原名词，新建选中新返回的那条（响应含 id）。
      const savedId = selectedId ?? (typeof data.id === "string" ? data.id : null);
      setSelectedId(savedId);
      resetDetail(false);
      await load();
    } catch (saveError) {
      // 服务端错误是 i18n key（如 errors.mingCi.invalidType），直接翻译。
      showToast(
        saveError instanceof Error
          ? t(saveError.message)
          : t("mingCi.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (noun: MingCiAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxMingCiItem(noun.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("mingCi.deleteFailed")));
      showToast(t("saveAction.saved"), "success");
      setConfirming(null);
      if (selectedId === noun.id) resetDetail(true);
      await load();
    } catch (deleteError) {
      showToast(
        deleteError instanceof Error
          ? t(deleteError.message)
          : t("mingCi.deleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const purge = async (noun: MingCiAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxMingCiPurge(noun.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("mingCi.purgeFailed")));
      showToast(t("mingCi.purgeDone"), "success");
      setConfirmingPurge(null);
      setShowDeleted(false);
      if (selectedId === noun.id) resetDetail(true);
      await load();
    } catch (purgeError) {
      showToast(
        purgeError instanceof Error
          ? t(purgeError.message)
          : t("mingCi.purgeFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  // ---- 分组维护（settings.mingci_groups） ----

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
   * 标记删一个分组。组里有名词则必须先选「改派到」目标组；末组禁删（fail-closed，
   * `ming_ci_type` NOT NULL 无处改派）。再点一次同一组 = 撤销删除。
   */
  const toggleRemoveDraft = (key: string) => {
    setGroupError(null);
    setPendingReassign((previous) => {
      if (previous[key] !== undefined) {
        const {[key]: _dropped, ...rest} = previous;
        return rest;
      }
      if (draftGroups.length <= 1) {
        setGroupError("errors.mingCi.lastGroup");
        return previous;
      }
      return {...previous, [key]: ""};
    });
  };

  /** 新增一行草稿：先本地校验（key 形状 + 重复），通过才并入。 */
  const addDraft = () => {
    const key = newGroup.key.trim();
    const label = newGroup.label.trim();
    if (!mingCiGroupSchema.shape.key.safeParse(key).success) {
      setGroupError("mingCi.groupKeyInvalid");
      return;
    }
    if (!mingCiGroupSchema.shape.label.safeParse(label).success) {
      setGroupError("mingCi.groupLabelInvalid");
      return;
    }
    if (draftGroups.some((group) => group.key === key)) {
      setGroupError("mingCi.groupKeyDuplicated");
      return;
    }
    setDraftGroups((previous) => [...previous, {key, label, sort: previous.length}]);
    setNewGroup({key: "", label: ""});
    setGroupError(null);
  };

  /**
   * 保存：先把待删组的名词改派到目标组，再整表覆盖写 settings。两步任一失败都
   * 中止并提示，左栏等下次 `load()` 用服务端返回的清单刷新。
   */
  const saveGroups = async () => {
    const remaining = draftGroups.filter((group) => pendingReassign[group.key] === undefined);
    if (remaining.length === 0) {
      setGroupError("errors.mingCi.lastGroup");
      return;
    }
    for (const group of draftGroups) {
      const to = pendingReassign[group.key];
      if (to === undefined) continue;
      if (!to) {
        setGroupError("mingCi.groupReassignRequired");
        return;
      }
      if (to === group.key) {
        setGroupError("mingCi.groupReassignRequired");
        return;
      }
      // 目标组必须在本批保存后仍存活：改派到一个同批被删的组，名词会落到不在清单
      // 的 ming_ci_type，悬空无处归属，违背「改派到存活组」。
      if (!remaining.some((survivor) => survivor.key === to)) {
        setGroupError("mingCi.groupReassignRequired");
        return;
      }
    }
    if (remaining.some((group) => !group.label.trim())) {
      setGroupError("mingCi.groupLabelInvalid");
      return;
    }
    setSaving(true);
    try {
      for (const group of draftGroups) {
        const to = pendingReassign[group.key];
        if (to === undefined || !to) continue;
        const reassignResponse = await fetch(ADMIN_URLS.ajaxMingCiReassign(), {
          body: JSON.stringify({from: group.key, to}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        if (!reassignResponse.ok) {
          showToast(
            await parseError(reassignResponse, t("mingCi.groupSaveFailed")),
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
      const response = await fetch(ADMIN_URLS.ajaxMingCiGroups(), {
        body: JSON.stringify({groups: payload}),
        headers: {"content-type": "application/json"},
        method: "PUT",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("mingCi.groupSaveFailed")), "error");
        return;
      }
      setGroupOpen(false);
      setGroupError(null);
      showToast(t("mingCi.groupSaved"), "success");
      await load();
    } catch {
      showToast(t("mingCi.groupSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <AdminCollectionLoading label={t("mingCi.title")} />;
  }
  if (error) {
    return (
      <AdminCollectionError
        message={error}
        retry={() => void load()}
      />
    );
  }

  const selectedNoun = selectedId
    ? liveNouns.find((noun) => noun.id === selectedId)
      ?? deletedNouns.find((noun) => noun.id === selectedId)
      ?? null
    : null;

  return (
    <>
      {/* 分组管理弹层与选中名词无关、未选中也能打开，挂在布局外，与两栏布局并列。
          两栏壳（外层 flex + 左栏冻结卡 + 右栏主区）交给 AdminTreeNavLayout，
          本组件只提供 nav 与右栏内容（与 AdminGroupTree 同一分工：布局与树都不认识业务）。 */}
      <AdminTreeNavLayout
        nav={
          <>
        {/* 左栏：分组树 + 新建/分组管理入口。分组、计数与成员过滤都在本组件
            算好传入，AdminGroupTree 只渲染传入状态（约定不可改）。宽屏冻结在视口顶，
            树长时栏内自行滚动，不随右栏内容往上滚。 */}
        <div className="p-1">
          <AdminTreeSearchInput
            ariaLabel={t("mingCi.searchAria")}
            onValueChange={setTreeSearch}
            placeholder={t("mingCi.searchPlaceholder")}
            value={treeSearch}
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-1 pb-2">
          <Button
            aria-label={t("mingCi.groupManage")}
            disabled={saving}
            onClick={openGroupManager}
            size="sm"
            title={t("mingCi.groupManage")}
            type="button"
            variant="outline"
          >
            {t("mingCi.groupManage")}
          </Button>
          <Button
            disabled={saving}
            onClick={startCreate}
            size="sm"
            type="button"
          >
            {t("mingCi.createNoun")}
          </Button>
        </div>
        <AdminGroupTree
          emptyLeafText={t("mingCi.groupEmpty")}
          emptyTreeText={searchActive ? t("mingCi.searchNoResults") : undefined}
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
          root={{label: t("mingCi.treeRoot"), count: liveNouns.length}}
          selectedLeafId={selectedId}
        />

        {/* 已软删的名词不进树（树只导航存活名词），折叠收在这里；选中后右栏给详情 +
            「物理删除」。本模块无恢复，所以没有编辑入口。 */}
        {deletedNouns.length > 0 && (
          <div className="mt-2 border-t pt-2">
            <button
              className="flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-sm text-muted-foreground transition hover:text-foreground"
              onClick={() => setShowDeleted((current) => !current)}
              type="button"
            >
              <span>
                {t("mingCi.deletedChip")}
                <small className="ml-1 opacity-70">{deletedNouns.length}</small>
              </span>
              <ChevronRightIcon
                aria-hidden="true"
                className={`size-4 transition-transform ${showDeleted ? "rotate-90" : ""}`}
              />
            </button>
            {showDeleted && (
              <div className="space-y-1">
                <p className="px-3 pb-1 text-xs text-muted-foreground">
                  {t("mingCi.purgeHint")}
                </p>
                {deletedNouns.map((noun) => {
                  const isSelected = selectedId === noun.id;
                  return (
                    <div
                      className={`flex items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-sm ${isSelected
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                      key={noun.id}
                    >
                      <button
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => {
                          setSelectedId(noun.id);
                          resetDetail(false);
                        }}
                        type="button"
                      >
                        {noun.mingCiName || t("mingCi.untitled")}
                      </button>
                      <Button
                        aria-label={t("mingCi.purgeAction")}
                        disabled={saving}
                        onClick={() => setConfirmingPurge(noun)}
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
      {/* 右栏：选中名词的只读详情（Label + 值）；点「编辑」或左栏「新建」才换成表单。
          未选中且非新建/编辑时右栏留空——不显示任何说明性提示。 */}
      <section className="space-y-4 rounded-[14px] border bg-card p-5 shadow-xs">
        {selectedNoun && !editing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {selectedNoun.mingCiName || t("mingCi.untitled")}
              </h2>
              <div className="flex gap-2">
                {selectedNoun.isDeleted ? (
                  <Button
                    disabled={saving}
                    onClick={() => setConfirmingPurge(selectedNoun)}
                    type="button"
                    variant="destructive"
                  >
                    <Trash2Icon aria-hidden="true" />
                    {t("mingCi.purgeAction")}
                  </Button>
                ) : (
                  <>
                    <Button
                      onClick={startEdit}
                      type="button"
                      variant="outline"
                    >
                      <PencilIcon aria-hidden="true" />
                      {t("mingCi.editAction")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => setConfirming(selectedNoun)}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2Icon aria-hidden="true" />
                      {t("mingCi.deleteAction")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">{t("mingCi.nameLabel")}</dt>
                <dd className="text-sm font-medium">
                  {selectedNoun.mingCiName || t("mingCi.untitled")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("mingCi.typeLabel")}</dt>
                <dd className="text-sm">
                  {groupLabel(selectedNoun.mingCiType)}
                  {!groupKeys.has(selectedNoun.mingCiType) && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({selectedNoun.mingCiType})
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("mingCi.beiMingLabel")}</dt>
                <dd className="text-sm">{selectedNoun.mingCiBeiMing || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("mingCi.sourceBookLabel")}</dt>
                <dd className="text-sm">{sourceBookLabel(selectedNoun.sourceBookId) || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("mingCi.listLabel")}</dt>
                <dd className="text-sm">{selectedNoun.mingCiList.join("、") || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("mingCi.isEnableLabel")}</dt>
                <dd className="text-sm">
                  {selectedNoun.isEnable
                    ? t("mingCi.enableOn")
                    : t("mingCi.enableOff")}
                </dd>
              </div>
              {/* 展示图：源路径字符串（microfeed 内不一定可解析），UI 降级——显示原值，
                  不渲染 <img>（悬空/不可解析路径不破版）。 */}
              {selectedNoun.showImage && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("mingCi.showImageLabel")}</dt>
                  <dd className="break-all font-mono text-sm">{selectedNoun.showImage}</dd>
                </div>
              )}
              {selectedNoun.mingCiText && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("mingCi.textLabel")}</dt>
                  {/* 只读态也走 Markdown 渲染，与编辑态所见一致：作者键入的语法
                      在此渲染成最终形态（配 remark-breaks 让换行与编辑预览同观感）。 */}
                  <dd className="mt-1">
                    <div className="overflow-auto rounded-md border bg-muted/30 p-4 text-sm">
                      <MarkdownPreview
                        remarkPlugins={[remarkBreaks]}
                        source={selectedNoun.mingCiText}
                        wrapperElement={
                          colorMode ? {"data-color-mode": colorMode} : undefined
                        }
                      />
                    </div>
                  </dd>
                </div>
              )}
              {selectedNoun.remark && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("mingCi.remarkLabel")}</dt>
                  <dd className="whitespace-pre-wrap text-sm">{selectedNoun.remark}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* 表单只在新手新建或编辑一条存活名词时出现；编辑已软删名词不给入口。 */}
        {(creating || (editing && selectedNoun && !selectedNoun.isDeleted)) && (
          <MingCiForm
            form={form}
            groups={groups}
            sourceBooks={sourceBooks}
            onCancel={cancel}
            onSave={() => void save()}
            saving={saving}
            setForm={setForm}
            title={creating ? t("mingCi.newMingCi") : t("mingCi.editMingCi")}
          />
        )}

        {confirming && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">{t("mingCi.confirmDelete")}</p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void remove(confirming)}
                type="button"
                variant="destructive"
              >
                {t("mingCi.deleteAction")}
              </Button>
              <Button
                onClick={() => setConfirming(null)}
                type="button"
                variant="ghost"
              >
                {t("mingCi.cancelAction")}
              </Button>
            </div>
          </div>
        )}

        {confirmingPurge && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">
              {t("mingCi.confirmPurge", {
                name: confirmingPurge.mingCiName || t("mingCi.untitled"),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void purge(confirmingPurge)}
                type="button"
                variant="destructive"
              >
                {t("mingCi.purgeAction")}
              </Button>
              <Button
                onClick={() => setConfirmingPurge(null)}
                type="button"
                variant="ghost"
              >
                {t("mingCi.cancelAction")}
              </Button>
            </div>
          </div>
        )}
      </section>
      </AdminTreeNavLayout>

      {/* 分组管理弹层：与选中名词无关，挂在页面层，未选中也能打开。草稿副本 +
          点保存先改派再整表覆盖写。 */}
      <AdminDialog
        onOpenChange={(next) => {
          if (!next) setGroupOpen(false);
        }}
        open={groupOpen}
        title={t("mingCi.groupDialogTitle")}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {t("mingCi.groupDialogDescription")}
          </p>

          <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("mingCi.groupKeyColumn")}</span>
            <span className="text-muted-foreground">{t("mingCi.groupLabelColumn")}</span>
            <span />
            {draftGroups.map((group, index) => {
              const removing = pendingReassign[group.key] !== undefined;
              // 改派目标 = 存活组：既排除当前组自身，也排除其他已标记待删的组——
              // 否则把名词改派到一个同批被删的组，保存后名词落到不在清单的 ming_ci_type，悬空。
              const reassignOptions = draftGroups
                .filter((entry) => entry.key !== group.key && pendingReassign[entry.key] === undefined)
                .map((entry) => ({
                  label: entry.label,
                  value: entry.key,
                }));
              const nounCount = nouns.filter(
                (noun) => !noun.isDeleted && noun.mingCiType === group.key,
              ).length;
              return (
                <div className="col-span-3 grid grid-cols-[1fr_1fr_auto] items-center gap-2" key={group.key}>
                  <code className="truncate font-mono text-foreground">{group.key}</code>
                  <Input
                    aria-label={t("mingCi.groupLabelColumn")}
                    className="h-8"
                    disabled={saving || removing}
                    onChange={(event) => updateDraftLabel(index, event.target.value)}
                    value={group.label}
                  />
                  <div className="flex items-center gap-1">
                    <Button
                      aria-label={t("mingCi.groupMoveUp")}
                      disabled={saving || index === 0}
                      onClick={() => moveDraft(index, -1)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={t("mingCi.groupMoveDown")}
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
                        ? t("mingCi.groupUndoRemove")
                        : t("mingCi.groupRemove")}
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
                        {t("mingCi.groupReassignLabel", {count: nounCount})}
                      </span>
                      <div className="min-w-40 flex-1">
                        <AdminSelect
                          ariaLabel={t("mingCi.groupReassignLabel", {count: nounCount})}
                          disabled={saving}
                          onChange={(option) =>
                            setPendingReassign((previous) => ({
                              ...previous,
                              [group.key]: option.value,
                            }))}
                          options={reassignOptions}
                          placeholder={t("mingCi.groupReassignPlaceholder")}
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
              aria-label={t("mingCi.groupKeyColumn")}
              className="h-8"
              disabled={saving}
              onChange={(event) =>
                setNewGroup((previous) => ({...previous, key: event.target.value}))}
              placeholder={t("mingCi.groupKeyPlaceholder")}
              value={newGroup.key}
            />
            <Input
              aria-label={t("mingCi.groupLabelColumn")}
              className="h-8"
              disabled={saving}
              onChange={(event) =>
                setNewGroup((previous) => ({...previous, label: event.target.value}))}
              placeholder={t("mingCi.groupLabelPlaceholder")}
              value={newGroup.label}
            />
            <Button
              disabled={saving}
              onClick={addDraft}
              size="xs"
              type="button"
              variant="outline"
            >
              {t("mingCi.groupAdd")}
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
              {t("mingCi.cancelAction")}
            </Button>
            <Button disabled={saving} onClick={() => void saveGroups()} size="sm" type="button">
              {t("mingCi.saveAction")}
            </Button>
          </div>
        </div>
      </AdminDialog>
    </>
  );
}
