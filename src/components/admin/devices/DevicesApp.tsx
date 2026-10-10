import {useCallback, useEffect, useMemo, useState} from "react";

import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import AdminPagination, {
  paginate,
} from "@/components/admin/shared/AdminPagination";
import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import type {AdminDeviceRow} from "@/shared/AppDeviceVersion";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface DevicesResponse {
  devices?: AdminDeviceRow[];
  error?: string;
}

interface Props {
  canManage?: boolean;
  itemsPerPage?: number;
}

/**
 * Device board (`/admin/devices/`). Lists every device across every account
 * (spec §6.1) and lets an operator revoke / restore one.
 *
 * Revocation is per-account, not global: `ext_user_devices` is keyed by
 * `(user_id, device_id)`, so the owner column is part of the row's identity
 * (ADR-0001). Revoking needs `system:device:manage`, surfaced here so a
 * read-only holder sees no button that would 403.
 */
export default function DevicesApp({canManage = false, itemsPerPage}: Props) {
  const {t} = useTranslation();
  const [devices, setDevices] = useState<AdminDeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const response = await fetch(`${ADMIN_URLS.ajaxDevices()}${suffix}`);
      const data = await response.json().catch(() => ({})) as DevicesResponse;
      if (!response.ok) throw new Error(data.error ?? t("devices.loadFailed"));
      setDevices(Array.isArray(data.devices) ? data.devices : []);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("devices.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (row: AdminDeviceRow, action: "revoke" | "restore") => {
      const key = `${row.userId}:${row.deviceId}`;
      setBusyKey(key);
      setActionError(null);
      try {
        const url = action === "revoke"
          ? ADMIN_URLS.ajaxDeviceRevoke()
          : ADMIN_URLS.ajaxDeviceRestore();
        const response = await fetch(url, {
          body: JSON.stringify({deviceId: row.deviceId, userId: row.userId}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        const data = await response.json().catch(() => ({})) as {error?: string};
        if (!response.ok) {
          throw new Error(data.error ?? t("devices.actionFailed"));
        }
        await load();
      } catch (mutateError) {
        setActionError(
          mutateError instanceof Error
            ? mutateError.message
            : t("devices.actionFailed"),
        );
      } finally {
        setBusyKey(null);
      }
    },
    [load, t],
  );

  // Free-text filtering is client-side: the whole board loads in one request
  // (the device table is one row per account-device pair), so a keystroke must
  // not trigger a request.
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((row) =>
      row.deviceId.toLowerCase().includes(needle) ||
      (row.username ?? "").toLowerCase().includes(needle) ||
      (row.email ?? "").toLowerCase().includes(needle)
    );
  }, [devices, query]);

  // Client-side paging, size sourced from Settings → Items "每页条目数"
  // (webGlobalSettings.itemsPerPage) via the `itemsPerPage` prop.
  const {pageRows, safePage, totalPages} = paginate(
    rows,
    itemsPerPage,
    page,
  );

  if (loading && devices.length === 0) {
    return <AdminCollectionLoading label={t("devices.title")} />;
  }

  if (error && devices.length === 0) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-xl font-semibold">{t("devices.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("devices.intro")}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-full max-w-sm rounded-md border bg-background px-3 py-2 text-sm"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder={t("devices.searchPlaceholder")}
            type="search"
            value={query}
          />
          <select
            className="rounded-md border bg-background px-3 py-2 text-sm"
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(0);
            }}
            value={statusFilter}
          >
            <option value="">{t("devices.statusAll")}</option>
            <option value="active">{t("devices.statusActive")}</option>
            <option value="revoked">{t("devices.statusRevoked")}</option>
          </select>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("devices.count", {count: rows.length})}
        </span>
      </div>

      {actionError && <p className="text-xs text-destructive">{actionError}</p>}

      {rows.length === 0 ? (
        <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
          <p className="text-sm text-muted-foreground">{t("devices.empty")}</p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("devices.user")}</th>
                <th className="px-4 py-2 font-medium">{t("devices.deviceId")}</th>
                <th className="px-4 py-2 font-medium">{t("devices.status")}</th>
                <th className="px-4 py-2 font-medium">{t("devices.lastSeen")}</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {pageRows.map((row) => {
                const key = `${row.userId}:${row.deviceId}`;
                const revoked = row.status === "revoked";
                return (
                  <tr key={key}>
                    <td className="px-4 py-2">
                      <div className="flex flex-col">
                        <span>{row.username ?? row.userId}</span>
                        {row.email && (
                          <span className="text-xs text-muted-foreground">
                            {row.email}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{row.deviceId}</td>
                    <td className="px-4 py-2">
                      <span
                        className={
                          revoked
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }
                      >
                        {revoked
                          ? t("devices.statusRevoked")
                          : t("devices.statusActive")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap text-muted-foreground">
                      {row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2">
                      {canManage && (
                        <div className="flex items-center justify-end">
                          {revoked ? (
                            <Button
                              disabled={busyKey === key}
                              onClick={() => void mutate(row, "restore")}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              {t("devices.restore")}
                            </Button>
                          ) : (
                            <Button
                              disabled={busyKey === key}
                              onClick={() => void mutate(row, "revoke")}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              {t("devices.revoke")}
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {rows.length > 0 && (
        <AdminPagination
          onChange={setPage}
          page={safePage}
          totalPages={totalPages}
        />
      )}
    </div>
  );
}
