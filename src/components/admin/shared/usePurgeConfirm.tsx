import {useCallback, useState, type ReactElement} from "react";

import PurgeConfirmDialog, {type PurgeChoice} from "./PurgeConfirmDialog";

interface Options<T> {
  /** 对话框打开期间是否忙碌（禁用确认按钮）。 */
  busy: boolean;
  /** 从目标行派生输入确认用的记录标识（themes 为 package@version）。 */
  confirmToken: (target: T) => string;
  /** 用户选定归档 / 永久删除后执行；弹窗先关，出错提示由调用方负责。 */
  onConfirm: (target: T, choice: PurgeChoice) => void | Promise<void>;
}

interface PurgeConfirm<T> {
  dialog: ReactElement;
  purgeTarget: T | null;
  requestPurge: (target: T) => void;
}

/**
 * 删除二选一对话框（ADR-0026 D6）的状态与接线。四个后台 CRUD 页
 * （themes / announcements / pages / webhook endpoints）的入口形态逐字相同，
 * 收口在这一处：持有 purgeTarget、派生 confirmToken、选定后关窗并转交
 * onConfirm。忙碌与错误提示归各页既有的 run / confirmDeletion 负责。
 */
export default function usePurgeConfirm<T>(options: Options<T>): PurgeConfirm<T> {
  const [purgeTarget, setPurgeTarget] = useState<T | null>(null);
  const {busy, confirmToken, onConfirm} = options;
  const choose = useCallback(
    (choice: PurgeChoice) => {
      const target = purgeTarget;
      if (!target) return;
      setPurgeTarget(null);
      return onConfirm(target, choice);
    },
    [onConfirm, purgeTarget],
  );
  const dialog = (
    <PurgeConfirmDialog
      busy={busy}
      confirmToken={purgeTarget ? confirmToken(purgeTarget) : ""}
      onChoose={choose}
      onOpenChange={(open) => {if (!open) setPurgeTarget(null);}}
      open={purgeTarget !== null}
    />
  );
  return {
    dialog,
    purgeTarget,
    requestPurge: (target: T) => setPurgeTarget(target),
  };
}
