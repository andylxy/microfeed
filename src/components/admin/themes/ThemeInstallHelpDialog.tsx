import {BookOpenIcon, ExternalLinkIcon} from "lucide-react";

import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {
  MICROFEED_MANAGE_COMMAND,
  managementCommand,
} from "@/shared/ManagementCli";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const THEME_GUIDE_URL = "https://docs.microfeed.org/dashboard/themes/";
const THEME_COMMAND_REFERENCE_URL =
  "https://docs.microfeed.org/manage-cli/#yarn-manage-theme";

interface Props {
  instanceName: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

function Command({children}: {children: string}) {
  return (
    <code className="block overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">
      {children}
    </code>
  );
}

export default function ThemeInstallHelpDialog({
  instanceName,
  onOpenChange,
  open,
}: Props) {
  const {t} = useTranslation();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("themes.installHelpTitle")}</DialogTitle>
          <DialogDescription>
            {t("themes.installHelpDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 text-sm leading-relaxed">
          <p className="rounded-lg border bg-muted/40 p-3 text-muted-foreground">
            {t("themes.installNoteBefore")}{" "}
            <code>{MICROFEED_MANAGE_COMMAND}</code>{" "}
            {t("themes.installNoteAfter")}
          </p>
          <section className="grid gap-3">
            <div>
              <h3 className="font-semibold">{t("themes.installCommunityTitle")}</h3>
              <p className="mt-1 text-muted-foreground">
                {t("themes.installCommunityDesc")}
              </p>
            </div>
            <Command>
              {managementCommand(`theme install https://github.com/owner/theme-repository --instance ${instanceName}`)}
            </Command>
          </section>

          <section className="grid gap-3">
            <div>
              <h3 className="font-semibold">{t("themes.installBuiltInTitle")}</h3>
              <p className="mt-1 text-muted-foreground">
                {t("themes.installBuiltInDesc")}
              </p>
            </div>
            <Command>
              {managementCommand(`theme install bundled:default --instance ${instanceName}`)}
            </Command>
          </section>

          <section>
            <h3 className="font-semibold">{t("themes.newVersionAdminTitle")}</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>{t("themes.newVersionStep1")}</li>
              <li>{t("themes.newVersionStep2")}</li>
              <li>{t("themes.newVersionStep3")}</li>
              <li>{t("themes.newVersionStep4")}</li>
            </ol>
            <p className="mt-2 text-muted-foreground">
              {t("themes.newVersionNote")}
            </p>
          </section>

          <section className="grid gap-3">
            <div>
              <h3 className="font-semibold">{t("themes.ownRepoTitle")}</h3>
              <p className="mt-1 text-muted-foreground">
                {t("themes.ownRepoDesc")}
              </p>
            </div>
            <Command>
              {managementCommand(`theme init ~/microfeed-themes/my-theme --instance ${instanceName}`)}
            </Command>
          </section>

          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              render={<a href={THEME_GUIDE_URL} rel="noopener noreferrer" target="_blank" />}
              variant="outline"
            >
              <BookOpenIcon aria-hidden="true" />
              {t("themes.themeGuide")}
            </Button>
            <Button
              render={<a href={THEME_COMMAND_REFERENCE_URL} rel="noopener noreferrer" target="_blank" />}
              variant="outline"
            >
              <ExternalLinkIcon aria-hidden="true" />
              {t("themes.commandReference")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
