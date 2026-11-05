import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import {PencilIcon, Trash2Icon} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import AdminInput from "@/components/admin/shared/AdminInput";
import {AdminTreeNavLayout} from "@/components/admin/shared/AdminTreeNavLayout";
import {AdminTreeSearchInput} from "@/components/admin/shared/AdminTreeSearchInput";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {Textarea} from "@/components/ui/textarea";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {
  type ZhongYaoAdmin,
  type ZhongYaoBoard,
} from "@/shared/ZhongYao";

/**
 * 本草表单状态。`zhongYaoList` 以逗号分隔字符串承载（提交时 `split(',')` + trim，
 * 与迁移 0180 的 `JSON.stringify(split(',').map(trim))` 同口径）。
 * 无分组、无来源书、无展示图、无备注（对比 ADR-0060 ming-ci，ADR-0061 决策 2）。
 */
interface ZhongYaoFormState {
  zhongYaoName: string;
  zhongYaoBeiMing: string;
  zhongYaoText: string;
  zhongYaoList: string;
  isEnable: boolean;
}

const EMPTY_FORM: ZhongYaoFormState = {
  zhongYaoName: "",
  zhongYaoBeiMing: "",
  zhongYaoText: "",
  zhongYaoList: "",
  isEnable: true,
};

function formFromHerb(herb: ZhongYaoAdmin): ZhongYaoFormState {
  return {
    zhongYaoName: herb.zhongYaoName,
    zhongYaoBeiMing: herb.zhongYaoBeiMing ?? "",
    zhongYaoText: herb.zhongYaoText,
    zhongYaoList: herb.zhongYaoList.join(", "),
    isEnable: herb.isEnable,
  };
}

/** 逗号分隔的「别名词条」→ `string[]`：split + trim，滤掉空串（`[""]` 无意义）。
 *  空输入 → `[]`。与迁移 0180 的 `split(',').map(trim)` 同口径。 */
function listToPayload(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function formToPayload(form: ZhongYaoFormState): Record<string, unknown> {
  return {
    zhongYaoName: form.zhongYaoName.trim(),
    zhongYaoBeiMing: form.zhongYaoBeiMing.trim() || null,
    zhongYaoText: form.zhongYaoText,
    zhongYaoList: listToPayload(form.zhongYaoList),
    isEnable: form.isEnable,
  };
}

/** 客户端兜底：药名、本草内容必填。真正的校验以服务端 Zod 为准。 */
function validateForm(form: ZhongYaoFormState): boolean {
  if (!form.zhongYaoName.trim()) return false;
  if (!form.zhongYaoText.trim()) return false;
  return true;
}

/** 共享表单：新建时置顶渲染，编辑时在行内展开。无分组下拉、无来源书下拉。 */
function ZhongYaoForm({
  form,
  setForm,
  saving,
  onSave,
  onCancel,
  title,
}: {
  form: ZhongYaoFormState;
  setForm: Dispatch<SetStateAction<ZhongYaoFormState>>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const {t} = useTranslation();
  const set = (key: keyof ZhongYaoFormState, value: string | boolean) =>
    setForm((current) => ({...current, [key]: value}));
  return (
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <AdminInput
          label={t("zhongYao.nameLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("zhongYaoName", event.target.value)}
          value={form.zhongYaoName}
        />
        <AdminInput
          label={t("zhongYao.beiMingLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("zhongYaoBeiMing", event.target.value)}
          value={form.zhongYaoBeiMing}
        />
      </div>
      <div className="mt-5">
        <AdminInput
          label={t("zhongYao.listLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("zhongYaoList", event.target.value)}
          value={form.zhongYaoList}
        />
      </div>
      <div className="mt-5">
        {/* 本草内容：多行 + 标记原样存储（`$u{}`/`$q{}` 不解析，textarea）。 */}
        <label className="w-full">
          <div className="mb-2 text-sm font-semibold text-foreground">
            {t("zhongYao.textLabel")}
          </div>
          <Textarea
            className="w-full text-sm"
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              set("zhongYaoText", event.target.value)}
            rows={16}
            value={form.zhongYaoText}
          />
        </label>
      </div>
      <div className="mt-5">
        <AdminSwitch
          checked={form.isEnable}
          label={t("zhongYao.isEnableLabel")}
          onCheckedChange={(checked) => set("isEnable", checked)}
        />
      </div>
      <div className="mt-5 flex gap-2">
        <Button disabled={saving} onClick={onSave} type="button">
          {t("zhongYao.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("zhongYao.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 独立「本草」CRUD 看板（ADR-0061），**复用 `AdminTreeNavLayout` 两栏容器**。
 *
 * 与既有 `items`-中药（`tcm_kind='yao'` 行）是两个并行模块：这里只读写
 * `zhong_yao` 表，不碰 items/channels/ext_*。删除分两步——软删写 `deleted_at`
 * （行保留），已软删的行只能物理删除（本模块暂未提供恢复）。
 *
 * **无分组、无来源书**（ADR-0061 决策 2）：源实体无分类字段，不伪造分组。
 * 因此**不引 `AdminGroupTree`**——容器零业务、只有 `nav`/`children` 两个
 * ReactNode 槽，左栏放平铺列表完全合法（镜像 MingCiApp 的容器用法，去掉树
 * 与分组管理弹层）。左栏 = 搜索（名称/别名/内容）+ 按 `zhongYaoNo` 序的平铺
 * 条目（软删行灰显、只给物删）+ 新建；右栏 = 只读详情 / 表单。
 */
export default function ZhongYaoApp() {
  const {t} = useTranslation();
  const [board, setBoard] = useState<ZhongYaoBoard>({entries: []});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 右栏是否处于编辑态。false = 只读详情，true = 表单可改。 */
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<ZhongYaoAdmin | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState<ZhongYaoAdmin | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [form, setForm] = useState<ZhongYaoFormState>(EMPTY_FORM);
  // 左栏搜索（名称/别名/内容）。平铺列表，无分组展开态。
  const [listSearch, setListSearch] = useState("");
  const searchActive = listSearch.trim().length > 0;
  const searchQuery = listSearch.trim().toLowerCase();

  /** 回到只读详情：退出编辑/新建、清空表单。`clearSelection` = 连选中的本草一起清
   *  （删除/物理删除后无本草可看）；false = 保留选中、只退出表单（取消编辑回详情）。 */
  const resetDetail = (clearSelection: boolean) => {
    setCreating(false);
    setEditing(false);
    setForm(EMPTY_FORM);
    if (clearSelection) setSelectedId(null);
  };

  const entries = board.entries;
  const liveEntries = useMemo(
    () => entries.filter((entry) => !entry.isDeleted),
    [entries],
  );
  const deletedEntries = useMemo(
    () => entries.filter((entry) => entry.isDeleted),
    [entries],
  );

  /** 搜索过滤：名称 + 别名（BeiMing）+ 别名词条（List）+ 内容。按 `zhongYaoNo` 序
   *  （store 已 ORDER BY zhong_yao_no ASC，这里保持传入顺序）。 */
  const visibleEntries = useMemo(() => {
    if (!searchActive) return liveEntries;
    return liveEntries.filter((entry) =>
      (entry.zhongYaoName || "").toLowerCase().includes(searchQuery)
      || String(entry.zhongYaoNo).includes(searchQuery)
      || (entry.zhongYaoBeiMing || "").toLowerCase().includes(searchQuery)
      || entry.zhongYaoList.some((alias) => alias.toLowerCase().includes(searchQuery))
      || (entry.zhongYaoText || "").toLowerCase().includes(searchQuery));
  }, [liveEntries, searchActive, searchQuery]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxZhongYao());
      const data = await response.json().catch(() => ({})) as ZhongYaoBoard &
        Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("zhongYao.loadFailed")));
      setBoard({
        entries: Array.isArray(data.entries) ? data.entries : [],
      });
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("zhongYao.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 列表里点一条本草：只读详情。表单留空，编辑时才 formFromHerb 填充。 */
  const selectEntry = (id: string) => {
    const entry = liveEntries.find((item) => item.id === id);
    if (!entry) return;
    setSelectedId(entry.id);
    resetDetail(false);
  };

  /** 左栏工具栏「新建」：清空选中，右栏出空白表单（编辑态）。 */
  const startCreate = () => {
    setCreating(true);
    setEditing(true);
    setSelectedId(null);
    setForm({...EMPTY_FORM});
  };

  /** 详情页「编辑」：把当前选中的本草灌进表单，进入编辑态。 */
  const startEdit = () => {
    const herb = selectedHerb;
    if (!herb || herb.isDeleted) return;
    setCreating(false);
    setEditing(true);
    setForm(formFromHerb(herb));
  };

  /** 取消：新建回退到未选中引导页；编辑回退到只读详情。 */
  const cancel = () => {
    resetDetail(!selectedHerb);
  };

  const save = async () => {
    if (!validateForm(form)) {
      showToast(t("errors.zhongYao.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = selectedId
        ? await fetch(ADMIN_URLS.ajaxZhongYaoItem(selectedId), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxZhongYao(), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("zhongYao.saveFailed")));
      showToast(t("saveAction.saved"), "success");
      // 保存成功回到只读详情：编辑保持在原本草，新建选中新返回的那条（响应含 id）。
      const savedId = selectedId ?? (typeof data.id === "string" ? data.id : null);
      setSelectedId(savedId);
      resetDetail(false);
      await load();
    } catch (saveError) {
      showToast(
        saveError instanceof Error
          ? t(saveError.message)
          : t("zhongYao.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (herb: ZhongYaoAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxZhongYaoItem(herb.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("zhongYao.deleteFailed")));
      showToast(t("saveAction.saved"), "success");
      setConfirming(null);
      if (selectedId === herb.id) resetDetail(true);
      await load();
    } catch (deleteError) {
      showToast(
        deleteError instanceof Error
          ? t(deleteError.message)
          : t("zhongYao.deleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const purge = async (herb: ZhongYaoAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxZhongYaoPurge(herb.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("zhongYao.purgeFailed")));
      showToast(t("zhongYao.purgeDone"), "success");
      setConfirmingPurge(null);
      setShowDeleted(false);
      if (selectedId === herb.id) resetDetail(true);
      await load();
    } catch (purgeError) {
      showToast(
        purgeError instanceof Error
          ? t(purgeError.message)
          : t("zhongYao.purgeFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <AdminCollectionLoading label={t("zhongYao.title")} />;
  }
  if (error) {
    return (
      <AdminCollectionError
        message={error}
        retry={() => void load()}
      />
    );
  }

  const selectedHerb = selectedId
    ? liveEntries.find((entry) => entry.id === selectedId)
      ?? deletedEntries.find((entry) => entry.id === selectedId)
      ?? null
    : null;

  return (
    <>
      {/* 两栏壳（外层 flex + 左栏冻结卡 + 右栏主区）交给 AdminTreeNavLayout，
          本组件只提供 nav 与右栏内容（布局不认识业务）。无分组，nav 槽放平铺列表，
          不引 AdminGroupTree。 */}
      <AdminTreeNavLayout
        nav={
          <>
        {/* 左栏：搜索 + 平铺条目列表 + 新建。宽屏冻结在视口顶，
            列表长时栏内自行滚动，不随右栏内容往上滚。 */}
        <div className="p-1">
          <AdminTreeSearchInput
            ariaLabel={t("zhongYao.searchAria")}
            onValueChange={setListSearch}
            placeholder={t("zhongYao.searchPlaceholder")}
            value={listSearch}
          />
        </div>
        <div className="flex items-center justify-end px-1 pb-2">
          <Button
            disabled={saving}
            onClick={startCreate}
            size="sm"
            type="button"
          >
            {t("zhongYao.createZhongYao")}
          </Button>
        </div>
        {/* 平铺条目列表：按 `zhongYaoNo` 序（store 已排）。命中为空给提示。 */}
        <div className="space-y-1">
          {visibleEntries.length === 0 && searchActive && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {t("zhongYao.searchNoResults")}
            </p>
          )}
          {visibleEntries.map((entry) => {
            const isSelected = selectedId === entry.id;
            return (
              <button
                className={`flex w-full items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-left text-sm transition ${isSelected
                  ? "bg-muted font-medium text-foreground"
                  : "hover:bg-muted hover:text-foreground"}`}
                key={entry.id}
                onClick={() => selectEntry(entry.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">
                  {entry.zhongYaoName || t("zhongYao.untitled")}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {entry.zhongYaoNo}
                </span>
              </button>
            );
          })}
        </div>

        {/* 已软删的本草不进列表（列表只导航存活动物），折叠收在这里；选中后右栏给详情 +
            「物理删除」。本模块无恢复，所以没有编辑入口。 */}
        {deletedEntries.length > 0 && (
          <div className="mt-2 border-t pt-2">
            <button
              className="flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-sm text-muted-foreground transition hover:text-foreground"
              onClick={() => setShowDeleted((current) => !current)}
              type="button"
            >
              <span>
                {t("zhongYao.deletedChip")}
                <small className="ml-1 opacity-70">{deletedEntries.length}</small>
              </span>
            </button>
            {showDeleted && (
              <div className="space-y-1">
                <p className="px-3 pb-1 text-xs text-muted-foreground">
                  {t("zhongYao.purgeHint")}
                </p>
                {deletedEntries.map((entry) => {
                  const isSelected = selectedId === entry.id;
                  return (
                    <div
                      className={`flex items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-sm ${isSelected
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                      key={entry.id}
                    >
                      <button
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => {
                          setSelectedId(entry.id);
                          resetDetail(false);
                        }}
                        type="button"
                      >
                        {entry.zhongYaoName || t("zhongYao.untitled")}
                      </button>
                      <Button
                        aria-label={t("zhongYao.purgeAction")}
                        disabled={saving}
                        onClick={() => setConfirmingPurge(entry)}
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
      {/* 右栏：选中药材的只读详情（Label + 值）；点「编辑」或左栏「新建」才换成表单。
          未选中且非新建/编辑时右栏留空——不显示任何说明性提示。 */}
      <section className="space-y-4 rounded-[14px] border bg-card p-5 shadow-xs">
        {selectedHerb && !editing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {selectedHerb.zhongYaoName || t("zhongYao.untitled")}
              </h2>
              <div className="flex gap-2">
                {selectedHerb.isDeleted ? (
                  <Button
                    disabled={saving}
                    onClick={() => setConfirmingPurge(selectedHerb)}
                    type="button"
                    variant="destructive"
                  >
                    <Trash2Icon aria-hidden="true" />
                    {t("zhongYao.purgeAction")}
                  </Button>
                ) : (
                  <>
                    <Button
                      onClick={startEdit}
                      type="button"
                      variant="outline"
                    >
                      <PencilIcon aria-hidden="true" />
                      {t("zhongYao.editAction")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => setConfirming(selectedHerb)}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2Icon aria-hidden="true" />
                      {t("zhongYao.deleteAction")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">{t("zhongYao.nameLabel")}</dt>
                <dd className="text-sm font-medium">
                  {selectedHerb.zhongYaoName || t("zhongYao.untitled")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("zhongYao.beiMingLabel")}</dt>
                <dd className="text-sm">{selectedHerb.zhongYaoBeiMing || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("zhongYao.listLabel")}</dt>
                <dd className="text-sm">{selectedHerb.zhongYaoList.join("、") || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("zhongYao.isEnableLabel")}</dt>
                <dd className="text-sm">
                  {selectedHerb.isEnable
                    ? t("zhongYao.enableOn")
                    : t("zhongYao.enableOff")}
                </dd>
              </div>
              {selectedHerb.zhongYaoText && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("zhongYao.textLabel")}</dt>
                  {/* 标记原样显示不解析（`$u{}`/`$q{}` 是内容本体）。 */}
                  <dd className="whitespace-pre-wrap text-sm">{selectedHerb.zhongYaoText}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* 表单只在新手新建或编辑一条存活动物时出现；编辑已软删本草不给入口。 */}
        {(creating || (editing && selectedHerb && !selectedHerb.isDeleted)) && (
          <ZhongYaoForm
            form={form}
            onCancel={cancel}
            onSave={() => void save()}
            saving={saving}
            setForm={setForm}
            title={creating ? t("zhongYao.newZhongYao") : t("zhongYao.editZhongYao")}
          />
        )}

        {confirming && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">{t("zhongYao.confirmDelete")}</p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void remove(confirming)}
                type="button"
                variant="destructive"
              >
                {t("zhongYao.deleteAction")}
              </Button>
              <Button
                onClick={() => setConfirming(null)}
                type="button"
                variant="ghost"
              >
                {t("zhongYao.cancelAction")}
              </Button>
            </div>
          </div>
        )}

        {confirmingPurge && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">
              {t("zhongYao.confirmPurge", {
                name: confirmingPurge.zhongYaoName || t("zhongYao.untitled"),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void purge(confirmingPurge)}
                type="button"
                variant="destructive"
              >
                {t("zhongYao.purgeAction")}
              </Button>
              <Button
                onClick={() => setConfirmingPurge(null)}
                type="button"
                variant="ghost"
              >
                {t("zhongYao.cancelAction")}
              </Button>
            </div>
          </div>
        )}
      </section>
      </AdminTreeNavLayout>
    </>
  );
}
