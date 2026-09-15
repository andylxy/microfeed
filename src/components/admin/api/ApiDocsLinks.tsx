import {cn} from "@/lib/utils";
import {useTranslation} from "@/client/i18n";
import {API_BASE_PATH} from "@/shared/ApiVersion";

export const API_DOC_LINKS = [
  {href: API_BASE_PATH, labelKey: "docsInteractive"},
  {href: `${API_BASE_PATH}openapi.json`, labelKey: "docsOpenApiJson"},
  {href: `${API_BASE_PATH}openapi.yaml`, labelKey: "docsOpenApiYaml"},
  {href: `${API_BASE_PATH}llms.txt`, labelKey: null},
  {href: `${API_BASE_PATH}llms-full.txt`, labelKey: null},
] as const;

export default function ApiDocsLinks({className}: {className?: string}) {
  const {t} = useTranslation();
  return (
    <ul
      aria-label={t("api.docsFormatsAria")}
      className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs", className)}
    >
      {API_DOC_LINKS.map((docsLink) => (
        <li key={docsLink.href}>
          <a
            className="underline underline-offset-4"
            href={docsLink.href}
            rel="noopener noreferrer"
            target="_blank"
          >
            {docsLink.labelKey
              ? t(`api.${docsLink.labelKey}`)
              : docsLink.href.replace(API_BASE_PATH, "")}
          </a>
        </li>
      ))}
    </ul>
  );
}
