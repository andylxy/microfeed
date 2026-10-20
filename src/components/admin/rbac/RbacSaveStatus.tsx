import {CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {cn} from "@/lib/utils";

/** 右栏详情的一次保存处在什么阶段。`idle` 不渲染任何东西。 */
export type RbacSaveState = "error" | "idle" | "saved" | "saving";

export interface RbacSaveStatusProps {
  /** 失败原因（服务端回传的错误文案）；只在 `error` 态显示。 */
  detail?: string | null;
  /** 失败态的重试入口：重发上一次没写进去的操作。 */
  onRetry?: () => void;
  state: RbacSaveState;
}

/**
 * 详情面板的保存状态条：编辑是失焦即存，这条就是把「存了没」亮出来——
 * 存中有转圈、成功打勾并在几秒后由调用方收起、失败给原因和重试按钮。
 * 放在面板内容上方常驻位置，用户改完字段视线不用挪就能看到结果。
 */
export function RbacSaveStatus({detail, onRetry, state}: RbacSaveStatusProps) {
  const {t} = useTranslation();
  if (state === "idle") return null;
  if (state === "error") {
    return (
      <div
        aria-live="polite"
        className={cn(
          "mb-4 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm",
          "border-destructive/40 bg-destructive/5 text-destructive",
        )}
      >
        <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
        <span>
          {t("rbac.saveFailed")}
          {detail ? `：${detail}` : ""}
        </span>
        {onRetry && (
          <Button
            className="ml-auto"
            onClick={onRetry}
            size="xs"
            type="button"
            variant="outline"
          >
            {t("rbac.retry")}
          </Button>
        )}
      </div>
    );
  }
  const saved = state === "saved";
  return (
    <div
      aria-live="polite"
      className={cn(
        "mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
        saved
          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {saved ? (
        <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0" />
      ) : (
        <LoaderCircleIcon aria-hidden="true" className="size-4 shrink-0 animate-spin" />
      )}
      <span>{saved ? t("rbac.saved") : t("rbac.saving")}</span>
    </div>
  );
}
