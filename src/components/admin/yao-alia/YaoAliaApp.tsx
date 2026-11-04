import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import {ChevronRightIcon, PencilIcon, Trash2Icon} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import {AdminGroupTree} from "@/components/admin/shared/AdminGroupTree";
import {AdminTreeNavLayout} from "@/components/admin/shared/AdminTreeNavLayout";
import {AdminTreeSearchInput} from "@/components/admin/shared/AdminTreeSearchInput";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {YaoAliaAdmin, YaoAliaBoard} from "@/shared/YaoAlia";

/** 别名表单状态：两列都必填（NOT NULL），`isEnable` 默认开（源 47/47 全 1）。 */
interface YaoAliaFormState {
  bieMing: string;
  yaoName: string;
  isEnable: boolean;
}

const EMPTY_FORM: YaoAliaFormState = {
  bieMing: "",
  yaoName: "",
  isEnable: true,
};

function formFromEntry(entry: YaoAliaAdmin): YaoAliaFormState {
  return {
    bieMing: entry.bieMing,
    yaoName: entry.yaoName,
    isEnable: entry.isEnable,
  };
}

function formToPayload(form: YaoAliaFormState): Record<string, unknown> {
  return {
    bieMing: form.bieMing.trim(),
    yaoName: form.yaoName.trim(),
    isEnable: form.isEnable,
  };
}

/** 客户端兜底：别名与正名都必填。真正的校验以服务端 Zod 为准（`@/shared/YaoAlia`）。 */
function validateForm(form: YaoAliaFormState): boolean {
  return form.bieMing.trim().length > 0 && form.yaoName.trim().length > 0;
}

/** 表单：新建时置顶渲染，编辑时替换详情。 */
function YaoAliaForm({
  form,
  setForm,
  saving,
  onSave,
  onCancel,
  title,
}: {
  form: YaoAliaFormState;
  setForm: Dispatch<SetStateAction<YaoAliaFormState>>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const {t} = useTranslation();
  const set = (key: keyof YaoAliaFormState, value: string | boolean) =>
    setForm((current) => ({...current, [key]: value}));
  return (
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <AdminInput
          label={t("yaoAlia.bieMingLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("bieMing", event.target.value)}
          value={form.bieMing}
        />
        <AdminInput
          label={t("yaoAlia.yaoNameLabel")}
          onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set("yaoName", event.target.value)}
          value={form.yaoName}
        />
      </div>
      <div className="mt-5">
        <AdminSwitch
          checked={form.isEnable}
          label={t("yaoAlia.isEnableLabel")}
          onCheckedChange={(checked) => set("isEnable", checked)}
        />
      </div>
      <div className="mt-5 flex gap-2">
        <Button disabled={saving} onClick={onSave} type="button">
          {t("yaoAlia.saveAction")}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("yaoAlia.cancelAction")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 独立「药材别名」看板（ADR-0064）：只读写 `yao_alia` 一张表。
 *
 * 与既有 `/admin/aliases/` 三态看板（items 派生 + `ext_tcm_aliases` 覆盖/隐藏 +
 * App 端点缓存）并行共存、互不读写：这里不 import tcm 读层、不清公共缓存、
 * 不碰 items/channels/settings。
 *
 * 左栏按正名 `yaoName` **只读派生**分组（30 个正名 / 47 行），零 settings 读写、
 * 零分组管理弹层、零改派——编辑正名后分组即时重算，这是模块的核心解耦点
 * （ADR-0064 决策 3）。删除分两步：软删写 `deleted_at`，已软删的行只能物删。
 */
export default function YaoAliaApp() {
  const {t} = useTranslation();
  const [board, setBoard] = useState<YaoAliaBoard>({entries: []});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 右栏是否处于编辑态。false = 只读详情，true = 表单可改。 */
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<YaoAliaAdmin | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState<YaoAliaAdmin | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [form, setForm] = useState<YaoAliaFormState>(EMPTY_FORM);
  // 左栏树搜索：有查询词时每组只留命中别名，含命中的组强制展开。
  const [treeSearch, setTreeSearch] = useState("");
  const searchActive = treeSearch.trim().length > 0;
  const searchQuery = treeSearch.trim().toLowerCase();

  const entries = board.entries;
  const liveEntries = useMemo(
    () => entries.filter((entry) => !entry.isDeleted),
    [entries],
  );
  const deletedEntries = useMemo(
    () => entries.filter((entry) => entry.isDeleted),
    [entries],
  );

  /** 回到只读详情：退出编辑/新建、清空表单。`clearSelection` = 连选中的别名一起清。 */
  const resetDetail = (clearSelection: boolean) => {
    setCreating(false);
    setEditing(false);
    setForm(EMPTY_FORM);
    if (clearSelection) setSelectedId(null);
  };

  /**
   * 左栏分组：从存活行按 `yaoName` 派生，组序 = 首次出现序（`loadYaoAliaBoard`
   * 已按 `yao_alia_no` 排序，与源数据同序）。分组键加 `name:` 前缀隔离——
   * 同一棵树的键必须唯一，而且组键不能与叶子 id 撞。
   */
  const nameGroups = useMemo(() => {
    const grouped = new Map<string, YaoAliaAdmin[]>();
    for (const entry of liveEntries) {
      const bucket = grouped.get(entry.yaoName);
      if (bucket) bucket.push(entry);
      else grouped.set(entry.yaoName, [entry]);
    }
    return [...grouped.entries()].map(([name, members]) => ({
      key: `name:${name}`,
      name,
      members,
    }));
  }, [liveEntries]);

  /** 树节点：搜索态每组只留命中别名（别名/正名/序号），没命中的组整组不传。
   *  徽章 count = visible.length（与该组 leaves 一致）。
   *  叶子两栏：label = 别名，description = 序号（正名已是组头，不再重复）。 */
  const treeGroups = useMemo(
    () => nameGroups
      .map((group) => {
        const visible = searchActive
          ? group.members.filter((entry) =>
              entry.bieMing.toLowerCase().includes(searchQuery)
              || entry.yaoName.toLowerCase().includes(searchQuery)
              || String(entry.yaoAliaNo).includes(searchQuery))
          : group.members;
        return {
          count: visible.length,
          key: group.key,
          label: group.name || t("yaoAlia.untitled"),
          leaves: visible.map((entry) => ({
            description: `#${entry.yaoAliaNo}`,
            id: entry.id,
            label: entry.bieMing || t("yaoAlia.untitled"),
          })),
        };
      })
      .filter((group) => !searchActive || group.leaves.length > 0),
    [nameGroups, searchActive, searchQuery, t],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxYaoAlia());
      const data = await response.json().catch(() => ({})) as YaoAliaBoard &
        Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("yaoAlia.loadFailed")));
      setBoard({
        entries: Array.isArray(data.entries) ? data.entries : [],
      });
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("yaoAlia.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedEntry = selectedId
    ? entries.find((entry) => entry.id === selectedId) ?? null
    : null;

  // 点分组头：手风琴单展开/收起，只切展开态、不自动选中该组任何一条。
  const toggleGroup = (key: string) => {
    setExpandedKey(expandedKey === key ? null : key);
  };

  /** 树里点一条别名：只读详情（已软删的行也在树外折叠区里选中）。 */
  const selectEntry = (id: string) => {
    if (!entries.some((entry) => entry.id === id)) return;
    setSelectedId(id);
    resetDetail(false);
  };

  /** 新建：清空选中，右栏出空白表单；正名默认取当前展开的组（少打一次字）。 */
  const startCreate = () => {
    const currentName = expandedKey?.startsWith("name:")
      ? expandedKey.slice("name:".length)
      : "";
    setCreating(true);
    setEditing(true);
    setSelectedId(null);
    setConfirming(null);
    setConfirmingPurge(null);
    setForm({...EMPTY_FORM, yaoName: currentName});
  };

  const startEdit = () => {
    const entry = selectedEntry;
    if (!entry || entry.isDeleted) return;
    setCreating(false);
    setEditing(true);
    setForm(formFromEntry(entry));
  };

  /** 取消：新建回退到未选中引导页；编辑回退到只读详情。 */
  const cancel = () => {
    resetDetail(!selectedEntry);
  };

  const save = async () => {
    if (!validateForm(form)) {
      showToast(t("errors.yaoAlia.invalidInput"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = selectedId
        ? await fetch(ADMIN_URLS.ajaxYaoAliaItem(selectedId), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "PUT",
          })
        : await fetch(ADMIN_URLS.ajaxYaoAlia(), {
            body: JSON.stringify(formToPayload(form)),
            headers: {"content-type": "application/json"},
            method: "POST",
          });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("yaoAlia.saveFailed")));
      showToast(t("saveAction.saved"), "success");
      // 保存成功回到只读详情：编辑保持在原别名，新建选中新返回的那条（响应含 id）。
      const savedId = selectedId ?? (typeof data.id === "string" ? data.id : null);
      setSelectedId(savedId);
      resetDetail(false);
      await load();
    } catch (saveError) {
      // 服务端错误是 i18n key（如 errors.yaoAlia.invalidInput），直接翻译。
      showToast(
        saveError instanceof Error ? t(saveError.message) : t("yaoAlia.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: YaoAliaAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxYaoAliaItem(entry.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("yaoAlia.deleteFailed")));
      showToast(t("saveAction.saved"), "success");
      setConfirming(null);
      if (selectedId === entry.id) resetDetail(true);
      await load();
    } catch (deleteError) {
      showToast(
        deleteError instanceof Error
          ? t(deleteError.message)
          : t("yaoAlia.deleteFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const purge = async (entry: YaoAliaAdmin) => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxYaoAliaPurge(entry.id), {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? t("yaoAlia.purgeFailed")));
      showToast(t("yaoAlia.purgeDone"), "success");
      setConfirmingPurge(null);
      setShowDeleted(false);
      if (selectedId === entry.id) resetDetail(true);
      await load();
    } catch (purgeError) {
      showToast(
        purgeError instanceof Error
          ? t(purgeError.message)
          : t("yaoAlia.purgeFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <AdminCollectionLoading label={t("yaoAlia.title")} />;
  }
  if (error) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <AdminTreeNavLayout
      nav={
        <>
          {/* 左栏：搜索 + 新建 + 按正名派生的分组树 + 已软删折叠区。分组、计数与
              过滤都在本组件算好传入，AdminGroupTree 只渲染传入状态。 */}
          <div className="p-1">
            <AdminTreeSearchInput
              ariaLabel={t("yaoAlia.searchAria")}
              onValueChange={setTreeSearch}
              placeholder={t("yaoAlia.searchPlaceholder")}
              value={treeSearch}
            />
          </div>
          <div className="flex items-center justify-end gap-2 px-1 pb-2">
            <Button disabled={saving} onClick={startCreate} size="sm" type="button">
              {t("yaoAlia.createYaoAlia")}
            </Button>
          </div>
          <AdminGroupTree
            emptyLeafText={t("yaoAlia.groupEmpty")}
            emptyTreeText={searchActive ? t("yaoAlia.searchNoResults") : undefined}
            expandedKeys={
              searchActive
                ? treeGroups.filter((group) => group.leaves.length > 0).map((group) => group.key)
                : expandedKey
                  ? [expandedKey]
                  : []
            }
            groups={treeGroups}
            onSelectLeaf={selectEntry}
            onToggleGroup={toggleGroup}
            root={{label: t("yaoAlia.treeRoot"), count: liveEntries.length}}
            selectedLeafId={selectedId}
          />

          {/* 已软删的别名不进树（树只导航存活行），折叠收在这里；选中后右栏给详情 +
              「物理删除」。本模块无恢复，所以没有编辑入口。 */}
          {deletedEntries.length > 0 && (
            <div className="mt-2 border-t pt-2">
              <button
                className="flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-sm text-muted-foreground transition hover:text-foreground"
                onClick={() => setShowDeleted((current) => !current)}
                type="button"
              >
                <span>
                  {t("yaoAlia.deletedCount", {count: deletedEntries.length})}
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className={`size-4 transition-transform ${showDeleted ? "rotate-90" : ""}`}
                />
              </button>
              {showDeleted && (
                <div className="space-y-1">
                  <p className="px-3 pb-1 text-xs text-muted-foreground">
                    {t("yaoAlia.purgeHint")}
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
                          onClick={() => selectEntry(entry.id)}
                          type="button"
                        >
                          {entry.bieMing || t("yaoAlia.untitled")}
                        </button>
                        <Button
                          aria-label={t("yaoAlia.purgeAction")}
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
      {/* 右栏：选中别名的只读详情；点「编辑」或左栏「新建」才换成表单。 */}
      <section className="space-y-4 rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
        {selectedEntry && !editing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {selectedEntry.bieMing || t("yaoAlia.untitled")}
              </h2>
              <div className="flex gap-2">
                {selectedEntry.isDeleted ? (
                  <Button
                    disabled={saving}
                    onClick={() => setConfirmingPurge(selectedEntry)}
                    type="button"
                    variant="destructive"
                  >
                    <Trash2Icon aria-hidden="true" />
                    {t("yaoAlia.purgeAction")}
                  </Button>
                ) : (
                  <>
                    <Button onClick={startEdit} type="button" variant="outline">
                      <PencilIcon aria-hidden="true" />
                      {t("yaoAlia.editAction")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => setConfirming(selectedEntry)}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2Icon aria-hidden="true" />
                      {t("yaoAlia.deleteAction")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t("yaoAlia.bieMingLabel")}</dt>
                <dd className="text-sm font-medium">
                  {selectedEntry.bieMing || t("yaoAlia.untitled")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("yaoAlia.yaoNameLabel")}</dt>
                <dd className="text-sm">{selectedEntry.yaoName || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("yaoAlia.noLabel")}</dt>
                <dd className="text-sm">{selectedEntry.yaoAliaNo}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("yaoAlia.isEnableLabel")}</dt>
                <dd className="text-sm">
                  {selectedEntry.isEnable
                    ? t("yaoAlia.enableOn")
                    : t("yaoAlia.enableOff")}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {/* 表单只在新建或编辑一条存活别名时出现；编辑已软删别名不给入口。 */}
        {(creating || (editing && selectedEntry && !selectedEntry.isDeleted)) && (
          <YaoAliaForm
            form={form}
            onCancel={cancel}
            onSave={() => void save()}
            saving={saving}
            setForm={setForm}
            title={creating ? t("yaoAlia.newYaoAlia") : t("yaoAlia.editYaoAlia")}
          />
        )}

        {confirming && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">{t("yaoAlia.confirmDelete")}</p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void remove(confirming)}
                type="button"
                variant="destructive"
              >
                {t("yaoAlia.deleteAction")}
              </Button>
              <Button onClick={() => setConfirming(null)} type="button" variant="ghost">
                {t("yaoAlia.cancelAction")}
              </Button>
            </div>
          </div>
        )}

        {confirmingPurge && (
          <div className="space-y-3 rounded-lg border border-destructive p-4">
            <p className="text-sm">
              {t("yaoAlia.confirmPurge", {
                name: confirmingPurge.bieMing || t("yaoAlia.untitled"),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={saving}
                onClick={() => void purge(confirmingPurge)}
                type="button"
                variant="destructive"
              >
                {t("yaoAlia.purgeAction")}
              </Button>
              <Button
                onClick={() => setConfirmingPurge(null)}
                type="button"
                variant="ghost"
              >
                {t("yaoAlia.cancelAction")}
              </Button>
            </div>
          </div>
        )}
      </section>
    </AdminTreeNavLayout>
  );
}
