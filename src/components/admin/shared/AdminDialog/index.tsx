import type {ReactNode} from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {cn} from "@/lib/utils";

/** 默认尺寸：宽度固定档位；高度由内容撑开，`max-h` 只是防超屏的上限。 */
const DEFAULT_CONTENT_CLASS =
  "max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg lg:max-w-xl";

interface AdminDialogProps {
  children: ReactNode;
  closeDisabled?: boolean;
  /**
   * 覆盖弹层容器尺寸，与默认值一起走 `cn` 合并（后传的同类 class 覆盖默认）。
   * 调用方可给按视口自适应的宽度与 `dvh` 高度上限；不传的弹层行为完全不变。
   */
  contentClassName?: string;
  /**
   * 是否禁止点击弹层外部（遮罩/空白处）关闭。默认 `false`（保持既有行为）。
   * 传 `true` 后只有显式「关闭/取消」或 Esc 才会关，避免误点空白把编辑中的
   * 表单关掉——适合编辑类弹层。
   */
  disablePointerDismissal?: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: ReactNode;
}

export default function AdminDialog({
  children,
  closeDisabled = false,
  contentClassName,
  disablePointerDismissal = false,
  onOpenChange,
  open,
  title,
}: AdminDialogProps) {
  return (
    <Dialog
      disablePointerDismissal={disablePointerDismissal}
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        if (!nextOpen && closeDisabled) {
          eventDetails.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className={cn(DEFAULT_CONTENT_CLASS, contentClassName)}
        showCloseButton={!closeDisabled}
      >
        <DialogHeader className="border-b pb-2 pr-8">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
