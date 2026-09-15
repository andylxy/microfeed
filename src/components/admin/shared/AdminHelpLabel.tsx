import {useState, type ReactNode} from "react";
import {CircleArrowRightIcon} from "lucide-react";

import {cn} from "@/lib/utils";
import {ADMIN_URLS, PUBLIC_URLS} from "@/shared/StringUtils";
import {useTranslation} from "@/client/i18n";

import AdminDialog from "./AdminDialog";
import ExternalLink from "./ExternalLink";

export interface AdminHelpContent {
  json?: string | null;
  linkName: string;
  modalTitle?: string;
  rss?: string | null;
  text: string;
}

interface AdminHelpLabelBaseProps {
  className?: string;
  id?: string;
  required?: boolean;
}

type AdminHelpLabelProps = AdminHelpLabelBaseProps & (
  | {
    children?: ReactNode;
    help: AdminHelpContent;
    onClick?: never;
  }
  | {
    children: ReactNode;
    help?: never;
    onClick: () => void;
  }
);

export default function AdminHelpLabel({
  children,
  className,
  help,
  id,
  onClick,
  required = false,
}: AdminHelpLabelProps) {
  const {t} = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const label = children ?? help?.linkName;

  return (
    <>
      <button
        className={cn(
          "mb-1 flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-brand-light focus-visible:text-brand-light",
          className,
        )}
        id={id}
        onClick={help ? () => setIsOpen(true) : onClick}
        type="button"
      >
        <span>
          {label}
          {required && (
            <span aria-hidden="true" className="text-destructive"> *</span>
          )}
        </span>
        <CircleArrowRightIcon aria-hidden="true" className="size-4" />
      </button>
      {help && (
        <AdminDialog
          onOpenChange={setIsOpen}
          open={isOpen}
          title={help.modalTitle || help.linkName}
        >
          <div className="py-2">
            <div className="text-helper-color grid grid-cols-1 gap-4 text-sm">
              <div
                className="leading-relaxed"
                dangerouslySetInnerHTML={{__html: help.text}}
              />
              {help.rss ? (
                <div>
                  <div>
                    <ExternalLink text={t("shared.inRss")} url={PUBLIC_URLS.rssFeed()} />
                  </div>
                  <code className="m-code">{help.rss}</code>
                  <div className="text-muted-color mt-2 text-xs">
                    {t("shared.learnMorePodcastsRss")}{" "}
                    <a
                      className="text-helper-color"
                      href="https://help.apple.com/itc/podcasts_connect/#/itcb54353390"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      apple.com
                    </a>.
                  </div>
                </div>
              ) : (
                <em>{t("shared.notInRssFeed", {label: help.linkName})}</em>
              )}
              {help.json ? (
                <div>
                  <div>
                    <ExternalLink text={t("shared.inJson")} url={PUBLIC_URLS.jsonFeed()} />
                  </div>
                  <code className="m-code">{help.json}</code>
                  <div className="text-muted-color mt-2 text-xs">
                    {t("shared.learnMoreJsonFeed")}{" "}
                    <a
                      className="text-helper-color"
                      href="https://www.jsonfeed.org/"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      jsonfeed.org
                    </a>. {t("shared.seeGeneratedSchema")}{" "}
                    <a
                      className="text-helper-color"
                      href={ADMIN_URLS.apiExplorer()}
                    >
                      {t("shared.apiExplorer")}
                    </a>.
                  </div>
                </div>
              ) : (
                <em>{t("shared.notInJsonFeed", {label: help.linkName})}</em>
              )}
            </div>
          </div>
        </AdminDialog>
      )}
    </>
  );
}
