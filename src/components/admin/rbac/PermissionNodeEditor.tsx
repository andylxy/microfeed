import {useEffect, useState} from "react";

import AdminSelect, {type AdminSelectOption} from "@/components/admin/shared/AdminSelect";
import {PermissionDocBlock} from "@/components/admin/rbac/PermissionDocBlock";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {useTranslation} from "@/client/i18n";
import type {AdminLanguage} from "@/shared/AdminLanguage";
import {menuIconOptions} from "@/shared/MenuIconNames";
import type {PermissionUpdatePatch} from "@/shared/PermissionTreeOps";
import {
  normalizeEntryPath,
  permissionParentCandidates,
  permissionSiblingPosition,
  type PermissionNodeRowWithMeta,
} from "@/shared/PermissionTreeOps";
import {rbacTreeLabel} from "@/shared/Rbac";

/**
 * 名称输入：受控 + 失焦提交。局部 state 承接输入，值变化时回填。
 * 高度用 Input 默认的 `h-10`，与 AdminSelect 的 `min-h-10` 齐高。
 */
function PermissionNameInput({
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

/**
 * 路径输入：受控 + 失焦提交。与名称输入同款，提交前去掉首尾斜杠——`path` 相对
 * `/admin/`，带斜杠会让侧栏导出的链接变形。
 */
function PermissionPathInput({
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
      className="w-full min-w-24 font-mono text-sm"
      disabled={disabled}
      maxLength={128}
      onBlur={() => {
        const next = normalizeEntryPath(draft);
        if (next !== (value ?? null)) onCommit(next);
      }}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      value={draft}
    />
  );
}

export interface PermissionNodeEditorProps {
  busy: boolean;
  confirmReparent: (row: PermissionNodeRowWithMeta, parentCode: string | null) => boolean;
  language: AdminLanguage;
  onAddChildGroup: (parentCode: string) => void;
  onDelete: (row: PermissionNodeRowWithMeta) => void;
  onField: (row: PermissionNodeRowWithMeta, patch: PermissionUpdatePatch) => void;
  onMove: (row: PermissionNodeRowWithMeta, direction: "up" | "down") => void;
  /** 权限目录（`ext_permissions`）：code 行的标题与只读名取自这里。 */
  permissionNames: Map<string, string>;
  row: PermissionNodeRowWithMeta;
  rows: PermissionNodeRowWithMeta[];
}

/**
 * 父级下拉 + 显隐开关：分组/页面行与码行共用的两项控件。
 * 码结点按 ADR-0038 只能改这两项（名字与图标取权限目录，不开放编辑），
 * 所以它也必须渲染这一块——否则码行详情面板只剩只读卡片。
 */
function ParentAndVisibility({
  busy,
  confirmReparent,
  onField,
  parentOptions,
  parentValue,
  row,
}: {
  busy: boolean;
  confirmReparent: (row: PermissionNodeRowWithMeta, parentCode: string | null) => boolean;
  onField: (row: PermissionNodeRowWithMeta, patch: PermissionUpdatePatch) => void;
  parentOptions: AdminSelectOption[];
  parentValue: AdminSelectOption | null;
  row: PermissionNodeRowWithMeta;
}) {
  const {t} = useTranslation();
  return (
    <div className="grid gap-4">
      <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
        <span className="text-muted-foreground">{t("rbac.permissionTree.parent")}</span>
        <AdminSelect
          ariaLabel={t("rbac.permissionTree.parent")}
          disabled={busy}
          onChange={(option) => {
            const next = option.value || null;
            // 受控控件：确认被拒时不发 op，值仍由 row.parentCode 派生，
            // 下拉自动保持原值。
            if (!confirmReparent(row, next)) return;
            onField(row, {parentCode: next});
          }}
          options={parentOptions}
          value={parentValue}
        />
      </label>
      <div className="flex items-center gap-2 text-sm">
        <Switch
          aria-label={t("rbac.permissionTree.visible")}
          checked={row.visible}
          disabled={busy}
          onCheckedChange={(checked) => onField(row, {isVisible: checked})}
        />
        <span className="text-muted-foreground">{t("rbac.permissionTree.visible")}</span>
      </div>
    </div>
  );
}

/**
 * 右栏节点详情面板：树行里搬过来的全部编辑能力都在这里。
 *
 * 与菜单管理的 `MenuNodeEditor` 对偶，差异全在能力边界（ADR-0038 D4）：
 *   - `code` 行（权限码节点）名字与图标不开放，只能换父级与显隐——权限码是
 *     代码常量，它的展示名取权限目录（`ext_permissions.name`）；
 *   - 父级下拉对 code 行只列页面行（权限码只挂页面下）；
 *   - `source` 标识区分迁移种子行（只可隐藏）与管理页自建行（可删）。
 */
export function PermissionNodeEditor({
  busy,
  confirmReparent,
  language,
  onAddChildGroup,
  onDelete,
  onField,
  onMove,
  permissionNames,
  row,
  rows,
}: PermissionNodeEditorProps) {
  const {t} = useTranslation();

  // 同层兄弟序列里自己的位置，决定上/下移按钮禁用态（与服务端 move 同口径）。
  const {canDown, canUp} = permissionSiblingPosition(rows, row.code);

  // code 行的标题取权限目录名；组/页行走双名 → i18n 兜底键 → code。
  const isCodeRow = row.kind === "code";
  const label = isCodeRow
    ? permissionNames.get(row.permissionCode ?? row.code) ?? row.code
    : rbacTreeLabel(row, language, t);

  // 图标：任意行都能清空，清空后管理页按无图标显示。
  const iconOptions: AdminSelectOption[] = [
    {label: t("rbac.permissionTree.iconNone"), value: ""},
    ...menuIconOptions(t),
  ];
  const iconValue =
    iconOptions.find((option) => option.value === (row.icon ?? "")) ?? null;

  const parentCandidates = permissionParentCandidates(rows, row.code);
  // 只有分组行能停在根层；页面行与权限码行必须选一个父级。
  const parentOptions: AdminSelectOption[] = [
    ...(row.kind === "group"
      ? [{label: t("rbac.permissionTree.parentNone"), value: ""}]
      : []),
    ...parentCandidates.map((candidate) => ({
      label: rbacTreeLabel(candidate, language, t),
      value: candidate.code,
    })),
  ];
  const parentValue =
    parentOptions.find((option) => option.value === (row.parentCode ?? "")) ?? null;

  // 页面行的入口门码只读展示：它决定侧栏可见性，改动会让入口与请求守卫不一致。

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
            {t("rbac.permissionTree.moveUp")}
          </Button>
          <Button
            disabled={busy || !canDown}
            onClick={() => onMove(row, "down")}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("rbac.permissionTree.moveDown")}
          </Button>
          {row.deletable && (
            <Button
              disabled={busy}
              onClick={() => onDelete(row)}
              size="sm"
              type="button"
              variant="destructive"
            >
              {t("rbac.permissionTree.delete")}
            </Button>
          )}
          {!isCodeRow && (
            <Button
              disabled={busy}
              onClick={() => onAddChildGroup(row.code)}
              size="sm"
              type="button"
            >
              {t("rbac.permissionTree.addChildGroup")}
            </Button>
          )}
        </div>
      </header>

      <PermissionDocBlock row={row} />

      {isCodeRow ? (
        <>
          <div className="rounded-md border bg-background p-3">
            <div className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">
                {t("rbac.permissionTree.permissionNameReadonly")}
              </span>
              <span>{label}</span>
            </div>
            <div className="mt-2 grid gap-1.5 text-sm">
              <span className="text-muted-foreground">
                {t("rbac.permissionTree.permissionCodeReadonly")}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {row.permissionCode ?? "—"}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("rbac.permissionTree.codeRowHint")}
            </p>
          </div>
          <div className="mt-4">
            <ParentAndVisibility
              busy={busy}
              confirmReparent={confirmReparent}
              onField={onField}
              parentOptions={parentOptions}
              parentValue={parentValue}
              row={row}
            />
          </div>
        </>
      ) : (
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
            <span className="text-muted-foreground">{t("rbac.permissionTree.nameZh")}</span>
            <PermissionNameInput
              disabled={busy}
              onCommit={(next) => onField(row, {nameZh: next})}
              placeholder={t("rbac.permissionTree.nameZhPlaceholder")}
              value={row.nameZh}
            />
          </label>
          <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
            <span className="text-muted-foreground">{t("rbac.permissionTree.nameEn")}</span>
            <PermissionNameInput
              disabled={busy}
              onCommit={(next) => onField(row, {nameEn: next})}
              placeholder={t("rbac.permissionTree.nameEnPlaceholder")}
              value={row.nameEn}
            />
          </label>
          <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
            <span className="text-muted-foreground">{t("rbac.permissionTree.icon")}</span>
            <AdminSelect
              ariaLabel={t("rbac.permissionTree.icon")}
              disabled={busy}
              onChange={(option) => onField(row, {icon: option.value || null})}
              options={iconOptions}
              value={iconValue}
            />
          </label>
          {row.kind === "page" && (
            <>
              <label className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
                <span className="text-muted-foreground">{t("rbac.permissionTree.path")}</span>
                <PermissionPathInput
                  disabled={busy}
                  onCommit={(next) => onField(row, {path: next})}
                  placeholder={t("rbac.permissionTree.pathPlaceholder")}
                  value={row.path}
                />
              </label>
              <div className="grid gap-1.5 text-sm sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start sm:gap-4">
                <span className="text-muted-foreground">
                  {t("rbac.permissionTree.entryCode")}
                </span>
                <div className="grid gap-1.5">
                  <span className="font-mono text-xs">
                    {row.entryCode ?? t("rbac.permissionTree.entryCodeNone")}
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {t("rbac.permissionTree.entryCodeHint")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("rbac.permissionTree.entryCodeReadonlyHint")}
                  </p>
                </div>
              </div>
            </>
          )}
          <ParentAndVisibility
            busy={busy}
            confirmReparent={confirmReparent}
            onField={onField}
            parentOptions={parentOptions}
            parentValue={parentValue}
            row={row}
          />
        </div>
      )}

      <div className="mt-4 rounded-md border bg-background p-3">
        <div className="grid gap-1.5 text-sm">
          <span className="text-muted-foreground">{t("rbac.permissionTree.source")}</span>
          <span className="text-xs text-muted-foreground">
            {row.source === "seed"
              ? t("rbac.permissionTree.sourceSeed")
              : t("rbac.permissionTree.sourceCustom")}
          </span>
        </div>
        {row.source === "seed" && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("rbac.permissionTree.lockedHint")}
          </p>
        )}
      </div>
    </>
  );
}

/** 新建分组表单的草稿态（与管理页 state 同形状）。 */
export interface PermissionGroupDraft {
  code: string;
  icon: string;
  nameEn: string;
  nameZh: string;
  parentCode: string;
}

/**
 * 右栏新建分组表单：形态对偶菜单管理的 `MenuGroupCreator`（复刻角色 tab
 * 侧栏新建角色的外壳）。树保持可见，创建期间仍可点其他行（管理页会取消
 * 创建并切换选中）。
 */
export function PermissionGroupCreator({
  busy,
  draft,
  language,
  onCancel,
  onDraftChange,
  onSubmit,
  rows,
}: {
  busy: boolean;
  draft: PermissionGroupDraft;
  language: AdminLanguage;
  onCancel: () => void;
  onDraftChange: (patch: Partial<PermissionGroupDraft>) => void;
  onSubmit: () => void;
  rows: PermissionNodeRowWithMeta[];
}) {
  const {t} = useTranslation();
  // 新建分组没有「无图标」入口：草稿默认带 `list` 图标。
  const creatorIconOptions: AdminSelectOption[] = menuIconOptions(t);
  const creatorParentOptions: AdminSelectOption[] = [
    {label: t("rbac.permissionTree.parentNone"), value: ""},
    ...permissionParentCandidates(rows, "").map((candidate) => ({
      label: rbacTreeLabel(candidate, language, t),
      value: candidate.code,
    })),
  ];
  return (
    <>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-foreground">
            {t("rbac.permissionTree.createGroup")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("rbac.permissionTree.createGroupHint")}
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
            placeholder={t("rbac.permissionTree.codePlaceholder")}
            value={draft.code}
          />
          <Input
            className="w-36"
            disabled={busy}
            onChange={(event) => onDraftChange({nameZh: event.target.value})}
            placeholder={t("rbac.permissionTree.nameZhPlaceholder")}
            value={draft.nameZh}
          />
          <Input
            className="w-36"
            disabled={busy}
            onChange={(event) => onDraftChange({nameEn: event.target.value})}
            placeholder={t("rbac.permissionTree.nameEnPlaceholder")}
            value={draft.nameEn}
          />
          <div className="w-36">
            <AdminSelect
              ariaLabel={t("rbac.permissionTree.icon")}
              disabled={busy}
              onChange={(option) => onDraftChange({icon: option.value})}
              options={creatorIconOptions}
              placeholder={t("rbac.permissionTree.icon")}
              value={
                creatorIconOptions.find(({value}) => value === draft.icon) ?? null
              }
            />
          </div>
          <div className="w-44">
            <AdminSelect
              ariaLabel={t("rbac.permissionTree.parent")}
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
            {t("rbac.permissionTree.save")}
          </Button>
          <Button
            disabled={busy}
            onClick={onCancel}
            size="xs"
            type="button"
            variant="ghost"
          >
            {t("rbac.permissionTree.cancel")}
          </Button>
        </div>
      </div>
    </>
  );
}
