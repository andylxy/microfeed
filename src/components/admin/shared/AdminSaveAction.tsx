import type {ReactNode} from "react";

import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import type {
  AutosavePhase,
  AutosaveState,
} from "@/client/AutosaveCoordinator";

interface Props extends AutosaveState {
  buttonLabel?: string;
  children?: ReactNode;
  idleMessage?: string;
}

export default function AdminSaveAction({
  buttonLabel,
  children,
  dirty,
  idleMessage,
  phase,
}: Props) {
  const {t} = useTranslation();
  const statusKeys: Record<Exclude<AutosavePhase, "idle">, string> = {
    error: "saveAction.error",
    pending: "saveAction.pending",
    saved: "saveAction.saved",
    saving: "saveAction.saving",
  };
  const message = phase === "idle"
    ? (idleMessage ?? t("saveAction.idleMessage"))
    : t(statusKeys[phase]);
  const failed = phase === "error";
  const saving = phase === "saving";

  return (
    <div className="rounded-[14px] border bg-card p-5 text-center text-card-foreground shadow-xs">
      <p
        aria-live="polite"
        className={failed
          ? "text-sm text-destructive"
          : "text-sm text-muted-foreground"}
      >
        {message}
      </p>
      <Button
        className="mt-3 w-full"
        disabled={!dirty || saving}
        size="lg"
        type="submit"
      >
        {failed ? t("saveAction.retry") : (buttonLabel ?? t("saveAction.saveNow"))}
      </Button>
      {children && <div className="mt-4 border-t pt-4">{children}</div>}
    </div>
  );
}
