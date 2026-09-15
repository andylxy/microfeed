import {CloudUploadIcon} from "lucide-react";

import {Button, buttonVariants} from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {cn} from "@/lib/utils";
import {managementCommand} from "@/shared/ManagementCli";
import {useTranslation} from "@/client/i18n";

type MediaStorageState = "disabled" | "pending" | "ready";

interface MediaStorageUnavailableDialogProps {
  dashboardUrl?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  state?: MediaStorageState;
}

export function MediaStorageSetupInstructions({
  dashboardUrl,
  state,
}: {
  dashboardUrl?: string;
  state?: MediaStorageState;
}) {
  const {t} = useTranslation();
  const local = !dashboardUrl;
  const command = local
    ? managementCommand("deploy --local --enable-r2")
    : managementCommand("deploy --enable-r2");

  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="font-medium">{t("shared.enableFileUploads")}</div>
      <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        {dashboardUrl && (
          <li>
            {state === "pending"
              ? t("shared.activateR2")
              : t("shared.ensureR2Active")}
          </li>
        )}
        <li>
          {t("shared.runFromFolder")}
          <code className="rounded bg-background px-1.5 py-0.5 text-xs text-foreground ring-1 ring-foreground/10">
            {command}
          </code>
          .
        </li>
        <li>{t("shared.reloadAfterDeploy")}</li>
      </ol>
    </div>
  );
}

export default function MediaStorageUnavailableDialog({
  dashboardUrl,
  onOpenChange,
  open,
  state,
}: MediaStorageUnavailableDialogProps) {
  const {t} = useTranslation();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="pr-8">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <CloudUploadIcon aria-hidden="true" className="size-5" />
          </div>
          <DialogTitle>{t("shared.fileUploadsRequireR2")}</DialogTitle>
          <DialogDescription>
            {t("shared.r2DisabledDesc")}
          </DialogDescription>
        </DialogHeader>
        <MediaStorageSetupInstructions
          dashboardUrl={dashboardUrl}
          state={state}
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.close")}
          </DialogClose>
          {dashboardUrl && (
            <a
              className={cn(buttonVariants(), "cursor-pointer")}
              href={dashboardUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("shared.openCloudflareR2")}
            </a>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
