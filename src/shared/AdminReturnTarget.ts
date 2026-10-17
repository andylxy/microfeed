/**
 * 后台编辑器「返回目标」的解析。
 *
 * 看板链到编辑器时在链接上自报家门（`?from=volumes&bookId=…&volume=…`），
 * 编辑器把它解析成返回目标：面包屑、侧栏高亮、删除后的跳转目标都跟着它走。
 * 见 [ADR-0036](../../docs/novel-cms/adr/0036-admin-editor-return-target.md)。
 *
 * 参数里传的是**名字**，不是地址：未知或不完整的名字解析成 `null`，调用方
 * 退回自己的默认返回链接。手改地址最多让人回到列表，不会把返回箭头变成
 * 开放重定向。
 *
 * 接一个看板 = 在 {@link RETURN_BOARDS} 加一条注册项 + 一处链接，其余不动。
 */
import {adminUrl} from "./AdminPath";
import {type AdminMenuCode, menuItemLabelKey} from "./AdminNavigation";
import {ADMIN_MENU_CODES} from "./Constants";

interface ReturnBoardSpec {
  /** 编辑器打开期间左侧菜单要高亮的那一行。 */
  menuCode: AdminMenuCode;
  /** 携带看板自身状态的查询参数，按输出顺序排列。 */
  params: readonly string[];
  /** 缺了这些参数，看板只会打开一个空屏。 */
  required: readonly string[];
  /** 后台路由段，经 {@link adminUrl} 解析。 */
  path: string;
}

/**
 * 可以进入编辑器的看板。
 *
 * `volumes` 带的是看板的整个展开态：`bookId` 选书，`volume` 是**卷键**
 * （TCM 典籍是篇章 id，标签书是 `_microfeed.volume` 的卷名，未归类是
 * `unfiled`）。卷键原样透传——条目身上的 `_microfeed.volume` 是卷名，
 * 对 TCM 书反推出来的键指不到卷（见 CONTEXT.md「卷键」）。
 *
 * `fangs` / `yao` / `term` 三个看板的主轴只有书，所以只带 `bookId`。
 */
const RETURN_BOARDS = {
  volumes: {
    menuCode: ADMIN_MENU_CODES.VOLUMES,
    params: ["bookId", "volume"],
    required: ["bookId"],
    path: "volumes",
  },
  fangs: {
    menuCode: ADMIN_MENU_CODES.FANGS,
    params: ["bookId"],
    required: ["bookId"],
    path: "fangs",
  },
  yao: {
    menuCode: ADMIN_MENU_CODES.YAO,
    params: ["bookId"],
    required: ["bookId"],
    path: "yao",
  },
  term: {
    menuCode: ADMIN_MENU_CODES.TERM,
    params: ["bookId"],
    required: ["bookId"],
    path: "term",
  },
} as const satisfies Record<string, ReturnBoardSpec>;

export type AdminReturnBoard = keyof typeof RETURN_BOARDS;

/** 解析好的「回到你点进来的地方」。 */
export interface AdminReturnTarget {
  /** 返回链接文案的 i18n 键（`menu.item.<code>`）。 */
  labelKey: string;
  /** 编辑器应当高亮的菜单行。 */
  menuCode: AdminMenuCode;
  /** 要回去的后台地址，含查询串。 */
  url: string;
}

/** 超过这个长度的参数不是看板状态，是噪声。 */
const MAX_PARAM_LENGTH = 200;

function isReturnBoard(name: string): name is AdminReturnBoard {
  // 用 hasOwnProperty 而不是 in：`from=toString` 不能解析成原型上的函数。
  return Object.prototype.hasOwnProperty.call(RETURN_BOARDS, name);
}

/** 按注册项声明的顺序挑出这个看板的参数，空值与噪声一并丢掉。 */
function pickBoardParams(
  search: URLSearchParams,
  spec: ReturnBoardSpec,
): URLSearchParams {
  const query = new URLSearchParams();
  for (const name of spec.params) {
    const value = (search.get(name) ?? "").trim();
    if (!value || value.length > MAX_PARAM_LENGTH) continue;
    query.set(name, value);
  }
  return query;
}

/**
 * 从编辑器地址上读 `?from=…`，解析成返回目标。
 *
 * 没自报家门、名字不在注册表里、或缺少看板必需的参数，一律返回 `null`，
 * 调用方保留自己的默认返回链接——总好过把人送到一个空看板上。
 */
export function resolveAdminReturnTarget(
  search: URLSearchParams,
  adminPath?: string | null,
): AdminReturnTarget | null {
  const from = search.get("from");
  if (!from || !isReturnBoard(from)) return null;
  const spec = RETURN_BOARDS[from];

  const query = pickBoardParams(search, spec);
  for (const name of spec.required) {
    if (!query.has(name)) return null;
  }

  const path = adminUrl(spec.path, adminPath);
  const suffix = query.toString();
  return {
    labelKey: menuItemLabelKey(spec.menuCode),
    menuCode: spec.menuCode,
    url: suffix ? `${path}?${suffix}` : path,
  };
}

/**
 * 看板拼到编辑器链接上的查询串，让编辑器知道该回哪儿。
 *
 * 参数按注册项声明的顺序输出，同一份看板状态永远产出同一个地址。
 */
export function adminReturnQuery(
  board: AdminReturnBoard,
  params: Record<string, string | null | undefined>,
): string {
  if (!isReturnBoard(board)) {
    throw new Error(`Unknown return board: ${String(board)}`);
  }
  const query = new URLSearchParams({from: board});
  for (const name of RETURN_BOARDS[board].params) {
    const value = params[name];
    if (typeof value === "string" && value) query.set(name, value);
  }
  return query.toString();
}
