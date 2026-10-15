import {useId, useState} from "react";

import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {RadioGroup, RadioGroupItem} from "@/components/ui/radio-group";

export type PurgeChoice = "archive" | "purge";

interface Props {
  busy?: boolean;
  confirmToken: string;
  onChoose: (choice: PurgeChoice) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

/**
 * 删除二选一对话框（ADR-0026 D6）：归档（软删除，现状行为）/ 永久删除（purge）。
 * 永久删除需输入 confirmToken（调用方给记录标识，如 package@version）才会放行；
 * 归档沿用各资源既有的软删除端点，本组件只负责收口交互。
 */
export default function PurgeConfirmDialog({
  busy = false,
  confirmToken,
  onChoose,
  onOpenChange,
  open,
}: Props) {
  const {t} = useTranslation();
  const [choice, setChoice] = useState<PurgeChoice>("archive");
  const [typed, setTyped] = useState("");
  const inputId = useId();

  const requiresToken = choice === "purge";
  const confirmed = !requiresToken || typed.trim() === confirmToken;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("purge.title")}</DialogTitle>
          <DialogDescription className="sr-only">{confirmToken}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={choice}
          onValueChange={(value) => setChoice(value as PurgeChoice)}
          className="grid gap-3"
        >
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
            <RadioGroupItem value="archive" />
            <span className="grid gap-1">
              <span className="text-sm font-medium">{t("purge.archiveOption")}</span>
              <span className="text-xs text-muted-foreground">{t("purge.archiveHint")}</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
            <RadioGroupItem value="purge" />
            <span className="grid gap-1">
              <span className="text-sm font-medium">{t("purge.purgeOption")}</span>
              <span className="text-xs text-muted-foreground">{t("purge.purgeHint")}</span>
            </span>
          </label>
        </RadioGroup>
        {requiresToken && (
          <div className="grid gap-2">
            <label className="text-sm" htmlFor={inputId}>
              {t("purge.confirmPrompt", {target: confirmToken})}
            </label>
            <Input
              id={inputId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={confirmToken}
            />
            {typed.length > 0 && !confirmed && (
              <p className="text-xs text-destructive">{t("purge.mismatch")}</p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant={choice === "purge" ? "destructive" : "default"}
            disabled={!confirmed || busy}
            onClick={() => void onChoose(choice)}
          >
            {choice === "purge" ? t("purge.purgeOption") : t("purge.archiveOption")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
