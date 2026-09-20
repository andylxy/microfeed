import {useCallback, useEffect, useState} from "react";

import {useTranslation} from "@/client/i18n";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface AuditChapter {
  id: string;
  changeCount: number;
  lastChangedAt: number | null;
  title: string;
}

function formatDateTime(value: number | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {hour12: false});
}

export default function AuditApp() {
  const {t} = useTranslation();
  const [chapters, setChapters] = useState<AuditChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAudit(), {
        headers: {accept: "application/json"},
      });
      const payload = await response.json().catch(() => null) as
        | {chapters?: AuditChapter[]; error?: string}
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? t("audit.loading"));
      }
      setChapters(Array.isArray(payload?.chapters) ? payload.chapters : []);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("audit.loading"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = chapters.filter((chapter) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return (
      chapter.title.toLowerCase().includes(needle) ||
      chapter.id.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">{t("audit.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("audit.intro")}</p>
      </div>

      {loading && chapters.length === 0 ? (
        <AdminCollectionLoading label={t("audit.loading")} />
      ) : null}

      {error ? <AdminCollectionError message={error} retry={() => void load()} /> : null}

      {!loading && !error && filtered.length === 0 ? (
        <div className="rounded-[14px] border bg-card p-8 text-center text-sm text-muted-foreground">
          {t("audit.empty")}
        </div>
      ) : null}

      {filtered.length > 0 ? (
        <div className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
          <div className="border-b p-4">
            <input
              aria-label={t("audit.searchLabel")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("audit.searchPlaceholder")}
              type="search"
              value={search}
            />
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="border-b bg-muted/45 px-5 py-3 text-left font-semibold text-muted-foreground">
                  {t("audit.columnChapter")}
                </th>
                <th className="w-[14%] border-b bg-muted/45 px-5 py-3 text-left font-semibold text-muted-foreground">
                  {t("audit.columnChanges")}
                </th>
                <th className="w-[24%] border-b bg-muted/45 px-5 py-3 text-left font-semibold text-muted-foreground">
                  {t("audit.columnLastChanged")}
                </th>
                <th className="w-[16%] border-b bg-muted/45 px-5 py-3 text-left font-semibold text-muted-foreground">
                  {t("audit.columnTrail")}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((chapter) => (
                <tr className="border-b last:border-0" key={chapter.id}>
                  <td className="px-5 py-4 align-middle">
                    <a
                      className="font-medium hover:underline"
                      href={ADMIN_URLS.editItem(chapter.id)}
                    >
                      {chapter.title || t("review.untitled")}
                    </a>
                  </td>
                  <td className="px-5 py-4 align-middle text-muted-foreground">
                    {chapter.changeCount}
                  </td>
                  <td className="px-5 py-4 align-middle text-muted-foreground">
                    {formatDateTime(chapter.lastChangedAt)}
                  </td>
                  <td className="px-5 py-4 align-middle">
                    <a
                      className="hover:underline"
                      href={ADMIN_URLS.auditItem(chapter.id)}
                    >
                      {t("audit.viewTrail")}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
