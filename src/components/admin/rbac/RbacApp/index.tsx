import {
  ChevronRightIcon,
  DownloadIcon,
  GlobeIcon,
  MonitorIcon,
  PlusIcon,
  TabletSmartphoneIcon,
  UsersIcon,
} from "lucide-react";

import {useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {
  PermissionGroupCreator,
  PermissionNodeEditor,
  type PermissionGroupDraft,
} from "@/components/admin/rbac/PermissionNodeEditor";
import {
  dropPositionFromY,
  PermissionBranchSlot,
  PermissionBranchToggle,
  PermissionInterfaceRow,
  PermissionNodeIcon,
  PermissionTreeCtx,
  PermissionTreeNode,
  TREE_CHILDREN_CLASS,
  TREE_ROW_CLASS,
  TreeBadge,
  type PermissionTreeCtxValue,
} from "@/components/admin/rbac/PermissionTreeNode";
import RoleManagerDialog, {
  type RoleDraft,
} from "@/components/admin/rbac/RoleManagerDialog";
import {
  RbacSaveStatus,
  type RbacSaveState,
} from "@/components/admin/rbac/RbacSaveStatus";
import {cn} from "@/lib/utils";
import {parseAdminLanguage} from "@/shared/AdminLanguage";
import type {InterfaceCatalogRow} from "@/shared/AppInterface";
import {
  permissionAccordionCollapsed,
  permissionAccordionReveal,
  permissionAccordionToggle,
  permissionNodeChildren,
  permissionNodeDropAllowed,
  reorderPermissionNodes,
  type PermissionAccordionState,
  type PermissionDropPosition,
  type PermissionNodeRowWithMeta,
  type PermissionTreeOp,
  type PermissionUpdatePatch,
} from "@/shared/PermissionTreeOps";
import {
  permissionBranchState,
  rbacTreeLabel,
  togglePermissionBranch,
  type PermissionAudience,
  type RbacBoard,
} from "@/shared/Rbac";
import {ADMIN_URLS} from "@/shared/StringUtils";

/** Mirrors the server's role-code rule (`^[a-z][a-z0-9_]*$`). */
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/u;

/** 合成根的 category 层：两个分类结点不入库，由端归属（audience）合成。 */
const CATEGORY_AUDIENCES: readonly PermissionAudience[] = ["desktop", "app"];

/** App 匿名端点里「登录凭证」用途的三个路由；其余匿名端点一律归「应用信息」。 */
const ANON_CREDENTIAL_SUFFIXES = new Set(["login", "replaceToken", "getPicCaptcha"]);

/**
 * 「开放访问」合成块的两个用途分组，从接口清单数据推导：
 * 新增匿名端点会自动出现在应用信息组，与清单不脱节。
 */
function anonymousGroups(
  rows: readonly InterfaceCatalogRow[],
): {labelKey: string; rows: InterfaceCatalogRow[]}[] {
  const anonymous = rows.filter((row) => row.auth === "anonymous");
  const credential = anonymous.filter((row) => {
    const suffix = row.path.split("/").pop() ?? "";
    return ANON_CREDENTIAL_SUFFIXES.has(suffix);
  });
  const about = anonymous.filter((row) => !credential.includes(row));
  return [
    {labelKey: "rbac.anonCredential", rows: credential},
    {labelKey: "rbac.anonAbout", rows: about},
  ];
}

/**
 * 手风琴状态的 key 与状态本身都由 `PermissionTreeOps` 提供：一个父只有一个
 * 展开位，展开别的分支就是改写同一个键，兄弟自动折叠。
 */

interface Props {
  /** App 端接口清单（服务端从代码登记表推导）。 */
  appInterfaces: InterfaceCatalogRow[];
  /** App 端板子；`null` = 当前账号看不到 App 分类（无任何 App 码）。 */
  appBoard: RbacBoard | null;
  /** PC 端板子（角色列表的全局来源）。 */
  desktopBoard: RbacBoard;
  /** PC 端接口清单（后台 ajax 端点的静态目录）。 */
  pcInterfaces: InterfaceCatalogRow[];
}

/** `GET /ajax/rbac/permission-tree` 的响应体：行集 + 失败时的错误文案。 */
interface PermissionRowsResponse {
  error?: string;
  rows?: PermissionNodeRowWithMeta[];
}

/** 右栏当前选中对象：树行或只读接口叶子。 */
type DetailSelection =
  | {kind: "iface"; row: InterfaceCatalogRow}
  | {audience: PermissionAudience; code: string; kind: "row"}
  | null;

/** Pull a localized message out of a failed RBAC ajax response. */
async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as {error?: string};
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 权限管理单页（migration 0131，已确认的原形形态）：
 *
 *   顶部角色条（全局角色，chips 只做选择；新建与维护走「管理角色」弹窗，
 *   弹窗是用户管理页的两栏语法：左列角色列表 + 右栏角色详情）
 *   一棵树 = 合成根「权限树」→ 两个分类（PC 端管理 / App 端管理，展示层合成
 *   不入库）→ 各端真实结点。码结点带授权勾选框：勾 = 给选中角色授权、
 *   取消 = 撤销，即点即存（一次勾选 = 一个聚焦操作，服务端返回最新板子）。
 *   码结点下面挂只读接口路径叶子（PC = 后台 ajax 端点，App = 开放接口）。
 *
 * 手风琴：每一层同层只展开一个（分类层、顶层分组层同理）；搜索态例外
 * （命中强制展开）。结构编辑（改名 / 图标 / 父级 / 显隐 / 移动 / 删除 /
 * 加子分组）集中在右栏详情面板，失焦即保存——与菜单管理同款语法。
 * App 分类对没有任何 App 码的账号隐藏（服务端判定，`appBoard` 传 null）。
 * `super_admin` 是通配持有者：整树只读，勾选框全部禁用。
 */
export default function RbacApp({appBoard, appInterfaces, desktopBoard, pcInterfaces}: Props) {
  const {t, i18n} = useTranslation();
  const language = parseAdminLanguage(i18n.language);
  const [boards, setBoards] = useState<{app: RbacBoard | null; desktop: RbacBoard}>({
    app: appBoard,
    desktop: desktopBoard,
  });
  const [selectedRole, setSelectedRole] = useState(desktopBoard.roles[0]?.code ?? "");
  const [saving, setSaving] = useState(false);

  // 两端行集：单页同时装载 desktop 与 app（App 分类可见时）。
  const [rowsByAudience, setRowsByAudience] = useState<
    Partial<Record<PermissionAudience, PermissionNodeRowWithMeta[]>>
  >({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 失焦即存的可见反馈：存中/已存/失败。失败时记下最后一次操作供「重试」重发。
  const [saveState, setSaveState] = useState<RbacSaveState>("idle");
  const lastOpsRef = useRef<{
    audience: PermissionAudience;
    ops: PermissionTreeOp[];
  } | null>(null);

  // 手风琴：分类层一个值，其余每层记「端 + 父 → 唯一展开的子」。因此任何时刻
  // 整棵树只有一条展开链——展开一个分支就自动折叠它的同层兄弟。
  const [openCategory, setOpenCategory] = useState<PermissionAudience | null>("desktop");
  const [openChild, setOpenChild] = useState<PermissionAccordionState>({});
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DetailSelection>(null);
  const [selectedIfacePath, setSelectedIfacePath] = useState<string | null>(null);

  const [creating, setCreating] = useState<PermissionAudience | null>(null);
  const [draft, setDraft] = useState<PermissionGroupDraft>({
    code: "",
    icon: "list",
    nameEn: "",
    nameZh: "",
    parentCode: "",
  });
  // 角色的新建与维护在弹窗里（`RoleManagerDialog`），角色条只留选择。
  const [roleManagerOpen, setRoleManagerOpen] = useState(false);

  const visibleAudiences = useMemo(
    () => CATEGORY_AUDIENCES.filter((audience) =>
      audience === "desktop" || boards.app !== null),
    [boards.app],
  );

  const role = boards.desktop.roles.find((entry) => entry.code === selectedRole);
  const isWildcardRole = role?.code === "super_admin";

  // ------------------------------------------------------------------ 授权即点即存
  // 乐观回写：先让界面立即反映操作；保存失败时用调用方传进来的旧授权回滚，
  // 否则勾选框会一直停在「已授予」，用户以为存上了。
  const applyGrantsOptimistic = useCallback(
    (audience: PermissionAudience, roleCode: string, permissions: string[]) => {
      setBoards((prev) => {
        const target = audience === "desktop" ? prev.desktop : prev.app;
        if (!target) return prev;
        const updated: RbacBoard = {
          ...target,
          roles: target.roles.map((entry) =>
            entry.code === roleCode ? {...entry, permissions} : entry),
        };
        return {...prev, [audience]: updated};
      });
    },
    [],
  );

  const saveGrants = useCallback(
    async (
      audience: PermissionAudience,
      roleCode: string,
      permissions: string[],
      previous: string[],
    ) => {
      setSaving(true);
      try {
        const response = await fetch(ADMIN_URLS.ajaxRbacRolePermissions(), {
          body: JSON.stringify({audience, permissions, role: roleCode}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        if (!response.ok) throw new Error("save failed");
        const board = (await response.json()) as RbacBoard;
        setBoards((prev) => ({...prev, [audience]: board}));
        showToast(t("rbac.saved"), "success");
      } catch {
        applyGrantsOptimistic(audience, roleCode, previous);
        showToast(t("rbac.saveFailed"), "error");
      } finally {
        setSaving(false);
      }
    },
    [applyGrantsOptimistic, t],
  );

  const toggleGrants = useCallback(
    (audience: PermissionAudience, codes: readonly string[], granted: boolean) => {
      const board = audience === "desktop" ? boards.desktop : boards.app;
      const current = board?.roles.find((entry) => entry.code === selectedRole);
      if (!current || current.code === "super_admin") return;
      const next = togglePermissionBranch(current.permissions, codes, granted);
      applyGrantsOptimistic(audience, current.code, next);
      void saveGrants(audience, current.code, next, current.permissions);
    },
    [applyGrantsOptimistic, boards.app, boards.desktop, saveGrants, selectedRole],
  );

  const grantsCtx = useCallback(
    (audience: PermissionAudience) => {
      const board = audience === "desktop" ? boards.desktop : boards.app;
      const current = board?.roles.find((entry) => entry.code === selectedRole);
      const granted = new Set(current?.permissions ?? []);
      return {
        disabled: isWildcardRole || saving,
        state: (codes: readonly string[]) => permissionBranchState([...codes], granted),
        toggle: (codes: readonly string[], grantedNext: boolean) =>
          toggleGrants(audience, codes, grantedNext),
      };
    },
    [boards.app, boards.desktop, isWildcardRole, saving, selectedRole, toggleGrants],
  );

  // ------------------------------------------------------------------ 接口叶子
  const buildIfaceIndex = useCallback((rows: InterfaceCatalogRow[]) => {
    const map = new Map<string, InterfaceCatalogRow[]>();
    for (const row of rows) {
      for (const code of row.permissionCodes) {
        const list = map.get(code) ?? [];
        list.push(row);
        map.set(code, list);
      }
    }
    return map;
  }, []);
  const appIfaceByCode = useMemo(() => buildIfaceIndex(appInterfaces), [appInterfaces, buildIfaceIndex]);
  const pcIfaceByCode = useMemo(() => buildIfaceIndex(pcInterfaces), [buildIfaceIndex, pcInterfaces]);

  // 权限目录名（键 = 权限码）：码结点自己不带名字（ADR-0038），树行与详情面板
  // 都靠这张表把码显示成中文用途名。目录随板子一起返回，按端各取一份。
  const permissionNamesByAudience = useMemo(() => {
    const index = (board: RbacBoard | null) =>
      new Map((board?.permissions ?? []).map((entry) => [entry.code, entry.name]));
    return {app: index(boards.app), desktop: index(boards.desktop)};
  }, [boards.app, boards.desktop]);

  const selectIface = useCallback((row: InterfaceCatalogRow) => {
    setSelected({kind: "iface", row});
    setSelectedIfacePath(row.path);
  }, []);

  // ------------------------------------------------------ 拖拽（自 PermissionTreeApp 迁入）
  const [draggedCode, setDraggedCode] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{code: string; position: PermissionDropPosition} | null>(null);
  const draggedAudienceRef = useRef<PermissionAudience>("desktop");
  const activePointerIdRef = useRef<number | null>(null);
  const dragChangedRef = useRef(false);
  const dragRejectedRef = useRef(false);
  const savingOrderRef = useRef(false);
  const rowsRef = useRef<Partial<Record<PermissionAudience, PermissionNodeRowWithMeta[]>>>({});
  const savedRowsRef = useRef<Partial<Record<PermissionAudience, PermissionNodeRowWithMeta[]>>>({});
  useEffect(() => {
    rowsRef.current = rowsByAudience;
  }, [rowsByAudience]);
  useEffect(() => {
    if (!loading) savedRowsRef.current = rowsByAudience;
  }, [loading, rowsByAudience]);

  const beginDragging = (
    event: ReactPointerEvent<HTMLButtonElement>,
    code: string,
    audience: PermissionAudience,
  ) => {
    if (event.button !== 0 || savingOrderRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    draggedAudienceRef.current = audience;
    dragChangedRef.current = false;
    dragRejectedRef.current = false;
    setFormError(null);
    setDraggedCode(code);
  };

  const restoreSaved = useCallback(() => {
    setRowsByAudience(savedRowsRef.current);
  }, []);

  const confirmReparent = useCallback(
    (row: PermissionNodeRowWithMeta, parentCode: string | null): boolean => {
      if (parentCode === row.parentCode) return true;
      return window.confirm(
        t("rbac.permissionTree.reparentConfirm", {code: row.permissionCode ?? row.code}),
      );
    },
    [t],
  );

  const finishDragging = useCallback(() => {
    activePointerIdRef.current = null;
    const changed = dragChangedRef.current;
    const rejected = dragRejectedRef.current;
    const target = dropTarget;
    const dragged = draggedCode;
    const audience = draggedAudienceRef.current;
    dragChangedRef.current = false;
    dragRejectedRef.current = false;
    setDraggedCode(null);
    setDropTarget(null);
    const rows = rowsRef.current[audience] ?? [];
    if (!target || !dragged) {
      if (changed) restoreSaved();
      if (rejected) setFormError(t("rbac.permissionTree.moveRejected"));
      return;
    }
    if (!changed) {
      if (rejected) setFormError(t("rbac.permissionTree.moveRejected"));
      return;
    }
    const before = (savedRowsRef.current[audience] ?? []).find(
      (entry) => entry.code === dragged,
    );
    const result = reorderPermissionNodes(rows, dragged, target.code, target.position);
    const moved = result.find((entry) => entry.code === dragged);
    if (!moved) return;
    const newParent = moved.parentCode ?? null;
    if (before && !confirmReparent(before, newParent)) {
      restoreSaved();
      return;
    }
    const ids = permissionNodeChildren(result, newParent).map((entry) => entry.code);
    savingOrderRef.current = true;
    void postOpsRef.current?.(audience, [{code: dragged, op: "reorder", ids, parentCode: newParent}])
      .then((ok: boolean) => {
        savingOrderRef.current = false;
        if (!ok) restoreSaved();
      });
  }, [confirmReparent, dropTarget, draggedCode, restoreSaved, t]);

  // postOps 声明在拖拽块之后；经 ref 供 finishDragging 稳定取用。
  const postOpsRef = useRef<((audience: PermissionAudience, ops: PermissionTreeOp[]) => Promise<boolean>) | null>(null);

  useEffect(() => {
    if (!draggedCode) return;
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) return;
      event.preventDefault();
      const audience = draggedAudienceRef.current;
      const rows = rowsRef.current[audience] ?? [];
      const targetRow = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-permission-node]");
      const targetCode = targetRow?.dataset.permissionNode;
      const draggedRow = rows.find((entry) => entry.code === draggedCode);
      if (!targetRow || !targetCode || !draggedRow || targetCode === draggedCode) {
        setDropTarget(null);
        return;
      }
      const target = rows.find((entry) => entry.code === targetCode);
      if (!target) {
        setDropTarget(null);
        return;
      }
      const bounds = targetRow.getBoundingClientRect();
      const position = dropPositionFromY(bounds, event.clientY, true);
      if (!permissionNodeDropAllowed(rows, draggedRow, target, position)) {
        dragRejectedRef.current = true;
        setDropTarget(null);
        return;
      }
      setDropTarget({code: targetCode, position});
      const reordered = reorderPermissionNodes(rows, draggedCode, targetCode, position);
      if (reordered !== rows) {
        dragChangedRef.current = true;
        rowsRef.current = {...rowsRef.current, [audience]: reordered};
        setRowsByAudience((prev) => ({...prev, [audience]: reordered}));
      }
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
  }, [draggedCode, finishDragging]);

  // ------------------------------------------------------------------ 行集装载
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const audiences = CATEGORY_AUDIENCES.filter((audience) =>
        audience === "desktop" || boards.app !== null);
      const results = await Promise.all(audiences.map(async (audience) => {
        const response = await fetch(ADMIN_URLS.ajaxRbacPermissionTree(audience));
        const data = (await response.json().catch(() => ({}))) as PermissionRowsResponse;
        if (!response.ok) {
          throw new Error(data.error ?? t("rbac.permissionTree.loadFailed"));
        }
        return [audience, Array.isArray(data.rows) ? data.rows : []] as const;
      }));
      setRowsByAudience(Object.fromEntries(results));
      setLoadError(null);
    } catch (loadError) {
      setLoadError(loadError instanceof Error
        ? loadError.message
        : t("rbac.permissionTree.loadFailed"));
    } finally {
      setLoading(false);
    }
    // boards.app 只由服务端 props 决定（分类可见性），不进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const postOps = useCallback(
    async (audience: PermissionAudience, ops: PermissionTreeOp[]): Promise<boolean> => {
      setBusy(true);
      setFormError(null);
      setSaveState("saving");
      lastOpsRef.current = {audience, ops};
      try {
        const response = await fetch(ADMIN_URLS.ajaxRbacPermissionTreeSave(), {
          body: JSON.stringify({audience, ops}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        const data = (await response.json().catch(() => ({}))) as PermissionRowsResponse;
        if (!response.ok) throw new Error(data.error ?? t("rbac.permissionTree.saveFailed"));
        setRowsByAudience((prev) => ({
          ...prev,
          [audience]: Array.isArray(data.rows) ? data.rows : [],
        }));
        setSaveState("saved");
        return true;
      } catch (saveError) {
        setSaveState("error");
        setFormError(
          saveError instanceof Error ? saveError.message : t("rbac.permissionTree.saveFailed"),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  // 「已保存」只停留几秒：错过也不碍事，它本来就只是确认信号；开始新一轮
  // 保存或出错时立即被覆盖。失败态常驻，等用户重试或下一次编辑。
  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = window.setTimeout(() => setSaveState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  const retryLastOps = useCallback(() => {
    const last = lastOpsRef.current;
    if (last) void postOps(last.audience, last.ops);
  }, [postOps]);

  useEffect(() => {
    postOpsRef.current = postOps;
  }, [postOps]);

  // ------------------------------------------------------------------ 手风琴
  // 任意层级同一父下只有一个展开位：点箭头 = 把该父的展开位切成自己（已展开则折叠）。
  const toggleNode = useCallback(
    (audience: PermissionAudience, code: string) => {
      const rows = rowsByAudience[audience] ?? [];
      const row = rows.find((entry) => entry.code === code);
      if (!row) return;
      setOpenChild((prev) => permissionAccordionToggle(prev, audience, row.parentCode ?? null, code));
    },
    [rowsByAudience],
  );

  const toggleCategory = useCallback((audience: PermissionAudience) => {
    setOpenCategory((prev) => (prev === audience ? null : audience));
  }, []);

  // 全收起：分类、每端顶层与更深层的行一起折叠（原形工具栏左侧那一颗）。
  const collapseAll = useCallback(() => {
    setOpenCategory(null);
    setOpenChild({});
  }, []);

  // ------------------------------------------------------------------ 搜索
  const searchMatch = useMemo(() => {
    const query = search.trim().toLowerCase();
    const result: Partial<Record<PermissionAudience, {ancestors: Set<string>; codes: Set<string>}>> = {};
    if (!query) return result;
    for (const audience of visibleAudiences) {
      const rows = rowsByAudience[audience] ?? [];
      const codes = new Set<string>();
      const ancestors = new Set<string>();
      const parentByCode = new Map(rows.map((entry) => [entry.code, entry.parentCode]));
      const lift = (code: string) => {
        codes.add(code);
        let parent = parentByCode.get(code) ?? null;
        while (parent) {
          ancestors.add(parent);
          parent = parentByCode.get(parent) ?? null;
        }
      };
      for (const entry of rows) {
        // 码行的可见文字是权限目录名，搜索必须按同一份名字匹配。
        const catalog = entry.kind === "code"
          ? permissionNamesByAudience[audience].get(entry.permissionCode ?? entry.code)
          : undefined;
        const label = catalog ?? rbacTreeLabel(entry, language, t);
        if (entry.code.toLowerCase().includes(query) || label.toLowerCase().includes(query)) {
          lift(entry.code);
        }
      }
      // 接口路径也参与搜索：命中的叶子让它的码结点亮起来。
      const ifaces = audience === "desktop" ? pcInterfaces : appInterfaces;
      for (const row of ifaces) {
        if (!row.path.toLowerCase().includes(query)) continue;
        for (const code of row.permissionCodes) lift(code);
      }
      result[audience] = {ancestors, codes};
    }
    return result;
  }, [
    appInterfaces, language, pcInterfaces, permissionNamesByAudience, rowsByAudience,
    search, t, visibleAudiences,
  ]);

  const treeCtx = useCallback(
    (audience: PermissionAudience): PermissionTreeCtxValue => {
      const rows = rowsByAudience[audience] ?? [];
      const match = searchMatch[audience] ?? {ancestors: new Set<string>(), codes: new Set<string>()};
      // 折叠态由手风琴状态派生：除该父名下唯一展开的那一行，其余都折叠。
      const collapsed = permissionAccordionCollapsed(rows, openChild, audience);
      return {
        collapsed,
        drag: {
          draggingCode: draggedCode,
          dropTarget,
          onHandlePointerDown: (event, code) => beginDragging(event, code, audience),
        },
        grants: grantsCtx(audience),
        interfaces: {
          byCode: audience === "desktop" ? pcIfaceByCode : appIfaceByCode,
          onSelect: selectIface,
          selectedPath: selectedIfacePath,
        },
        language,
        move: (row, direction) => {
          void postOps(audience, [{code: row.code, direction, op: "move"}]);
        },
        onSelect: (code) => {
          setSelected({audience, code, kind: "row"});
          setSelectedIfacePath(null);
          setCreating(null);
        },
        permissionNames: permissionNamesByAudience[audience],
        rows,
        search: {
          isForcedOpen: (code) => match.ancestors.has(code),
          isHighlighted: (code) => match.codes.has(code),
          query: search,
        },
        selectedCode: selected?.kind === "row" && selected.audience === audience
          ? selected.code
          : null,
        toggleOpen: (code) => toggleNode(audience, code),
      };
    },
    [
      appIfaceByCode, draggedCode, dropTarget, grantsCtx, language, openChild,
      pcIfaceByCode, permissionNamesByAudience, postOps, rowsByAudience, search,
      searchMatch, selectIface, selected, selectedIfacePath, toggleNode,
    ],
  );

  // -------------------------------------------------------------- 详情面板
  const updateField = useCallback(
    (audience: PermissionAudience, row: PermissionNodeRowWithMeta, patch: PermissionUpdatePatch) => {
      const changed = (Object.entries(patch) as [keyof PermissionUpdatePatch, unknown][]).some(
        ([key, value]) => (row[key === "isVisible" ? "visible" : key] as unknown) !== value,
      );
      if (!changed) return;
      void postOps(audience, [{code: row.code, op: "update", patch}]);
    },
    [postOps],
  );

  const removeRow = useCallback(
    (audience: PermissionAudience, row: PermissionNodeRowWithMeta) => {
      if (!window.confirm(t("rbac.permissionTree.deleteConfirm", {code: row.code}))) return;
      void postOps(audience, [{code: row.code, op: "delete"}]);
    },
    [postOps, t],
  );

  const submitCreateGroup = useCallback(async () => {
    const audience = creating;
    if (!audience) return;
    const code = draft.code.trim();
    const ok = await postOps(audience, [
      {
        code,
        icon: draft.icon,
        nameEn: draft.nameEn,
        nameZh: draft.nameZh,
        op: "create-group",
        parentCode: draft.parentCode || null,
      },
    ]);
    if (ok) {
      setCreating(null);
      setDraft({code: "", icon: "list", nameEn: "", nameZh: "", parentCode: ""});
      setSelected({audience, code, kind: "row"});
    }
  }, [creating, draft, postOps]);

  const openCreateGroup = useCallback((audience: PermissionAudience, parentCode: string) => {
    setDraft({code: "", icon: "list", nameEn: "", nameZh: "", parentCode});
    setCreating(audience);
  }, []);

  const exportSql = useCallback(async (audience: PermissionAudience) => {
    setFormError(null);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacPermissionTreeExport(audience));
      const data = (await response.json().catch(() => ({}))) as {error?: string; sql?: string};
      if (!response.ok || typeof data.sql !== "string") {
        throw new Error(data.error ?? t("rbac.permissionTree.exportFailed"));
      }
      const blob = new Blob([data.sql], {type: "application/sql;charset=utf-8"});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "data_permission_nodes_snapshot.sql";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setFormError(
        exportError instanceof Error ? exportError.message : t("rbac.permissionTree.exportFailed"),
      );
    }
  }, [t]);

  // 选中行：被删或不存在时回退到 PC 端首个有子的顶层的第一行。
  const selectedRow = (() => {
    if (selected?.kind !== "row") return null;
    const rows = rowsByAudience[selected.audience] ?? [];
    return rows.find((entry) => entry.code === selected.code) ?? null;
  })();
  useEffect(() => {
    if (creating || selected?.kind === "iface" || selectedRow) return;
    const rows = rowsByAudience.desktop ?? [];
    const topWithChildren = rows.find(
      (root) => (root.parentCode ?? null) === null &&
        permissionNodeChildren(rows, root.code).length > 0,
    );
    const first = topWithChildren
      ? permissionNodeChildren(rows, topWithChildren.code)[0]
      : rows[0];
    if (first) setSelected({audience: "desktop", code: first.code, kind: "row"});
  }, [creating, rowsByAudience, selected, selectedRow]);

  // 选中行：把祖先链上每一层的展开位都指向这条链。手风琴下一个父只有一个
  // 展开位，所以定位到某行不会让别的分支留着一半展开。
  const openedForSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (selected?.kind !== "row" || openedForSelectionRef.current === selected.code) return;
    openedForSelectionRef.current = selected.code;
    const rows = rowsByAudience[selected.audience] ?? [];
    setOpenCategory(selected.audience);
    setOpenChild((prev) => permissionAccordionReveal(rows, prev, selected.audience, selected.code));
  }, [rowsByAudience, selected]);

  // -------------------------------------------------------------- 角色条 CRUD
  const applyRolesFrom = useCallback((board: RbacBoard) => {
    // 角色 CRUD 端点返回 desktop 板子；App 板子的角色清单在本地同步，
    // 各角色的 App 授权保持原值（角色全局共享，CRUD 不碰授权）。
    setBoards((prev) => {
      if (!prev.app) return {...prev, desktop: board};
      const roles = board.roles.map((entry) => ({
        ...entry,
        permissions: prev.app?.roles.find((r) => r.code === entry.code)?.permissions ?? [],
      }));
      return {app: {...prev.app, roles}, desktop: board};
    });
  }, []);

  const createRole = async ({code, name}: RoleDraft): Promise<boolean> => {
    if (!ROLE_CODE_PATTERN.test(code) || !name) {
      showToast(t("errors.rbac.invalidRole"), "error");
      return false;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacRoles(), {
        body: JSON.stringify({code, name}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.duplicateRole")), "error");
        return false;
      }
      const board = (await response.json()) as RbacBoard;
      applyRolesFrom(board);
      setSelectedRole(code);
      showToast(t("rbac.saved"), "success");
      return true;
    } catch {
      showToast(t("errors.rbac.duplicateRole"), "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const updateRole = async (current: RoleDraft, next: RoleDraft): Promise<boolean> => {
    const name = next.name.trim();
    const newCode = next.code.trim();
    if (!name || !newCode) {
      showToast(t("errors.rbac.invalidRole"), "error");
      return false;
    }
    const changingCode = newCode !== current.code;
    if (changingCode && !ROLE_CODE_PATTERN.test(newCode)) {
      showToast(t("errors.rbac.invalidRole"), "error");
      return false;
    }
    setSaving(true);
    try {
      if (changingCode) {
        const codeResponse = await fetch(ADMIN_URLS.ajaxRbacRoleCode(), {
          body: JSON.stringify({code: current.code, newCode}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        if (!codeResponse.ok) {
          showToast(
            await parseError(codeResponse, t("errors.rbac.reservedRole")),
            "error",
          );
          return false;
        }
        applyRolesFrom((await codeResponse.json()) as RbacBoard);
        setSelectedRole(newCode);
      }
      if (name !== current.name) {
        const nameResponse = await fetch(ADMIN_URLS.ajaxRbacRoleName(), {
          body: JSON.stringify({code: changingCode ? newCode : current.code, name}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        if (!nameResponse.ok) {
          showToast(
            await parseError(nameResponse, t("errors.rbac.reservedRole")),
            "error",
          );
          return false;
        }
        applyRolesFrom((await nameResponse.json()) as RbacBoard);
      }
      showToast(t("rbac.saved"), "success");
      return true;
    } catch {
      showToast(t("errors.rbac.reservedRole"), "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  // 「登录后台」开关：只改角色的入口开关，不动授权行，服务端整表回传。
  const setRoleAdminLogin = async (code: string, allow: boolean): Promise<boolean> => {
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacRoleLogin(), {
        body: JSON.stringify({allow, code}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.reservedRole")), "error");
        return false;
      }
      applyRolesFrom((await response.json()) as RbacBoard);
      showToast(t("rbac.saved"), "success");
      return true;
    } catch {
      showToast(t("errors.rbac.reservedRole"), "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async (code: string): Promise<boolean> => {
    const target = boards.desktop.roles.find((entry) => entry.code === code);
    if (!target) return false;
    if (!window.confirm(t("rbac.confirmDeleteRole", {name: target.name}))) return false;
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacRoleDelete(), {
        body: JSON.stringify({code: target.code}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.roleInUse")), "error");
        return false;
      }
      const board = (await response.json()) as RbacBoard;
      applyRolesFrom(board);
      setSelectedRole((previous) =>
        previous === target.code ? (board.roles[0]?.code ?? "") : previous);
      showToast(t("rbac.saved"), "success");
      return true;
    } catch {
      showToast(t("errors.rbac.roleInUse"), "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  // -------------------------------------------------------------- 渲染
  if (loading && Object.keys(rowsByAudience).length === 0) {
    return <AdminCollectionLoading label={t("pageTitle.rbac")} />;
  }
  if (loadError && Object.keys(rowsByAudience).length === 0) {
    return <AdminCollectionError message={loadError} retry={() => void load()} />;
  }

  // 某个角色持有的授权总数：两端相加。App 分类隐藏时（账号没有任何 App 码）
  // 服务端只发 PC 板子，这里就只有 PC 端的数——拿不到对端授权，不假装补零。
  const countOfRole = (code: string) =>
    (boards.desktop.roles.find((entry) => entry.code === code)?.permissions.length ?? 0) +
    (boards.app?.roles.find((entry) => entry.code === code)?.permissions.length ?? 0);

  // 行选中态的收窄视图：JSX 里经 selectedRow && detailBoard 判断后仍能安全取用。
  const rowSelection = selected?.kind === "row"
    ? {audience: selected.audience, code: selected.code}
    : null;
  const detailRows = rowSelection ? rowsByAudience[rowSelection.audience] ?? [] : [];
  const detailBoard = rowSelection
    ? (rowSelection.audience === "desktop" ? boards.desktop : boards.app)
    : null;
  const detailCatalog = rowSelection
    ? (rowSelection.audience === "desktop" ? pcInterfaces : appInterfaces)
    : [];
  const selectedCodeRow = selectedRow?.kind === "code" ? selectedRow : null;
  const selectedCodeValue = selectedCodeRow?.permissionCode ?? null;
  const codeInterfaces = selectedCodeValue
    ? detailCatalog.filter((row) => row.permissionCodes.includes(selectedCodeValue))
    : [];

  const categoryLabel = (audience: PermissionAudience) =>
    audience === "desktop" ? t("rbac.categoryDesktop") : t("rbac.categoryApp");

  const searchActive = search.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 角色条：选中谁，树上的勾选框就显示谁；新建与维护在右侧弹窗里 */}
      <div className="flex flex-wrap items-center gap-2 rounded-[14px] border bg-card p-2 shadow-xs">
        <span className="px-1 text-xs text-muted-foreground">{t("rbac.roleBarLabel")}</span>
        {boards.desktop.roles.map((entry) => {
          const active = entry.code === selectedRole;
          const isWildcard = entry.code === "super_admin";
          return (
            <button
              aria-current={active ? "true" : undefined}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm",
                active
                  ? "border-primary/40 bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              key={entry.code}
              onClick={() => setSelectedRole(entry.code)}
              type="button"
            >
              <span>
                {entry.name}
                {isWildcard && " *"}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {isWildcard ? "*" : `${countOfRole(entry.code)} ${t("rbac.roleGrantCountUnit")}`}
              </span>
            </button>
          );
        })}
        <Button
          disabled={saving}
          onClick={() => setRoleManagerOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <UsersIcon aria-hidden="true" />
          {t("rbac.manageRoles")}
        </Button>
        <span className="ml-auto px-1 text-xs text-muted-foreground">
          {isWildcardRole
            ? t("rbac.wildcardRoleNotice")
            : t("rbac.roleBarHint", {name: role?.name ?? ""})}
        </span>
      </div>

      {formError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {formError}
        </p>
      )}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <nav className="w-full shrink-0 rounded-[14px] border bg-card p-2 shadow-xs lg:w-96">
          <div className="p-1">
            <Input
              className="w-full"
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("rbac.permissionTree.searchPlaceholder")}
              value={search}
            />
          </div>
          <div className="flex items-center gap-2 px-1 pb-2">
            <Button
              disabled={busy || loading}
              onClick={collapseAll}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("rbac.permissionTree.collapseAll")}
            </Button>
            <span className="flex-1" />
            <Button
              disabled={busy}
              onClick={() => void exportSql(openCategory ?? "desktop")}
              size="sm"
              type="button"
              variant="outline"
            >
              <DownloadIcon aria-hidden="true" />
              {t("rbac.permissionTree.exportSql")}
            </Button>
            <Button
              disabled={busy || openCategory === null}
              onClick={() => openCategory && openCreateGroup(openCategory, "")}
              size="sm"
              type="button"
            >
              <PlusIcon aria-hidden="true" />
              {t("rbac.permissionTree.createGroup")}
            </Button>
          </div>

          {searchActive &&
          visibleAudiences.every(
            (audience) => (searchMatch[audience]?.codes.size ?? 0) === 0,
          ) ? (
            <p className="px-2 py-6 text-sm text-muted-foreground">
              {t("rbac.permissionTree.noResults")}
            </p>
          ) : (
            <div>
              {/* 合成根：不是节点行，不参与拖拽（原形：静态箭头 + 图标 + 粗体名称）。 */}
              <div className={cn(TREE_ROW_CLASS, "gap-1.5")}>
                <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center">
                  <ChevronRightIcon className="size-4 rotate-90 text-muted-foreground" />
                </span>
                <UsersIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                  {t("rbac.permissionTree.treeRoot")}
                </span>
              </div>
              <div className={TREE_CHILDREN_CLASS}>
                {visibleAudiences.map((audience) => {
                  const rows = rowsByAudience[audience] ?? [];
                  const open = searchActive || openCategory === audience;
                  const roots = rows.filter((entry) => (entry.parentCode ?? null) === null);
                  const ctx: PermissionTreeCtxValue = treeCtx(audience);
                  const CategoryIcon = audience === "desktop" ? MonitorIcon : TabletSmartphoneIcon;
                  return (
                    <div key={audience}>
                      <div className={cn(TREE_ROW_CLASS, open && "font-semibold")}>
                        <PermissionBranchToggle
                          expanded={open}
                          label={categoryLabel(audience)}
                          onToggle={() => toggleCategory(audience)}
                        />
                        <CategoryIcon
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <button
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm",
                            open ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() => setOpenCategory(audience)}
                          type="button"
                        >
                          <span className="truncate">{categoryLabel(audience)}</span>
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                              audience === "desktop"
                                ? "bg-primary/10 text-primary"
                                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                            )}
                          >
                            {audience}
                          </span>
                        </button>
                      </div>
                      {open && (
                        <div className={TREE_CHILDREN_CLASS}>
                          <PermissionTreeCtx.Provider value={ctx}>
                            {roots.map((root) => (
                              <PermissionTreeNode key={root.code} row={root} />
                            ))}
                            {audience === "app" && (
                              <AnonymousInterfaceBlock
                                groups={anonymousGroups(appInterfaces)}
                                onSelect={selectIface}
                                selectedPath={selectedIfacePath}
                              />
                            )}
                          </PermissionTreeCtx.Provider>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </nav>

        {/*
          右栏常驻：树很长时页面滚动的是左栏，右栏贴住滚动区顶部不动。
          `max-h` 按滚动区（后台 `main`）的可视高度留出上边距与呼吸位，
          内容比视口更高时右栏自己滚，不会把下半截顶出屏幕外够不着。
        */}
        <section className="min-w-0 flex-1 rounded-[14px] border bg-card p-5 shadow-xs lg:sticky lg:top-4 lg:max-h-[calc(100svh-6rem)] lg:overflow-y-auto">
          <RbacSaveStatus
            detail={formError}
            onRetry={retryLastOps}
            state={saveState}
          />
          {creating ? (
            <PermissionGroupCreator
              busy={busy}
              draft={draft}
              language={language}
              onCancel={() => {
                setCreating(null);
                setFormError(null);
                setDraft({code: "", icon: "list", nameEn: "", nameZh: "", parentCode: ""});
              }}
              onDraftChange={(patch) => setDraft((prev) => ({...prev, ...patch}))}
              onSubmit={() => void submitCreateGroup()}
              rows={rowsByAudience[creating] ?? []}
            />
          ) : selected?.kind === "iface" ? (
            <InterfaceDetail row={selected.row} />
          ) : selectedRow && rowSelection && detailBoard ? (
            <>
              <PermissionNodeEditor
                busy={busy}
                confirmReparent={confirmReparent}
                language={language}
                onAddChildGroup={(parentCode) => openCreateGroup(rowSelection.audience, parentCode)}
                onDelete={(row) => removeRow(rowSelection.audience, row)}
                onField={(row, patch) => updateField(rowSelection.audience, row, patch)}
                onMove={(row, direction) => {
                  void postOps(rowSelection.audience, [{code: row.code, direction, op: "move"}]);
                }}
                permissionNames={permissionNamesByAudience[rowSelection.audience]}
                row={selectedRow}
                rows={detailRows}
              />
              {selectedCodeValue && (
                <CodeHolders
                  audience={rowSelection.audience}
                  code={selectedCodeValue}
                  disabled={saving}
                  holders={detailBoard.roles}
                  onToggle={(roleCode, granted) => {
                    const current = detailBoard.roles.find((r) => r.code === roleCode);
                    if (!current || current.code === "super_admin") return;
                    const next = togglePermissionBranch(
                      current.permissions,
                      [selectedCodeValue],
                      granted,
                    );
                    // 反向视角与树上勾选同款交互：先乐观回写，再 POST。
                    applyGrantsOptimistic(rowSelection.audience, roleCode, next);
                    void saveGrants(rowSelection.audience, roleCode, next, current.permissions);
                  }}
                />
              )}
              {selectedCodeValue && codeInterfaces.length > 0 && (
                <InterfaceTable rows={codeInterfaces} />
              )}
            </>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">
              {t("rbac.permissionTree.emptyBoard")}
            </p>
          )}
        </section>
      </div>

      <RoleManagerDialog
        countOf={countOfRole}
        onAdminLogin={setRoleAdminLogin}
        onClose={() => setRoleManagerOpen(false)}
        onCreate={createRole}
        onDelete={deleteRole}
        onOpenChange={setRoleManagerOpen}
        onSelect={setSelectedRole}
        onUpdate={updateRole}
        open={roleManagerOpen}
        roles={boards.desktop.roles}
        saving={saving}
        selectedCode={selectedRole}
      />
    </div>
  );
}

/** 右栏：持有该码的角色开关（反向视角——从码撤销授权，与树上勾选同源）。 */
function CodeHolders({
  audience,
  code,
  disabled,
  holders,
  onToggle,
}: {
  audience: PermissionAudience;
  code: string;
  disabled: boolean;
  holders: RbacBoard["roles"];
  onToggle: (roleCode: string, granted: boolean) => void;
}) {
  const {t} = useTranslation();
  const editable = holders.filter((entry) => entry.code !== "super_admin");
  return (
    <div className="mt-6 rounded-md border bg-background p-3">
      <p className="mb-2 text-sm font-medium text-foreground">{t("rbac.holdersTitle")}</p>
      {editable.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("rbac.holdersEmpty")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {editable.map((entry) => (
            <label className="flex items-center gap-2 text-sm" key={entry.code}>
              <Switch
                aria-label={t("rbac.holderToggle", {name: entry.name, code})}
                checked={entry.permissions.includes(code)}
                disabled={disabled}
                onCheckedChange={(checked) => onToggle(entry.code, checked)}
              />
              <span>{entry.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{entry.code}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {audience === "desktop" ? t("rbac.categoryDesktop") : t("rbac.categoryApp")}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** 右栏：该码下的接口只读表（路径 / 方法 / 凭证 / 门码）。 */
function InterfaceTable({rows}: {rows: InterfaceCatalogRow[]}) {
  const {t} = useTranslation();
  return (
    <div className="mt-4">
      <p className="mb-2 text-sm font-medium text-foreground">{t("rbac.interfacesOfCode")}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-3 font-medium">{t("rbac.appInterfacePath")}</th>
              <th className="py-2 pr-3 font-medium">{t("rbac.appInterfaceMethod")}</th>
              <th className="py-2 pr-3 font-medium">{t("rbac.appInterfaceCredential")}</th>
              <th className="py-2 font-medium">{t("rbac.appInterfacePermission")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-b last:border-0" key={`${row.method} ${row.path}`}>
                <td className="py-2 pr-3 font-mono text-xs">{row.path}</td>
                <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{row.method}</td>
                <td className="py-2 pr-3 text-muted-foreground">
                  {row.auth === "anonymous"
                    ? t("rbac.appInterfaceAnonymousYes")
                    : row.auth === "mflc"
                      ? t("rbac.appInterfaceCredential")
                      : t("rbac.interfaceAuthSession")}
                </td>
                <td className="py-2 font-mono text-xs text-muted-foreground">
                  {row.permissionCodes.length > 0
                    ? row.permissionCodes.join(" / ")
                    : t("rbac.appInterfaceNoPermission")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 右栏：单条接口叶子明细（树上点路径叶子时）。 */
function InterfaceDetail({row}: {row: InterfaceCatalogRow}) {
  const {t} = useTranslation();
  return (
    <div>
      <h2 className="font-semibold text-foreground">{t("rbac.interfaceDetailTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("rbac.interfaceDetailHint")}</p>
      <div className="mt-4 rounded-md border bg-background p-3">
        <div className="grid gap-1.5 text-sm">
          <span className="text-muted-foreground">{t("rbac.appInterfacePath")}</span>
          <span className="font-mono text-xs">{row.path}</span>
        </div>
        <div className="mt-2 grid gap-1.5 text-sm">
          <span className="text-muted-foreground">{t("rbac.appInterfaceMethod")}</span>
          <span className="font-mono text-xs">{row.method}</span>
        </div>
        <div className="mt-2 grid gap-1.5 text-sm">
          <span className="text-muted-foreground">{t("rbac.appInterfacePermission")}</span>
          <span className="font-mono text-xs">
            {row.permissionCodes.length > 0
              ? row.permissionCodes.join(" / ")
              : t("rbac.appInterfaceNoPermission")}
          </span>
        </div>
        <div className="mt-2 grid gap-1.5 text-sm">
          <span className="text-muted-foreground">{t("rbac.appInterfaceCredential")}</span>
          <span>
            {row.auth === "anonymous"
              ? t("rbac.appInterfaceAnonymousYes")
              : row.auth === "mflc"
                ? t("rbac.appInterfaceCredential")
                : t("rbac.interfaceAuthSession")}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * App 分类底部的「开放访问（匿名）」合成块：无门码端点按用途分组。
 * 排布与原形的树结点一致——开放访问 → 两个用途码 → 只读路径叶子。
 */
function AnonymousInterfaceBlock({
  groups,
  onSelect,
  selectedPath,
}: {
  groups: {labelKey: string; rows: InterfaceCatalogRow[]}[];
  onSelect: (row: InterfaceCatalogRow) => void;
  selectedPath: string | null;
}) {
  const {t} = useTranslation();
  const [open, setOpen] = useState(true);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  return (
    <div>
      <div className={TREE_ROW_CLASS}>
        <PermissionBranchSlot
          expanded={open}
          hasContent
          label={t("rbac.anonCategoryTitle")}
          onToggle={() => setOpen((prev) => !prev)}
        />
        <GlobeIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {t("rbac.anonCategoryTitle")}
        </span>
      </div>
      {open && (
        <div className={TREE_CHILDREN_CLASS}>
          {groups.map((group) => {
            const expanded = openGroup === group.labelKey;
            return (
              <div key={group.labelKey}>
                <div className={TREE_ROW_CLASS}>
                  <PermissionBranchSlot
                    expanded={expanded}
                    hasContent
                    label={t(group.labelKey)}
                    onToggle={() =>
                      setOpenGroup((prev) => (prev === group.labelKey ? null : group.labelKey))}
                  />
                  <PermissionNodeIcon icon={null} kind="code" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                    {t(group.labelKey)}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    {t("rbac.permissionTree.anonymousCode")}
                  </span>
                  <TreeBadge>{t("rbac.permissionTree.codeBadge")}</TreeBadge>
                </div>
                {expanded && (
                  <div className={TREE_CHILDREN_CLASS}>
                    {group.rows.map((row) => (
                      <PermissionInterfaceRow
                        key={row.path}
                        onSelect={onSelect}
                        row={row}
                        selected={selectedPath === row.path}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
