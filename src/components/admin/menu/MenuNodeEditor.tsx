import {useEffect, useState} from "react";

import AdminSelect, {type AdminSelectOption} from "@/components/admin/shared/AdminSelect";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {useTranslation} from "@/client/i18n";
import {menuRowLabelKey} from "@/shared/AdminNavigation";
import type {AdminLanguage} from "@/shared/AdminLanguage";
import type {MenuUpdatePatch} from "@/shared/MenuAdminOps";
import {
  menuIconNoneDisabled,
  menuIconOptions,
  menuParentCandidates,
  menuParentSelectOptions,
  menuRowEffectiveLabel,
  menuSiblingPosition,
  type MenuRow,
} from "@/shared/MenuTreeView";

/**
 * 名称输入：受控 + 失焦提交。局部 state 承接输入，值变化时回填；
 * 「恢复默认」清空库名后输入框必须跟着清空，所以非受控 defaultValue 不适用。
 * 高度用 Input 默认的 `h-10`，与 AdminSelect 的 `min-h-10` 齐高。
 */
export function MenuNameInput({
  disabled,
  onCommit,
  placeholder,
  value,
}: {
  disabled: boolean;
  onCommit: (next: string | null) => void;
  placeholder: string;
  value: string | null;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);
  return (
    <Input
      className="w-full min-w-24 text-sm"
      disabled={disabled}
      maxLength={64}
      onBlur={() => {
        const next = draft.trim() || null;
        if (next !== (value ?? null)) onCommit(next);
      }}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      value={draft}
    />
  );
}

export interface MenuNodeEditorProps {
  busy: boolean;
  confirmPageParent: (parentCode: string | null) => boolean;
  language: AdminLanguage;
  onAddChildGroup: (parentCode: string) => void;
  onDelete: (row: MenuRow) => void;
  onField: (row: MenuRow, patch: MenuUpdatePatch) => void;
  onMove: (row: MenuRow, direction: "up" | "down") => void;
  onRestoreDefault: (row: MenuRow) => void;
  row: MenuRow;
  rows: MenuRow[];
}

/**
 * 右栏节点详情面板（v4）：树行里搬过来的全部编辑能力都在这里。
 *
 * 外壳与头部跟 rbac 右栏一致（`RbacApp/index.tsx` L406–497）：`section` 由管理页提供，
 * 这里从 `header`（名称 + mono code + 操作按钮组）开始；锁定提示条复用 rbac 的
 * `roleCodeLocked` 形态（L483–487），说明段复用 rbac description 的位置（L495–497）。
 *
 * `path` 与 `permission_code` 是只读区：可达性由迁移与页面守卫维护，本页不改。
 */
export function MenuNodeEditor({
  busy,
  confirmPageParent,
  language,
  onAddChildGroup,
  onDelete,
  onField,
  onMove,
  onRestoreDefault,
  row,
  rows,
}: MenuNodeEditorProps) {
  const {t, i18n} = useTranslation();

  // 同层兄弟序列里自己的位置，决定上/下移按钮禁用态（与服务端 move 同口径）。
  const {canDown, canUp} = menuSiblingPosition(rows, row.code);

  const label = menuRowEffectiveLabel(row, language, t);
  const hasCustomName = Boolean(row.nameZh || row.nameEn);

  // 内置默认名按各自列的语言取：中文名框显示中文默认名、英文名框显示英文默认名，
  // 与查看者当前界面语言无关——两个框各自说明自己这一列的默认值。
  const defaultNameZh = i18n.getFixedT("zh-CN")(menuRowLabelKey(row.code));
  const defaultNameEn = i18n.getFixedT("en")(menuRowLabelKey(row.code));

  // 分组可以没有图标；页面行已带图标时不给「无图标」入口，没带时给但禁用
  // （页面行的图标不允许清空，与旧版下拉同口径）。
  const iconOptions: AdminSelectOption[] = [
    ...(row.path === "" || row.icon === null
      ? [{label: t("menuAdmin.iconNone"), value: ""}]
      : []),
    ...menuIconOptions(t),
  ];
  const iconValue =
    iconOptions.find((option) => option.value === (row.icon ?? "")) ?? null;

  const parentOptions: AdminSelectOption[] = menuParentSelectOptions(
    menuParentCandidates(rows, row.code),
    language,
    t,
    t("menuAdmin.parentNone"),
  );
  const parentValue =
    parentOptions.find((option) => option.value === (row.parentCode ?? "")) ??
    null;

  return (
    <>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-foreground">{label}</h2>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{row.code}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={busy || !canUp}
            onClick={() => onMove(row, "up")}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("menuAdmin.moveUp")}
          </Button>
          <Button
            disabled={busy || !canDown}
            onClick={() => onMove(row, "down")}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("menuAdmin.moveDown")}
          </Button>
          {row.deletable && (
            <Button
              disabled={busy}
              onClick={() => onDelete(row)}
              size="sm"
              type="button"
              variant="destructive"
            >
              {t("menuAdmin.delete")}
            </Button>
          )}
          {row.path === "" && (
            <Button
              disabled={busy}
              onClick={() => onAddChildGroup(row.code)}
              size="sm"
              type="button"
            >
              {t("menuAdmin.addChildGroup")}
            </Button>
          )}
        </div>
      </header>

      {!row.deletable && (
        <p className="mb-4 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          {t("menuAdmin.lockedHint")}{" "}
          {t("menuAdmin.createGroupHint")}
        </p>
      )}

      <p className="mb-4 text-sm leading-6 text-muted-foreground">{t("menuAdmin.intro")}</p>

      <div className="grid gap-4">
        <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
          <span className="text-muted-foreground">{t("menuAdmin.nameZh")}</span>
          <MenuNameInput
            disabled={busy}
            onCommit={(next) => onField(row, {nameZh: next})}
            placeholder={`${t("menuAdmin.nameDefault")}${defaultNameZh}`}
            value={row.nameZh}
          />
        </label>
        <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
          <span className="text-muted-foreground">{t("menuAdmin.nameEn")}</span>
          <MenuNameInput
            disabled={busy}
            onCommit={(next) => onField(row, {nameEn: next})}
            placeholder={`${t("menuAdmin.nameDefault")}${defaultNameEn}`}
            value={row.nameEn}
          />
        </label>
        <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
          <span className="text-muted-foreground">{t("menuAdmin.icon")}</span>
          <AdminSelect
            ariaLabel={t("menuAdmin.icon")}
            disabled={busy}
            isOptionDisabled={(option) =>
              option.value === "" && menuIconNoneDisabled(row)
            }
            onChange={(option) => onField(row, {icon: option.value || null})}
            options={iconOptions}
            value={iconValue}
          />
        </label>
        <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
          <span className="text-muted-foreground">{t("menuAdmin.parent")}</span>
          <AdminSelect
            ariaLabel={t("menuAdmin.parent")}
            disabled={busy}
            onChange={(option) => {
              const next = option.value || null;
              // 受控控件：确认被拒时不发 op，值仍由 row.parentCode 派生，
              // 下拉自动保持原值（旧版原生 select 需要手动回写 DOM）。
              if (!confirmPageParent(next)) return;
              onField(row, {parentCode: next});
            }}
            options={parentOptions}
            value={parentValue}
          />
        </label>
        <div className="flex items-center gap-2 text-sm">
          <Switch
            aria-label={t("menuAdmin.visible")}
            checked={row.visible}
            disabled={busy}
            onCheckedChange={(checked) => onField(row, {isVisible: checked})}
          />
          <span className="text-muted-foreground">{t("menuAdmin.visible")}</span>
        </div>
      </div>

      <div className="mt-4 rounded-md border bg-background p-3">
        <div className="grid gap-1.5 text-sm">
          <span className="text-muted-foreground">{t("menuAdmin.pathReadonly")}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.path || "—"}</span>
        </div>
        <div className="mt-2 grid gap-1.5 text-sm">
          <span className="text-muted-foreground">
            {t("menuAdmin.permissionCodeReadonly")}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {row.permissionCode ?? "—"}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t("menuAdmin.lockedHint")}</p>
      </div>

      {hasCustomName && (
        <div className="mt-4">
          <Button
            disabled={busy}
            onClick={() => onRestoreDefault(row)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("menuAdmin.restoreDefault")}
          </Button>
        </div>
      )}
    </>
  );
}

/** 新建分组表单的草稿态（与管理页 state 同形状）。 */
export interface MenuGroupDraft {
  code: string;
  icon: string;
  nameEn: string;
  nameZh: string;
  parentCode: string;
}

/**
 * 右栏新建分组表单（v4）：从页面顶部搬进来，形态复刻 rbac 侧栏新建角色
 * （`rounded-[10px] border bg-background p-2` + `size="xs"` 的保存/取消，L347–402）。
 * 树保持可见，创建期间仍可点其他行（管理页会取消创建并切换选中）。
 */
export function MenuGroupCreator({
  busy,
  draft,
  language,
  onCancel,
  onDraftChange,
  onSubmit,
  rows,
}: {
  busy: boolean;
  draft: MenuGroupDraft;
  language: AdminLanguage;
  onCancel: () => void;
  onDraftChange: (patch: Partial<MenuGroupDraft>) => void;
  onSubmit: () => void;
  rows: MenuRow[];
}) {
  const {t} = useTranslation();
  // 新建分组没有「无图标」入口：草稿默认带 `list` 图标，与旧版下拉同口径。
  const creatorIconOptions: AdminSelectOption[] = menuIconOptions(t);
  const creatorParentOptions: AdminSelectOption[] = menuParentSelectOptions(
    rows,
    language,
    t,
    t("menuAdmin.parentNone"),
  );
  return (
    <>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-foreground">{t("menuAdmin.createGroup")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("menuAdmin.createGroupHint")}
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-2 rounded-[10px] border bg-background p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            autoFocus
            className="w-44"
            disabled={busy}
            onChange={(event) => onDraftChange({code: event.target.value})}
            placeholder={t("menuAdmin.codePlaceholder")}
            value={draft.code}
          />
          <Input
            className="w-36"
            disabled={busy}
            onChange={(event) => onDraftChange({nameZh: event.target.value})}
            placeholder={t("menuAdmin.nameZhPlaceholder")}
            value={draft.nameZh}
          />
          <Input
            className="w-36"
            disabled={busy}
            onChange={(event) => onDraftChange({nameEn: event.target.value})}
            placeholder={t("menuAdmin.nameEnPlaceholder")}
            value={draft.nameEn}
          />
          <div className="w-36">
            <AdminSelect
              ariaLabel={t("menuAdmin.icon")}
              disabled={busy}
              onChange={(option) => onDraftChange({icon: option.value})}
              options={creatorIconOptions}
              placeholder={t("menuAdmin.icon")}
              value={
                creatorIconOptions.find(({value}) => value === draft.icon) ?? null
              }
            />
          </div>
          <div className="w-44">
            <AdminSelect
              ariaLabel={t("menuAdmin.parent")}
              disabled={busy}
              onChange={(option) => onDraftChange({parentCode: option.value})}
              options={creatorParentOptions}
              value={
                creatorParentOptions.find(
                  ({value}) => value === draft.parentCode,
                ) ?? null
              }
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={onSubmit} size="xs" type="button">
            {t("menuAdmin.save")}
          </Button>
          <Button
            disabled={busy}
            onClick={onCancel}
            size="xs"
            type="button"
            variant="ghost"
          >
            {t("menuAdmin.cancel")}
          </Button>
        </div>
      </div>
    </>
  );
}
