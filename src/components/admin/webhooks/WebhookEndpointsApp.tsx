import {
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
} from "lucide-react";
import {useState} from "react";

import AdminSectionCard from "@/components/admin/shared/AdminSectionCard";
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
import {Label} from "@/components/ui/label";
import {Switch} from "@/components/ui/switch";
import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import i18n from "@/client/i18n";
import type {WebhookEndpointSummary} from "@/shared/Webhooks";
import {adminUrl, browserAdminPath} from "@/shared/AdminPath";
import {WEBHOOK_QUICKSTART_ENDPOINT_URL} from "@/shared/WebhookQuickstarts";
import {WEBHOOK_EVENT_TYPES, WEBHOOK_LIMITS, type WebhookEventType} from "@/shared/Webhooks";

interface Props {
  enabled: boolean;
  initialQuickstart?: boolean;
  initialEndpoints: WebhookEndpointSummary[];
}

interface FormValue {
  events: WebhookEventType[];
  name: string;
  url: string;
}

const selectableEvents = WEBHOOK_EVENT_TYPES.filter((event) => event !== "webhook.test");
const emptyForm: FormValue = {events: ["item.published"], name: "", url: ""};

function ajax(path: string): string {
  return adminUrl(`ajax/webhooks/${path}`, browserAdminPath());
}

async function requestJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(ajax(path), {
    ...init,
    headers: {"content-type": "application/json", ...init?.headers},
  });
  const payload = await response.json().catch(() => ({})) as {error?: string};
  if (!response.ok) throw new Error(payload.error ?? i18n.t("webhookCommon.requestFailed"));
  return payload;
}

export default function WebhookEndpointsApp({
  enabled,
  initialEndpoints,
  initialQuickstart = false,
}: Props) {
  const {t} = useTranslation();
  const [endpoints, setEndpoints] = useState(initialEndpoints);
  const [form, setForm] = useState<FormValue>(() => ({
    ...emptyForm,
    url: initialQuickstart ? WEBHOOK_QUICKSTART_ENDPOINT_URL : "",
  }));
  const [editingId, setEditingId] = useState<string>();
  const [formOpen, setFormOpen] = useState(
    initialQuickstart && initialEndpoints.length > 0,
  );
  const [busy, setBusy] = useState(false);
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretEndpoint, setSecretEndpoint] = useState<WebhookEndpointSummary>();
  const [secretValue, setSecretValue] = useState<string>();
  const [secretVisible, setSecretVisible] = useState(false);

  const slotDescription = t("webhookEndpoints.slotDescription", {
    count: endpoints.length,
    limit: WEBHOOK_LIMITS.endpointCount,
  });
  const closeForm = () => {
    setFormOpen(false);
    setEditingId(undefined);
    setForm(emptyForm);
  };
  const openCreate = () => {
    setEditingId(undefined);
    setForm(emptyForm);
    setFormOpen(true);
  };
  const openEdit = (endpoint: WebhookEndpointSummary) => {
    setEditingId(endpoint.id);
    setForm({events: endpoint.events, name: endpoint.name, url: endpoint.url});
    setFormOpen(true);
  };
  const openSecret = (
    endpoint: WebhookEndpointSummary,
    secret?: string,
  ) => {
    setSecretEndpoint(endpoint);
    setSecretValue(secret);
    setSecretVisible(Boolean(secret));
  };
  const closeSecret = () => {
    if (secretBusy) return;
    setSecretEndpoint(undefined);
    setSecretValue(undefined);
    setSecretVisible(false);
  };

  const refresh = async () => {
    setEndpoints(await requestJson("endpoints"));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await requestJson(
        editingId ? `endpoints/${editingId}` : "endpoints",
        {body: JSON.stringify(form), method: editingId ? "PUT" : "POST"},
      );
      await refresh();
      showToast(editingId ? t("webhookEndpoints.updatedToast") : t("webhookEndpoints.addedToast"), "success");
      closeForm();
      if (result.secret && result.endpoint) {
        openSecret(result.endpoint, result.secret);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const action = async (endpoint: WebhookEndpointSummary, actionName: string) => {
    if (actionName === "delete" && !window.confirm(t("webhookEndpoints.deleteConfirm", {name: endpoint.name}))) return;
    setBusy(true);
    try {
      const method = actionName === "delete" ? "DELETE" : "POST";
      await requestJson(
        `endpoints/${endpoint.id}${actionName === "delete" ? "" : `/${actionName}`}`,
        {body: method === "POST" ? "{}" : undefined, method},
      );
      await refresh();
      showToast(actionName === "test" ? t("webhookEndpoints.testQueuedToast") : t("webhookEndpoints.actionCompleteToast", {action: actionName}), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (
    endpoint: WebhookEndpointSummary,
    active: boolean,
  ) => {
    setBusy(true);
    try {
      await requestJson(`endpoints/${endpoint.id}`, {
        body: JSON.stringify({status: active ? "active" : "disabled"}),
        method: "PUT",
      });
      await refresh();
      showToast(active ? t("webhookEndpoints.enabledToast") : t("webhookEndpoints.disabledToast"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const openTest = (endpoint: WebhookEndpointSummary) => {
    const query = new URLSearchParams({
      endpoint: endpoint.id,
      event: "webhook.test",
    });
    window.location.assign(
      `${adminUrl("webhooks/events", browserAdminPath())}?${query}`,
    );
  };
  const toggleSecret = async () => {
    if (!secretEndpoint) return;
    if (secretVisible) {
      setSecretVisible(false);
      return;
    }
    if (secretValue) {
      setSecretVisible(true);
      return;
    }
    setSecretBusy(true);
    try {
      const result = await requestJson(
        `endpoints/${secretEndpoint.id}/secret`,
      );
      setSecretValue(result.secret);
      setSecretVisible(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSecretBusy(false);
    }
  };
  const copySecret = async () => {
    if (!secretValue) return;
    await navigator.clipboard.writeText(secretValue);
    showToast(t("webhookEndpoints.secretCopiedToast"), "success");
  };
  const rotateSecret = async () => {
    if (!secretEndpoint || !window.confirm(
      t("webhookEndpoints.rotateConfirm", {name: secretEndpoint.name}),
    )) return;
    setSecretBusy(true);
    try {
      const result = await requestJson(
        `endpoints/${secretEndpoint.id}/rotate`,
        {body: "{}", method: "POST"},
      );
      if (!result.secret || !result.endpoint) {
        throw new Error(t("webhookEndpoints.secretNotReturned"));
      }
      setSecretEndpoint(result.endpoint);
      setSecretValue(result.secret);
      setSecretVisible(true);
      await refresh();
      showToast(
        t("webhookEndpoints.rotatedToast"),
        "success",
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSecretBusy(false);
    }
  };

  return (
    <div className="grid gap-6">
      <Dialog
        onOpenChange={(open) => {
          if (!open) closeSecret();
        }}
        open={Boolean(secretEndpoint)}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LockKeyholeIcon aria-hidden="true" className="size-4" />
              {t("webhookEndpoints.signingSecretTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("webhookEndpoints.signingSecretDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-1 rounded-lg bg-muted p-2">
            <code className="min-w-0 flex-1 overflow-x-auto px-2 py-1 text-sm">
              {secretVisible && secretValue
                ? secretValue
                : `whsec_${"•".repeat(24)}`}
            </code>
            <Button
              aria-label={secretVisible ? t("webhookEndpoints.hideSecret") : t("webhookEndpoints.revealSecret")}
              disabled={secretBusy}
              onClick={() => void toggleSecret()}
              size="icon-sm"
              title={secretVisible ? t("webhookEndpoints.hideSecret") : t("webhookEndpoints.revealSecret")}
              type="button"
              variant="ghost"
            >
              {secretVisible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
            </Button>
            <Button
              aria-label={t("webhookEndpoints.copySecret")}
              disabled={secretBusy || !secretValue}
              onClick={() => void copySecret()}
              size="icon-sm"
              title={t("webhookEndpoints.copySecret")}
              type="button"
              variant="ghost"
            >
              <CopyIcon aria-hidden="true" />
            </Button>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            {t("webhookEndpoints.secretStorage")}
          </p>
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/8 p-3 text-sm leading-6">
            {t("webhookEndpoints.rotateNote")}
          </div>
          <DialogFooter>
            <Button
              disabled={secretBusy}
              onClick={() => void rotateSecret()}
              type="button"
              variant="outline"
            >
              <RefreshCwIcon aria-hidden="true" />
              {t("webhookEndpoints.rotateButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {endpoints.length === 0 && (
        <AdminSectionCard description={slotDescription} title={t("webhookEndpoints.addEndpointTitle")}>
          <EndpointForm
            busy={busy}
            editing={false}
            enabled={enabled}
            endpointCount={endpoints.length}
            form={form}
            onChange={setForm}
            onSubmit={submit}
          />
        </AdminSectionCard>
      )}

      {endpoints.length > 0 && (
        <Dialog
          onOpenChange={(open) => {
            if (!open && busy) return;
            if (open) setFormOpen(true);
            else closeForm();
          }}
          open={formOpen}
        >
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl lg:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{editingId ? t("webhookEndpoints.editEndpointTitle") : t("webhookEndpoints.addEndpointTitle")}</DialogTitle>
              <DialogDescription>{slotDescription}</DialogDescription>
            </DialogHeader>
            <EndpointForm
              busy={busy}
              editing={Boolean(editingId)}
              enabled={enabled}
              endpointCount={endpoints.length}
              form={form}
              onCancel={closeForm}
              onChange={setForm}
              onSubmit={submit}
            />
          </DialogContent>
        </Dialog>
      )}

      <AdminSectionCard
        action={endpoints.length > 0 ? (
          <Button
            disabled={busy || !enabled || endpoints.length >= WEBHOOK_LIMITS.endpointCount}
              onClick={openCreate}
              size="sm"
              type="button"
            >
              {t("webhookEndpoints.addEndpointButton")}
            </Button>
        ) : undefined}
        description={endpoints.length > 0
          ? <>{slotDescription} {t("webhookEndpoints.testsBudgetNote")}</>
          : t("webhookEndpoints.testsBudgetNote")}
        title={t("webhookEndpoints.configuredEndpoints")}
      >
        {endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("webhookEndpoints.noEndpoints")}</p>
        ) : (
          <ul className="grid gap-4">
            {endpoints.map((endpoint) => (
              <li className="rounded-xl border p-4" key={endpoint.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{endpoint.name}</h3>
                      <div className="flex items-center gap-2">
                        <Switch
                          aria-label={t("webhookEndpoints.endpointStatusAria", {name: endpoint.name})}
                          checked={endpoint.status === "active"}
                          disabled={busy || endpoint.status === "auto_paused"}
                          id={`webhook-endpoint-status-${endpoint.id}`}
                          onCheckedChange={(checked) => void setStatus(endpoint, checked)}
                        />
                        <Label
                          className={endpoint.status === "auto_paused"
                            ? "text-amber-700 dark:text-amber-300"
                            : endpoint.status === "active"
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-muted-foreground"}
                          htmlFor={`webhook-endpoint-status-${endpoint.id}`}
                        >
                          {endpoint.status === "auto_paused"
                            ? t("webhookEndpoints.statusAutoPaused")
                            : endpoint.status === "active"
                            ? t("webhookEndpoints.statusActive")
                            : t("webhookEndpoints.statusDisabled")}
                        </Label>
                      </div>
                    </div>
                    <p className="mt-1 break-all text-sm text-muted-foreground">{endpoint.url}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{endpoint.events.join(", ")} · {t("webhookEndpoints.consecutiveFailures", {count: endpoint.consecutiveTerminalFailures})}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => openEdit(endpoint)} size="sm" type="button" variant="outline">{t("webhookEndpoints.editButton")}</Button>
                    <Button disabled={busy || endpoint.status === "disabled"} onClick={() => openTest(endpoint)} size="sm" type="button" variant="outline">{t("webhookEndpoints.testButton")}</Button>
                    <Button disabled={busy} onClick={() => openSecret(endpoint)} size="sm" type="button" variant="outline">{t("webhookEndpoints.signingSecretButton")}</Button>
                    {endpoint.status === "auto_paused" ? (
                      <Button disabled={busy || !endpoint.resumeTestedAt} onClick={() => action(endpoint, "resume")} size="sm" type="button">{t("webhookEndpoints.resumeButton")}</Button>
                    ) : null}
                    <Button disabled={busy} onClick={() => action(endpoint, "delete")} size="sm" type="button" variant="destructive">{t("webhookEndpoints.deleteButton")}</Button>
                  </div>
                </div>
                {endpoint.status === "auto_paused" && <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm">{t("webhookEndpoints.autoPausedNote")}</p>}
              </li>
            ))}
          </ul>
        )}
      </AdminSectionCard>
    </div>
  );
}

function EndpointForm({
  busy,
  editing,
  enabled,
  endpointCount,
  form,
  onCancel,
  onChange,
  onSubmit,
}: {
  busy: boolean;
  editing: boolean;
  enabled: boolean;
  endpointCount: number;
  form: FormValue;
  onCancel?: () => void;
  onChange: (form: FormValue) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const {t} = useTranslation();
  return (
    <form className="grid gap-5" onSubmit={onSubmit}>
      <div className="grid gap-2">
        <Label htmlFor="webhook-name">{t("webhookEndpoints.formName")}</Label>
        <Input id="webhook-name" maxLength={80} onChange={(event) => onChange({...form, name: event.target.value})} required value={form.name} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="webhook-url">{t("webhookEndpoints.formUrl")}</Label>
        <Input id="webhook-url" onChange={(event) => onChange({...form, url: event.target.value})} placeholder={t("webhookEndpoints.formUrlPlaceholder")} required type="url" value={form.url} />
        <p className="text-xs text-muted-foreground">{t("webhookEndpoints.formUrlHint")}</p>
      </div>
      {!editing && (
        <div className="rounded-xl bg-muted p-4 text-sm leading-6">
          <p className="font-medium">{t("webhookEndpoints.authTitle")}</p>
          <p className="mt-1 text-muted-foreground">
            {t("webhookEndpoints.authBody")}
          </p>
        </div>
      )}
      <fieldset>
        <legend className="text-sm font-medium">{t("webhookEndpoints.subscribedEventsLegend")}</legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {selectableEvents.map((eventType) => (
            <label className="flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm" key={eventType}>
              <input
                checked={form.events.includes(eventType)}
                onChange={(event) => onChange({...form, events: event.target.checked ? [...form.events, eventType] : form.events.filter((value) => value !== eventType)})}
                type="checkbox"
              />
              <code>{eventType}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !enabled || endpointCount >= WEBHOOK_LIMITS.endpointCount && !editing} type="submit">{editing ? t("webhookEndpoints.saveEndpoint") : t("webhookEndpoints.createEndpoint")}</Button>
        {onCancel && <Button disabled={busy} onClick={onCancel} type="button" variant="outline">{t("common.cancel")}</Button>}
      </div>
    </form>
  );
}
