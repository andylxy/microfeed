import {useTranslation} from "@/client/i18n";
import i18n from "@/client/i18n";
import {useId} from "react";
import {BracesIcon, GlobeIcon, RssIcon} from "lucide-react";

import type {AdminPublicLinks} from "@/components/admin/admin-shell-types";
import {cn} from "@/lib/utils";
import {ADMIN_URLS} from "@/shared/StringUtils";
import AdminCopyableUrl from "../AdminCopyableUrl";

interface Props {
  className?: string;
  links: AdminPublicLinks;
}

export function publicAccessItems(links: AdminPublicLinks) {
  return [
    {
      icon: GlobeIcon,
      label: i18n.t("shared.feedWeb"),
      url: links.website,
      summary: i18n.t("shared.webFeedSummary"),
      details: (<div className="grid grid-cols-1 gap-4 py-2">
        <div>
          {i18n.t("shared.webDetailStylingPrefix")}<a href={ADMIN_URLS.settings()}>{i18n.t("shared.linkWebsiteAppearance")}</a>.
        </div>
        <div>
          {i18n.t("shared.webDetailAccessPrefix")}<a href={ADMIN_URLS.settings()}>{i18n.t("shared.linkAccessControl")}</a>.
        </div>
      </div>),
    },
    {
      icon: RssIcon,
      label: i18n.t("shared.feedRss"),
      url: links.rss,
      summary: i18n.t("shared.rssFeedSummary"),
      details: (<div className="grid grid-cols-1 gap-4 py-2">
        <div>
          {i18n.t("shared.rssDetailSpecPrefix")}<a href="https://help.apple.com/itc/podcasts_connect/#/itcb54353390">{i18n.t("shared.applePodcastsSpec")}</a>.
        </div>
        <div>
          {i18n.t("shared.rssDetailDisablePrefix")}<a href={ADMIN_URLS.settings()}>{i18n.t("shared.linkSubscribeMethods")}</a>.
        </div>
      </div>),
    },
    {
      icon: BracesIcon,
      label: i18n.t("shared.feedJson"),
      url: links.json,
      summary: i18n.t("shared.jsonFeedSummary"),
      details: (<div className="grid grid-cols-1 gap-4 py-2">
        <div>
          {i18n.t("shared.jsonDetailSpecPrefix")}<a href="https://www.jsonfeed.org/">{i18n.t("shared.jsonfeedOrg")}</a>{i18n.t("shared.jsonDetailSpecMid")}<a href={ADMIN_URLS.apiExplorer()}>{i18n.t("shared.apiExplorer")}</a>.
        </div>
        <div>
          {i18n.t("shared.jsonDetailDisablePrefix")}<a href={ADMIN_URLS.settings()}>{i18n.t("shared.linkSubscribeMethods")}</a>.
        </div>
      </div>),
    },
  ];
}

export default function AdminPublicAccess({className, links}: Props) {
  const {t} = useTranslation();
  const titleId = useId();
  const items = publicAccessItems(links);

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs",
        className,
      )}
    >
      <h2 className="mb-4 text-lg font-semibold tracking-tight" id={titleId}>
        {t("shared.publicAccess")}
      </h2>
      <div className="mt-8 grid grid-cols-1 gap-8">
        {items.map(({details, icon: Icon, label, summary, url}) => (
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-12"
            key={label}
          >
            <div className="flex items-center gap-2 font-medium sm:col-span-2 sm:self-start sm:py-2">
              <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              <span>{label}</span>
            </div>
            <div className="min-w-0 sm:col-span-10">
              <AdminCopyableUrl label={label} url={url} />
              <div className="mt-2 text-sm text-muted-foreground">
                <details>
                  <summary className="cursor-pointer hover:opacity-50">
                    {summary}
                  </summary>
                  <div className="mt-4 rounded-[10px] bg-muted/70 px-3 py-2">
                    {details}
                  </div>
                </details>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
