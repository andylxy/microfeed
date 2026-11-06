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
import {useColorMode} from "@/client/useColorMode";
import {useTranslation} from "@/client/i18n";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import AdminInput from "@/components/admin/shared/AdminInput";
import {AdminGroupTree} from "@/components/admin/shared/AdminGroupTree";
import type {AdminTreeGroup} from "@/components/admin/shared/AdminGroupTree";
import AdminMarkdownEditor from "@/components/admin/shared/AdminMarkdownEditor";
import {AdminTreeNavLayout} from "@/components/admin/shared/AdminTreeNavLayout";
import {AdminTreeSearchInput} from "@/components/admin/shared/AdminTreeSearchInput";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import {Button} from "@/components/ui/button";
import MarkdownPreview from "@uiw/react-markdown-preview";
import remarkBreaks from "remark-breaks";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {UNGROUPED_KEY} from "@/shared/FangYao";
import type {
  FangYaoAdmin,
  FangYaoBodyAdmin,
  FangYaoBoard,
} from "@/shared/FangYao";

/**
 * 方剂表单状态。`fangName`/`fangText` 原样提交不 trim（方文的前导缩进、换行、
 * 制表符都是内容）；`fangText` 的花括号已由导入配平，编辑不再改写。
 * `sourceBookLegacyId`/`sourceBookName` 空串 = 未归属源书（提交转 null）。
 * `fangNo` 系统托管（组内 MAX+1），不在表单里。
 */
interface FangFormState {
  fangName: string;
  sourceBookLegacyId: string;
  sourceBookName: string;
  yaoList: string;
  fangText: string;
  fangDrinkNum: string;
  isEnable: boolean;
}

const EMPTY_FANG_FORM: FangFormState = {
  fangName: "",
  sourceBookLegacyId: "",
  sourceBookName: "",
  yaoList: "",
  fangText: "",
  fangDrinkNum: "",
  isEnable: true,
};

/** 组成表单状态。`amount` 内嵌 `$x{}` 标记，原样提交不 trim。
 *  `position` 系统托管（方内 MAX+1），不在表单里；`yaoLegacyId`（源 YaoID）
 *  只读追溯——编辑隐藏、不改写（创建走源导入，后台新增组成不设源 id）。 */
interface BodyFormState {
  showName: string;
  amount: string;
  extraProcess: string;
  weight: string;
  isEnable: boolean;
}

const EMPTY_BODY_FORM: BodyFormState = {
  showName: "",
  amount: "",
  extraProcess: "",
  weight: "",
  isEnable: true,
};

/** 两层树「源书 → 方」的兜底桶：方剂没命中任何源书组时挂这里，避免被静默丢弃。
 *  生产数据 5 组均有 legacy id，此桶预期空。哨兵键来自 shared 单一真源
 *  `UNGROUPED_KEY`（与 server handlers 同源，防「判空归组」与「渲染归组」漂移）。 */
const GROUP_KEY_PREFIX = "group:";

/** 组成弹层的自适应尺寸（经 `AdminDialog.contentClassName` 与默认值合并）：
 *  宽度按视口缩放、上限 48rem；高度由内容撑开，`dvh` 上限防超屏。 */
const BODY_DIALOG_CONTENT_CLASS =
  "w-[min(90vw,48rem)] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] sm:max-w-none lg:max-w-none";

function formFromFang(formula: FangYaoAdmin): FangFormState {
  return {
    fangName: formula.fangName,
    sourceBookLegacyId: formula.sourceBookLegacyId ?? "",
    sourceBookName: formula.sourceBookName ?? "",
    yaoList: formula.yaoList ?? "",
    fangText: formula.fangText,
    fangDrinkNum: formula.fangDrinkNum ?? "",
    isEnable: formula.isEnable,
  };
}

function formFromBody(body: FangYaoBodyAdmin): BodyFormState {
  return {
    showName: body.showName ?? "",
    amount: body.amount ?? "",
    extraProcess: body.extraProcess ?? "",
    weight: body.weight ?? "",
    isEnable: body.isEnable,
  };
}

/** 方剂载荷。`fangName`/`fangText` 原样（不 trim）；可空字段空串 → null。
 *  `fangNo` 不带（系统托管）。 */
function fangToPayload(form: FangFormState): Record<string, unknown> {
  return {
    fangName: form.fangName,
    sourceBookLegacyId: form.sourceBookLegacyId.trim() || null,
    sourceBookName: form.sourceBookName.trim() || null,
    yaoList: form.yaoList === "" ? null : form.yaoList,
    fangText: form.fangText,
    fangDrinkNum: form.fangDrinkNum === "" ? null : form.fangDrinkNum,
    isEnable: form.isEnable,
  };
}

/** 组成载荷。`position` 系统托管：新建不传（后端取方内 MAX+1）、编辑不传
 *  （后端保持原值），故这里一律不带。`yaoLegacyId` 只读追溯：不传（后端保留
 *  原值，新建为 null）。文本原样，不 trim。 */
function bodyToPayload(form: BodyFormState): Record<string, unknown> {
  return {
    showName: form.showName === "" ? null : form.showName,
    amount: form.amount === "" ? null : form.amount,
    extraProcess: form.extraProcess === "" ? null : form.extraProcess,
    weight: form.weight === "" ? null : form.weight,
    isEnable: form.isEnable,
  };
}

/** 客户端兜底：方名非纯空白、方文非空。真正的校验以服务端 Zod 为准。 */
function validateFang(form: FangFormState): boolean {
  return form.fangName.trim() !== "" && form.fangText !== "";
}

function validateBody(form: BodyFormState): boolean {
  return form.showName.trim() !== "";
}

/** 方剂表单：新建置顶渲染，编辑在右栏展开。`creating` 区分新建/编辑——
 *  编辑时源书与源书名锁定不可改（源归属是历史，仅新建时定）。 */
function FangForm({
  form,
  setForm,
  saving,
  creating,
  onSave,
  onCancel,
  title,
}: {
  form: FangFormState;
  setForm: Dispatch<SetStateAction<FangFormState>>;
  saving: boolean;
  creating: boolean;
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const {t} = useTranslation();
  const set = (key: keyof FangFormState, value: string | boolean) =>
    setForm((current) => ({...current, [key]: value}));
  return (
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-5">
        <AdminInput
          label={t("fangYao.nameLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("fangName", event.target.value)}
          value={form.fangName}
        />
      </div>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <AdminInput
          disabled={!creating}
          label={t("fangYao.sourceBookIdLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("sourceBookLegacyId", event.target.value)}
          value={form.sourceBookLegacyId}
        />
        <AdminInput
          disabled={!creating}
          label={t("fangYao.sourceBookNameLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("sourceBookName", event.target.value)}
          value={form.sourceBookName}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("fangYao.sourceBookHint")}
      </p>
      <div className="mt-5">
        <AdminInput
          label={t("fangYao.fangDrinkNumLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("fangDrinkNum", event.target.value)}
          value={form.fangDrinkNum}
        />
      </div>
      <div className="mt-5">
        <AdminInput
          label={t("fangYao.yaoListLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("yaoList", event.target.value)}
          value={form.yaoList}
        />
      </div>
      <div className="mt-5">
        <div className="mb-2 text-sm font-semibold text-foreground">
          {t("fangYao.fangTextLabel")}
        </div>
        {/* 方文：Markdown 源码编辑器（含 $u{}/$w{}/$f{} 等标注工具栏，与 tcm 正文
            同款）。onChange 收到 Markdown 源码，原样存入 fangText——数据契约不变
            （ADR-0065：方文逐字存储，$ 标记不解析、花括号已由导入配平）。 */}
        <AdminMarkdownEditor
          hint={t("fangYao.fangTextHint")}
          value={form.fangText}
          onChange={(value: string) => set("fangText", value)}
        />
      </div>
      <div className="mt-5">
        <AdminSwitch
          checked={form.isEnable}
          label={t("fangYao.isEnableLabel")}
          onCheckedChange={(checked) => set("isEnable", checked)}
        />
      </div>
      <div className="mt-5 flex gap-2">
        <Button disabled={saving} onClick={onSave} type="button">
          {t("fangYao.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("fangYao.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/** 组成表单，作为 `AdminDialog` 的内容。文本原样提交不 trim。序号（position）
 *  一律由系统给：新建自动 `MAX(position)+1`、编辑锁死不可改，故不在表单内。 */
function BodyForm({
  form,
  setForm,
  saving,
  onSave,
  onCancel,
}: {
  form: BodyFormState;
  setForm: Dispatch<SetStateAction<BodyFormState>>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const {t} = useTranslation();
  const set = (key: keyof BodyFormState, value: string | boolean) =>
    setForm((current) => ({...current, [key]: value}));
  return (
    <div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <AdminInput
          label={t("fangYao.bodyShowNameLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("showName", event.target.value)}
          value={form.showName}
        />
        <AdminInput
          label={t("fangYao.bodyAmountLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("amount", event.target.value)}
          value={form.amount}
        />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <AdminInput
          label={t("fangYao.bodyExtraProcessLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("extraProcess", event.target.value)}
          value={form.extraProcess}
        />
        <AdminInput
          label={t("fangYao.bodyWeightLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("weight", event.target.value)}
          value={form.weight}
        />
      </div>
      {/* 药材源 Id（yaoLegacyId）只读追溯：编辑隐藏，不在表单里——提交不带，
          后端保留原值；新建组成无源 id（仅导入设置）。 */}
      <div className="mt-4">
        <AdminSwitch
          checked={form.isEnable}
          label={t("fangYao.isEnableLabel")}
          onCheckedChange={(checked) => set("isEnable", checked)}
        />
      </div>
      <div className="mt-4 flex gap-2">
        <Button disabled={saving} onClick={onSave} type="button">
          {t("fangYao.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("fangYao.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 独立「方剂」看板（ADR-0065）。
 *
 * 与既有 items 方剂机制（legacy fangs 页 / `tcm_kind` 行）是两个并行模块：
 * 这里只读写 `fang_yao`/`fang_yao_body`，不碰 items/channels/zhong_yao/
 * book_chapter。删除分两步——软删写 `deleted_at`（行保留），已软删的行只能
 * 物理删除（方剂下还有组成时后端 409 `purgeHasBodies`，不留孤儿组成）。
 *
 * 布局是左右双栏：左栏 `AdminGroupTree` 是**两层树**——第一层源书
 * （`source_book_legacy_id`，组名 `source_book_name` 兜底）、第二层方剂
 * （`fang_yao`）。分组与计数全由看板返回后在页面侧派生，不落任何新列或新表
 * （ADR-0065 决策 5）。右栏是选中方剂的详情 + 它的组成列表，组成按需拉取
 * （`bodies` 端点），不随看板一次返回 2025 行。
 *
 * **格式保真**：所有文本编辑框原样提交，不 trim、不归一换行。`fangText` 的
 * `$` 标记不解析、花括号已由导入配平；`amount` 内嵌 `$x{}` 原样展示。
 */
export default function FangYaoApp() {
  const {t} = useTranslation();
  const [board, setBoard] = useState<FangYaoBoard>({
    groups: [],
    formulas: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 两层树只展开「当前源书组」一级。键前缀 `group:` 隔离，避免与 11 位 id 撞车。 */
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<FangYaoAdmin | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState<FangYaoAdmin | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [form, setForm] = useState<FangFormState>(EMPTY_FANG_FORM);
  // 左栏树搜索：有查询词时每组只留命中方剂，含命中的组强制展开。
  const [treeSearch, setTreeSearch] = useState("");
  const searchActive = treeSearch.trim().length > 0;
  const searchQuery = treeSearch.trim().toLowerCase();

  // ---- 组成（按选中方剂按需拉取） ----
  const [bodies, setBodies] = useState<FangYaoBodyAdmin[]>([]);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [bodyForm, setBodyForm] = useState<BodyFormState>(EMPTY_BODY_FORM);
  const [bodyCreating, setBodyCreating] = useState(false);
  const [bodyEditingId, setBodyEditingId] = useState<string | null>(null);
  const [bodyConfirming, setBodyConfirming] = useState<FangYaoBodyAdmin | null>(null);
  const [bodyConfirmingPurge, setBodyConfirmingPurge] = useState<FangYaoBodyAdmin | null>(null);

  // 只读详情视图的 Markdown 预览明暗：与 AdminMarkdownEditor 同源（共享 hook）。
  const colorMode = useColorMode();

  const formulas = board.formulas;
  const liveFormulas = formulas.filter((formula) => !formula.isDeleted);
  const deletedFormulas = formulas.filter((formula) => formula.isDeleted);

  const selectedFormula = useMemo(
    () => formulas.find((formula) => formula.id === selectedId) ?? null,
    [formulas, selectedId],
  );

  /** 从失败的 ajax 响应里取出本地化消息。服务端错误是 i18n key
   *  （如 errors.fangYao.notFound），这里翻译后给 toast。 */
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
   * 左栏两层树（源书 → 方）。数据全在页面侧由看板派生，组件只渲染传入状态：
   * - 第一层 = `board.groups`（按 `source_book_legacy_id` 聚合），顶层总览 root
   *   由组件承载；
   * - 第二层 = 方剂叶子，按 `source_book_legacy_id` 归入源书组。
   *
   * 徽章统一数「该节点下可见方剂数」（与 root 的 liveFormulas.length 同口径）；
   * 搜索态跟随命中数。非搜索态保留全部分组（含 0 方的组），展开后由
   * `emptyLeafText` 给空态；搜索态丢弃零命中分支并全展开。兜底：方剂没命中
   * 已知源书组（为空或未登记）时并入「未归属源书」（生产数据 0 条）。
   */
  const treeGroups = useMemo<AdminTreeGroup[]>(() => {
    const knownGroupKeys = new Set(board.groups.map((group) => group.key));
    const formulasByGroup = new Map<string, FangYaoAdmin[]>();
    for (const formula of liveFormulas) {
      const groupKey = formula.sourceBookLegacyId && knownGroupKeys.has(formula.sourceBookLegacyId)
        ? formula.sourceBookLegacyId
        : UNGROUPED_KEY;
      const bucket = formulasByGroup.get(groupKey);
      if (bucket) bucket.push(formula);
      else formulasByGroup.set(groupKey, [formula]);
    }

    const hasOrphans = formulasByGroup.has(UNGROUPED_KEY);
    const groups = [
      ...board.groups.map((group) => ({key: group.key, name: group.name})),
      ...(hasOrphans
        ? [{key: UNGROUPED_KEY, name: t("fangYao.ungroupedFormula")}]
        : []),
    ];

    return groups
      .map((group) => {
        const formulasInGroup = formulasByGroup.get(group.key) ?? [];
        const visible = searchActive
          ? formulasInGroup.filter((formula) =>
              (formula.fangName || "").toLowerCase().includes(searchQuery)
              || String(formula.fangNo).includes(searchQuery)
              || (formula.sourceBookName || "").toLowerCase().includes(searchQuery)
              || group.name.toLowerCase().includes(searchQuery))
          : formulasInGroup;
        return {
          count: visible.length,
          emptyText: t("fangYao.groupEmpty"),
          key: `${GROUP_KEY_PREFIX}${group.key}`,
          label: group.name,
          // 叶子第二栏不传（留空）：组头已是源书名，序号不再复述（fangNo 隐藏）。
          leaves: visible.map((formula) => ({
            id: formula.id,
            label: formula.fangName || t("fangYao.untitled"),
          })),
        };
      })
      .filter((group) => !searchActive || group.leaves.length > 0);
  }, [board.groups, liveFormulas, searchActive, searchQuery, t]);

  /** 非搜索态手风琴：只展开「当前源书组」一级；搜索态全展开命中分支。 */
  const expandedKeys = useMemo(
    () => searchActive
      ? treeGroups.map((group) => group.key)
      : [expandedGroupKey].filter((key): key is string => key !== null),
    [searchActive, treeGroups, expandedGroupKey],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxFangYao());
      const data = await response.json().catch(() => ({})) as FangYaoBoard &
        Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("fangYao.loadFailed")));
      setBoard({
        groups: Array.isArray(data.groups) ? data.groups : [],
        formulas: Array.isArray(data.formulas) ? data.formulas : [],
      });
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("fangYao.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 拉某方剂的组成列表（含已软删）。切换方剂时调用。 */
  const loadBodies = useCallback(
    async (fangId: string) => {
      setBodyLoading(true);
      setBodyError(null);
      try {
        const response = await fetch(ADMIN_URLS.ajaxFangYaoBodies(fangId));
        const data = await response.json().catch(() => ({})) as {
          bodies?: FangYaoBodyAdmin[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(data.error ? t(data.error) : t("fangYao.bodyLoadFailed"));
        }
        setBodies(Array.isArray(data.bodies) ? data.bodies : []);
      } catch (bodyLoadError) {
        setBodies([]);
        setBodyError(
          bodyLoadError instanceof Error
            ? bodyLoadError.message
            : t("fangYao.bodyLoadFailed"),
        );
      } finally {
        setBodyLoading(false);
      }
    },
    [t],
  );

  /** 选中方剂变化时清空组成编辑态并重新拉组成。 */
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
    setForm(EMPTY_FANG_FORM);
    if (clearSelection) setSelectedId(null);
  };

  /** 源书组手风琴：点组只切该组（单层无子级）。 */
  const toggleGroup = (key: string) => {
    setExpandedGroupKey((current) => current === key ? null : key);
  };

  const selectLeaf = (id: string) => {
    const formula = liveFormulas.find((entry) => entry.id === id);
    if (!formula) return;
    setSelectedId(formula.id);
    resetDetail(false);
  };

  /** 新建时把「当前展开的源书组」预填成源书归属，省一次手填。 */
  const startCreate = () => {
    setCreating(true);
    setEditing(true);
    setSelectedId(null);
    const preset = expandedGroupKey && expandedGroupKey !== `${GROUP_KEY_PREFIX}${UNGROUPED_KEY}`
      ? expandedGroupKey.slice(GROUP_KEY_PREFIX.length)
      : "";
    const presetGroup = board.groups.find((group) => group.key === preset);
    setForm({
      ...EMPTY_FANG_FORM,
      sourceBookLegacyId: preset,
      sourceBookName: presetGroup ? presetGroup.name : "",
    });
  };

  const startEdit = () => {
    if (!selectedFormula || selectedFormula.isDeleted) return;
    setCreating(false);
    setEditing(true);
    setForm(formFromFang(selectedFormula));
  };

  const cancel = () => {
    resetDetail(!selectedFormula);
  };

  const save = async () => {
    if (!validateFang(form)) {
      showToast(t("errors.fangYao.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = selectedId
        ? await fetch(ADMIN_URLS.ajaxFangYaoItem(selectedId), {
            body: JSON.stringify(fangToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxFangYao(), {
            body: JSON.stringify(fangToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("fangYao.saveFailed")));
      showToast(t("saveAction.saved"), "success");
      const savedId = selectedId ?? (typeof data.id === "string" ? data.id : null);
      setSelectedId(savedId);
      resetDetail(false);
      await load();
    } catch (saveError) {
      showToast(
        saveError instanceof Error ? t(saveError.message) : t("fangYao.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (formula: FangYaoAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxFangYaoItem(formula.id), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("fangYao.deleteFailed")));
      }
      showToast(t("saveAction.saved"), "success");
      setConfirming(null);
      if (selectedId === formula.id) resetDetail(true);
      await load();
    } catch (deleteError) {
      showToast(
        deleteError instanceof Error ? deleteError.message : t("fangYao.deleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const purge = async (formula: FangYaoAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxFangYaoPurge(formula.id), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("fangYao.purgeFailed")));
      }
      showToast(t("fangYao.purgeDone"), "success");
      setConfirmingPurge(null);
      setShowDeleted(false);
      if (selectedId === formula.id) resetDetail(true);
      await load();
    } catch (purgeError) {
      showToast(
        purgeError instanceof Error ? purgeError.message : t("fangYao.purgeFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  // ---- 组成 CRUD ----

  const startCreateBody = () => {
    if (!selectedId) return;
    setBodyCreating(true);
    setBodyEditingId(null);
    setBodyForm(EMPTY_BODY_FORM);
  };

  const startEditBody = (body: FangYaoBodyAdmin) => {
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
      showToast(t("errors.fangYao.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = bodyEditingId
        ? await fetch(ADMIN_URLS.ajaxFangYaoBodyItem(bodyEditingId), {
            body: JSON.stringify(bodyToPayload(bodyForm)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxFangYaoBodies(selectedId), {
            body: JSON.stringify(bodyToPayload(bodyForm)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      if (!response.ok) {
        throw new Error(await parseError(response, t("fangYao.bodySaveFailed")));
      }
      showToast(t("saveAction.saved"), "success");
      cancelBody();
      await loadBodies(selectedId);
    } catch (bodySaveError) {
      showToast(
        bodySaveError instanceof Error
          ? bodySaveError.message
          : t("fangYao.bodySaveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const removeBody = async (body: FangYaoBodyAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxFangYaoBodyItem(body.id), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("fangYao.bodyDeleteFailed")));
      }
      showToast(t("saveAction.saved"), "success");
      setBodyConfirming(null);
      if (selectedId) await loadBodies(selectedId);
    } catch (bodyDeleteError) {
      showToast(
        bodyDeleteError instanceof Error
          ? bodyDeleteError.message
          : t("fangYao.bodyDeleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const purgeBody = async (body: FangYaoBodyAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxFangYaoBodyPurge(body.id), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("fangYao.purgeFailed")));
      }
      showToast(t("fangYao.purgeDone"), "success");
      setBodyConfirmingPurge(null);
      if (selectedId) await loadBodies(selectedId);
    } catch (bodyPurgeError) {
      showToast(
        bodyPurgeError instanceof Error
          ? bodyPurgeError.message
          : t("fangYao.purgeFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">{t("fangYao.loading")}</p>;
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
          {/* 左栏：搜索 + 新建 + 「源书 → 方」两层树。分组、计数与过滤都在
              本组件算好传入，AdminGroupTree 只渲染传入状态（约定不可改）；
              空源书组在非搜索态也保留，展开给空态提示。 */}
          <div className="p-1">
            <AdminTreeSearchInput
              ariaLabel={t("fangYao.searchAria")}
              onValueChange={setTreeSearch}
              placeholder={t("fangYao.searchPlaceholder")}
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
              {t("fangYao.createFormula")}
            </Button>
          </div>
          <AdminGroupTree
            emptyLeafText={t("fangYao.groupEmpty")}
            emptyTreeText={searchActive ? t("fangYao.searchNoResults") : undefined}
            expandedKeys={expandedKeys}
            groups={treeGroups}
            onSelectLeaf={selectLeaf}
            onToggleGroup={toggleGroup}
            root={{label: t("fangYao.treeRoot"), count: liveFormulas.length}}
            selectedLeafId={selectedId}
          />

          {/* 已软删的方剂不进树（树只导航存活方剂），折叠收在这里；选中后右栏给
              详情 + 「物理删除」。本模块无恢复，所以没有编辑入口。 */}
          {deletedFormulas.length > 0 && (
            <div className="mt-2 border-t pt-2">
              <button
                className="flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-sm text-muted-foreground transition hover:text-foreground"
                onClick={() => setShowDeleted((current) => !current)}
                type="button"
              >
                <span>
                  {t("fangYao.deletedChip")}
                  <small className="ml-1 opacity-70">{deletedFormulas.length}</small>
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className={`size-4 transition-transform ${showDeleted ? "rotate-90" : ""}`}
                />
              </button>
              {showDeleted && (
                <div className="space-y-1">
                  <p className="px-3 pb-1 text-xs text-muted-foreground">
                    {t("fangYao.purgeHint")}
                  </p>
                  {deletedFormulas.map((formula) => {
                    const isSelected = selectedId === formula.id;
                    return (
                      <div
                        className={`flex items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-sm ${isSelected
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                        key={formula.id}
                      >
                        <button
                          className="min-w-0 flex-1 truncate text-left"
                          onClick={() => {
                            setSelectedId(formula.id);
                            resetDetail(false);
                          }}
                          type="button"
                        >
                          {formula.fangName || t("fangYao.untitled")}
                        </button>
                        <Button
                          aria-label={t("fangYao.purgeAction")}
                          disabled={saving}
                          onClick={() => setConfirmingPurge(formula)}
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
      {/* 右栏：选中方剂的只读详情 + 组成列表；点「编辑」或左栏「新建」才换成表单。 */}
      <section className="space-y-4 rounded-[14px] border bg-card p-5 shadow-xs">
        {selectedFormula && !editing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {selectedFormula.fangName || t("fangYao.untitled")}
              </h2>
              <div className="flex gap-2">
                {selectedFormula.isDeleted ? (
                  <Button
                    disabled={saving}
                    onClick={() => setConfirmingPurge(selectedFormula)}
                    type="button"
                    variant="destructive"
                  >
                    <Trash2Icon aria-hidden="true" />
                    {t("fangYao.purgeAction")}
                  </Button>
                ) : (
                  <>
                    <Button onClick={startEdit} type="button" variant="outline">
                      <PencilIcon aria-hidden="true" />
                      {t("fangYao.editAction")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => setConfirming(selectedFormula)}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2Icon aria-hidden="true" />
                      {t("fangYao.deleteAction")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t("fangYao.fangNoLabel")}</dt>
                <dd className="text-sm font-medium">{selectedFormula.fangNo}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("fangYao.sourceBookNameLabel")}</dt>
                <dd className="text-sm">
                  {selectedFormula.sourceBookName
                    || selectedFormula.sourceBookLegacyId
                    || t("fangYao.noSourceBook")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("fangYao.yaoCountLabel")}</dt>
                <dd className="text-sm font-medium">{selectedFormula.yaoCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("fangYao.fangDrinkNumLabel")}</dt>
                <dd className="text-sm">{selectedFormula.fangDrinkNum ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("fangYao.isEnableLabel")}</dt>
                <dd className="text-sm">
                  {selectedFormula.isEnable
                    ? t("fangYao.enableOn")
                    : t("fangYao.enableOff")}
                </dd>
              </div>
              {selectedFormula.yaoList && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("fangYao.yaoListLabel")}</dt>
                  <dd className="whitespace-pre-wrap text-sm">{selectedFormula.yaoList}</dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">{t("fangYao.fangTextLabel")}</dt>
                {/* 只读态也走 Markdown 渲染，与编辑态所见一致：方文里的 $ 标记
                    原样呈现，配 remark-breaks 让换行与编辑预览同观感（ADR-0065：
                    方文逐字存储，这里只渲染不改写）。 */}
                <dd className="mt-1">
                  <div className="overflow-auto rounded-md border bg-muted/30 p-4 text-sm">
                    <MarkdownPreview
                      remarkPlugins={[remarkBreaks]}
                      source={selectedFormula.fangText}
                      wrapperElement={
                        colorMode ? {"data-color-mode": colorMode} : undefined
                      }
                    />
                  </div>
                </dd>
              </div>
            </dl>

            {/* ---- 组成面板 ---- */}
            <div className="border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold">{t("fangYao.bodiesTitle")}</h3>
                <Button
                  disabled={saving || selectedFormula.isDeleted}
                  onClick={startCreateBody}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlusIcon aria-hidden="true" />
                  {t("fangYao.newBody")}
                </Button>
              </div>

              {bodyLoading && (
                <p className="mt-2 text-sm text-muted-foreground">…</p>
              )}
              {bodyError && (
                <p className="mt-2 text-sm text-destructive">{bodyError}</p>
              )}
              {!bodyLoading && !bodyError && liveBodies.length === 0 && (
                <p className="mt-2 text-sm text-muted-foreground">{t("fangYao.bodiesEmpty")}</p>
              )}

              <ul className="mt-3 space-y-2">
                {liveBodies.map((body) => (
                  <li
                    className="rounded-[10px] border p-3"
                    key={body.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {/* 序号 / 内容(药名) / 用量 / 炮制 / 重量 单行显示（只读紧凑布局）。
                          有值才显示；amount 内嵌 $x{} 原样（whitespace-pre-wrap）。 */}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-mono text-xs text-muted-foreground">
                          {t("fangYao.bodyPositionLabel")} {body.position}
                        </span>
                        <span className="font-medium">{body.showName || "—"}</span>
                        {body.amount && (
                          <span className="whitespace-pre-wrap text-muted-foreground">
                            {t("fangYao.bodyAmountLabel")}：{body.amount}
                          </span>
                        )}
                        {body.extraProcess && (
                          <span className="text-muted-foreground">
                            {t("fangYao.bodyExtraProcessLabel")}：{body.extraProcess}
                          </span>
                        )}
                        {body.weight && (
                          <span className="text-muted-foreground">
                            {t("fangYao.bodyWeightLabel")}：{body.weight}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          aria-label={t("fangYao.editBody")}
                          onClick={() => startEditBody(body)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <PencilIcon aria-hidden="true" />
                        </Button>
                        <Button
                          aria-label={t("fangYao.deleteAction")}
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
                    {bodyConfirming?.id === body.id && (
                      <div className="mt-2 space-y-2 rounded-lg border border-destructive p-3">
                        <p className="text-sm">{t("fangYao.confirmBodyDelete")}</p>
                        <div className="flex gap-2">
                          <Button
                            disabled={saving}
                            onClick={() => void removeBody(body)}
                            size="sm"
                            type="button"
                            variant="destructive"
                          >
                            {t("fangYao.deleteAction")}
                          </Button>
                          <Button
                            onClick={() => setBodyConfirming(null)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {t("fangYao.cancelAction")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              {/* 已软删的组成：折叠，只能物理删除（同方剂口径）。 */}
              {deletedBodies.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-muted-foreground">
                    {t("fangYao.deletedChip")} {deletedBodies.length}
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {deletedBodies.map((body) => (
                      <li
                        className="flex items-center justify-between gap-2 rounded-[10px] px-2 py-1 text-sm text-muted-foreground"
                        key={body.id}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {t("fangYao.bodyPositionLabel")} {body.position}
                        </span>
                        <Button
                          aria-label={t("fangYao.purgeAction")}
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
                    {t("fangYao.confirmPurge", {
                      name: `${t("fangYao.bodyPositionLabel")} ${bodyConfirmingPurge.position}`,
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
                      {t("fangYao.purgeAction")}
                    </Button>
                    <Button
                      onClick={() => setBodyConfirmingPurge(null)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("fangYao.cancelAction")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!selectedFormula && !creating && (
          <p className="text-sm text-muted-foreground">{t("fangYao.noBodiesSelected")}</p>
        )}

        {/* 表单只在新手新建或编辑一条存活方剂时出现；编辑已软删方剂不给入口。 */}
        {(creating || (editing && selectedFormula && !selectedFormula.isDeleted)) && (
          <FangForm
            creating={creating}
            form={form}
            onCancel={cancel}
            onSave={() => void save()}
            saving={saving}
            setForm={setForm}
            title={creating ? t("fangYao.newFormula") : t("fangYao.editFormula")}
          />
        )}

        {confirming && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">{t("fangYao.confirmDelete")}</p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void remove(confirming)}
                type="button"
                variant="destructive"
              >
                {t("fangYao.deleteAction")}
              </Button>
              <Button
                onClick={() => setConfirming(null)}
                type="button"
                variant="ghost"
              >
                {t("fangYao.cancelAction")}
              </Button>
            </div>
          </div>
        )}

        {confirmingPurge && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">
              {t("fangYao.confirmPurge", {
                name: confirmingPurge.fangName || t("fangYao.untitled"),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void purge(confirmingPurge)}
                type="button"
                variant="destructive"
              >
                {t("fangYao.purgeAction")}
              </Button>
              <Button
                onClick={() => setConfirmingPurge(null)}
                type="button"
                variant="ghost"
              >
                {t("fangYao.cancelAction")}
              </Button>
            </div>
          </div>
        )}
      </section>
      </AdminTreeNavLayout>

      {/* 组成编辑/新建弹层：挂在布局之外，避免被左栏卡片裁剪或随栏滚动。
          关闭复用 cancelBody，保存中禁关（closeDisabled）。 */}
      <AdminDialog
        closeDisabled={saving}
        contentClassName={BODY_DIALOG_CONTENT_CLASS}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) cancelBody();
        }}
        open={bodyCreating || bodyEditingId !== null}
        title={bodyCreating ? t("fangYao.newBody") : t("fangYao.editBody")}
      >
        <BodyForm
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
