import {useEffect, useMemo, useState} from "react";
import i18n, {useTranslation} from "@/client/i18n";

import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import AdminSectionCard from "@/components/admin/shared/AdminSectionCard";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {showToast} from "@/client/ToastUtils";
import {adminUrl, browserAdminPath} from "@/shared/AdminPath";
import {
  WEBHOOK_EVENT_DEFINITIONS,
  type WebhookEventDefinition,
} from "@/shared/WebhookExamples";
import type {
  WebhookEndpointSummary,
  WebhookEventType,
  WebhookExplorerPreview,
  WebhookExplorerSourceMode,
  WebhookExplorerSubject,
} from "@/shared/Webhooks";

interface Props {
  dailyLimit?: number;
  deliveriesToday?: number;
  endpoints: WebhookEndpointSummary[];
  initialEndpointId?: string;
  initialEventType?: WebhookEventType;
  localPrintAvailable: boolean;
}

type ViewName = "headers" | "payload" | "schema";

function ajax(path: string): string {
  const [pathname, query] = path.split("?", 2);
  const base = adminUrl(
    `ajax/webhooks/explorer/${pathname ?? ""}`,
    browserAdminPath(),
  );
  return query ? `${base}?${query}` : base;
}

async function requestJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(ajax(path), {
    ...init,
    headers: {"content-type": "application/json", ...init?.headers},
  });
  const result = await response.json().catch(() => ({})) as {error?: string};
  if (!response.ok) throw new Error(result.error ?? i18n.t("webhookCommon.eventExplorerRequestFailed"));
  return result;
}

// The definitions in `WEBHOOK_EVENT_DEFINITIONS` stay English: the same objects
// feed the published OpenAPI document. The admin translates them here, keyed by
// the stable event type rather than by the English copy.
export const eventDescriptionKeys: Record<WebhookEventType, string> = {
  "channel.updated": "webhookEvents.eventDescriptions.channelUpdated",
  "item.created": "webhookEvents.eventDescriptions.itemCreated",
  "item.updated": "webhookEvents.eventDescriptions.itemUpdated",
  "item.published": "webhookEvents.eventDescriptions.itemPublished",
  "item.unlisted": "webhookEvents.eventDescriptions.itemUnlisted",
  "item.unpublished": "webhookEvents.eventDescriptions.itemUnpublished",
  "item.deleted": "webhookEvents.eventDescriptions.itemDeleted",
  "page.created": "webhookEvents.eventDescriptions.pageCreated",
  "page.updated": "webhookEvents.eventDescriptions.pageUpdated",
  "page.published": "webhookEvents.eventDescriptions.pagePublished",
  "page.unlisted": "webhookEvents.eventDescriptions.pageUnlisted",
  "page.unpublished": "webhookEvents.eventDescriptions.pageUnpublished",
  "page.deleted": "webhookEvents.eventDescriptions.pageDeleted",
  "page.navigation_updated": "webhookEvents.eventDescriptions.pageNavigationUpdated",
  "site_file.created": "webhookEvents.eventDescriptions.siteFileCreated",
  "site_file.updated": "webhookEvents.eventDescriptions.siteFileUpdated",
  "site_file.published": "webhookEvents.eventDescriptions.siteFilePublished",
  "site_file.reset": "webhookEvents.eventDescriptions.siteFileReset",
  "site_file.deleted": "webhookEvents.eventDescriptions.siteFileDeleted",
  "theme.activated": "webhookEvents.eventDescriptions.themeActivated",
  "theme.deactivated": "webhookEvents.eventDescriptions.themeDeactivated",
  "webhook.test": "webhookEvents.eventDescriptions.webhookTest",
};

export const eventGroupKeys: Record<string, string> = {
  "Channel": "webhookEvents.eventGroups.channel",
  "Items": "webhookEvents.eventGroups.items",
  "Pages": "webhookEvents.eventGroups.pages",
  "Site files": "webhookEvents.eventGroups.siteFiles",
  "Testing": "webhookEvents.eventGroups.testing",
  "Themes": "webhookEvents.eventGroups.themes",
};

function eventGroups(): Array<[string, WebhookEventDefinition[]]> {
  const groups = new Map<string, WebhookEventDefinition[]>();
  for (const event of WEBHOOK_EVENT_DEFINITIONS) {
    groups.set(event.group, [...(groups.get(event.group) ?? []), event]);
  }
  return [...groups.entries()];
}

export default function WebhookEventExplorerApp({
  dailyLimit = 1_000,
  deliveriesToday = 0,
  endpoints,
  initialEndpointId,
  initialEventType = "webhook.test",
  localPrintAvailable,
}: Props) {
  const {t} = useTranslation();
  const [eventType, setEventType] = useState<WebhookEventType>(initialEventType);
  const [sourceMode, setSourceMode] = useState<WebhookExplorerSourceMode>("generated");
  const [query, setQuery] = useState("");
  const [subjects, setSubjects] = useState<WebhookExplorerSubject[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [endpointId, setEndpointId] = useState(() =>
    initialEndpointId ?? endpoints.find(({status}) => status === "active")?.id ?? ""
  );
  const [preview, setPreview] = useState<WebhookExplorerPreview>();
  const [view, setView] = useState<ViewName>("payload");
  const [busy, setBusy] = useState(false);
  const [deliveryId, setDeliveryId] = useState<string>();
  const definition = WEBHOOK_EVENT_DEFINITIONS.find((event) => event.type === eventType)!;
  const endpoint = endpoints.find((entry) => entry.id === endpointId);
  const needsSubject = ["item", "page", "site_file", "theme"].includes(
    definition.sourceKind,
  );
  const subscriptionMismatch = Boolean(
    endpoint && eventType !== "webhook.test" && !endpoint.events.includes(eventType),
  );
  const selection = useMemo(() => ({
    event_type: eventType,
    source_mode: sourceMode,
    ...(sourceMode === "current" && subjectId ? {subject_id: subjectId} : {}),
  }), [eventType, sourceMode, subjectId]);
  const tabLabel: Record<ViewName, string> = {
    payload: t("webhookEvents.payload"),
    schema: t("webhookEvents.schema"),
    headers: t("webhookEvents.headers"),
  };

  useEffect(() => {
    setDeliveryId(undefined);
    if (sourceMode !== "current") {
      setSubjects([]);
      setSubjectId("");
      return;
    }
    if (definition.sourceKind === "webhook") {
      setSourceMode("generated");
      return;
    }
    const timer = window.setTimeout(() => {
      const parameters = new URLSearchParams({event_type: eventType, q: query});
      void requestJson(`subjects?${parameters}`).then((result: WebhookExplorerSubject[]) => {
        setSubjects(result);
        setSubjectId((current) =>
          result.some(({id}) => id === current) ? current : result[0]?.id ?? ""
        );
      }).catch((error) => showToast(error.message, "error"));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [definition.sourceKind, eventType, query, sourceMode]);

  useEffect(() => {
    if (sourceMode === "current" && needsSubject && !subjectId) {
      setPreview(undefined);
      return;
    }
    let active = true;
    setBusy(true);
    void requestJson("preview", {
      body: JSON.stringify(selection),
      method: "POST",
    }).then((result: WebhookExplorerPreview) => {
      if (active) setPreview(result);
    }).catch((error) => {
      if (active) showToast(error.message, "error");
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [needsSubject, selection, sourceMode, subjectId]);

  const copy = async (formatted: boolean) => {
    if (!preview) return;
    await navigator.clipboard.writeText(
      formatted ? JSON.stringify(preview.payload, null, 2) : preview.rawBody,
    );
    showToast(formatted ? t("webhookEvents.formattedCopied") : t("webhookEvents.rawCopied"), "success");
  };
  const print = async () => {
    setBusy(true);
    try {
      const result = await requestJson("print", {
        body: JSON.stringify(selection),
        method: "POST",
      });
      setPreview(result);
      showToast(t("webhookEvents.printed"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!endpoint) return;
    const warning = [
      t("webhookEvents.sendConfirmIntro", {eventType, name: endpoint.name}),
      endpoint.url,
      t("webhookEvents.sendConfirmBody1"),
      t("webhookEvents.sendConfirmBody2", {count: Math.max(dailyLimit - deliveriesToday, 0).toLocaleString("en-US")}),
      ...(subscriptionMismatch ? [t("webhookEvents.sendConfirmMismatch")] : []),
    ].join("\n\n");
    if (!window.confirm(warning)) return;
    setBusy(true);
    try {
      const result = await requestJson("send", {
        body: JSON.stringify({...selection, endpoint_id: endpoint.id}),
        method: "POST",
      });
      if (result.delivery?.payload) {
        setPreview((current) => ({
          headers: current?.headers ?? {},
          payload: result.delivery.payload,
          rawBody: JSON.stringify(result.delivery.payload),
          schema: current?.schema ?? {},
        }));
      }
      setDeliveryId(result.deliveryId);
      showToast(
        result.suppressed
          ? t("webhookEvents.sendSuppressed")
          : t("webhookEvents.sendQueued"),
        result.suppressed ? "error" : "success",
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const displayed = view === "payload"
    ? preview?.payload
    : view === "headers"
    ? preview?.headers
    : preview?.schema;
  const displayedJson = preview
    ? JSON.stringify(displayed, null, 2)
    : busy
    ? t("webhookEvents.generatingPreview")
    : t("webhookEvents.chooseContent");
  const deliveriesUrl = deliveryId
    ? `${adminUrl("webhooks/deliveries", browserAdminPath())}?delivery_id=${encodeURIComponent(deliveryId)}`
    : "";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(20rem,0.75fr)_minmax(0,1.25fr)]">
      <AdminSectionCard
        description={t("webhookEvents.buildDescription")}
        title={t("webhookEvents.buildTitle")}
      >
        <div className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="webhook-event-type">{t("webhookEvents.event")}</Label>
            <select
              className="h-10 w-full cursor-pointer rounded-[10px] border border-input bg-background px-3 font-mono text-sm"
              id="webhook-event-type"
              onChange={(event) => {
                setEventType(event.target.value as WebhookEventType);
                setQuery("");
                setSubjectId("");
              }}
              value={eventType}
            >
              {eventGroups().map(([group, events]) => (
                <optgroup key={group} label={t(eventGroupKeys[group] ?? group)}>
                  {events.map((event) => <option key={event.type} value={event.type}>{event.type}</option>)}
                </optgroup>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">{t(eventDescriptionKeys[definition.type])}</p>
          </div>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{t("webhookEvents.dataSource")}</legend>
            <label className="flex items-start gap-3 rounded-xl border p-3">
              <input checked={sourceMode === "generated"} name="source" onChange={() => setSourceMode("generated")} type="radio" />
              <span><span className="block text-sm font-medium">{t("webhookEvents.generatedExample")}</span><span className="text-xs text-muted-foreground">{t("webhookEvents.generatedExampleDesc")}</span></span>
            </label>
            <label className="flex items-start gap-3 rounded-xl border p-3">
              <input disabled={definition.sourceKind === "webhook"} checked={sourceMode === "current"} name="source" onChange={() => setSourceMode("current")} type="radio" />
              <span><span className="block text-sm font-medium">{t("webhookEvents.currentContent")}</span><span className="text-xs text-muted-foreground">{t("webhookEvents.currentContentDesc")}</span></span>
            </label>
          </fieldset>

          {sourceMode === "current" && needsSubject && (
            <div className="grid gap-3">
              <div className="grid gap-2">
                <Label htmlFor="webhook-subject-search">{t("webhookEvents.searchCurrent")}</Label>
                <Input id="webhook-subject-search" onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${definition.sourceKind.replace("_", " ")}s`} value={query} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="webhook-subject">{t("webhookEvents.subject")}</Label>
                <select className="h-10 w-full cursor-pointer rounded-[10px] border border-input bg-background px-3 text-sm" id="webhook-subject" onChange={(event) => setSubjectId(event.target.value)} value={subjectId}>
                  {subjects.length === 0 && <option value="">{t("webhookEvents.noMatchingContent")}</option>}
                  {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.label}{subject.description ? ` — ${subject.description}` : ""}</option>)}
                </select>
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="webhook-endpoint">{t("webhookEvents.sendToEndpoint")}</Label>
            <select className="h-10 w-full cursor-pointer rounded-[10px] border border-input bg-background px-3 text-sm" id="webhook-endpoint" onChange={(event) => setEndpointId(event.target.value)} value={endpointId}>
              <option value="">{t("webhookEvents.chooseEndpoint")}</option>
              {endpoints.map((entry) => <option disabled={entry.status === "disabled"} key={entry.id} value={entry.id}>{entry.name} — {entry.status.replace("_", " ")}</option>)}
            </select>
            {subscriptionMismatch && <p className="rounded-lg bg-amber-500/10 p-3 text-sm">{t("webhookEvents.subscriptionMismatch")}</p>}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !endpoint || endpoint.status === "disabled" || !preview} onClick={send} type="button">{t("webhookEvents.sendTestDelivery")}</Button>
            {localPrintAvailable && <Button disabled={busy || !preview} onClick={print} type="button" variant="outline">{t("webhookEvents.printLocal")}</Button>}
          </div>
          <p className="text-xs text-muted-foreground">{t("webhookEvents.budgetNote", {limit: dailyLimit.toLocaleString("en-US")})}</p>
          {deliveryId && <p className="rounded-lg border p-3 text-sm">{t("webhookEvents.deliveryCreated", {id: deliveryId})} <a className="underline underline-offset-4" href={deliveriesUrl}>{t("webhookEvents.openDeliveryDetails")}</a>.</p>}
        </div>
      </AdminSectionCard>

      <AdminSectionCard
        description={t("webhookEvents.exactContractDescription")}
        title={t("webhookEvents.exactContractTitle")}
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-[10px] bg-muted p-1" role="tablist">
              {(["payload", "schema", "headers"] as const).map((tab) => (
                <button aria-selected={view === tab} className={`h-9 cursor-pointer rounded-lg px-3 text-sm font-medium ${view === tab ? "bg-background shadow-xs" : "text-muted-foreground"}`} key={tab} onClick={() => setView(tab)} role="tab" type="button">{tabLabel[tab]}</button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!preview} onClick={() => void copy(false)} size="sm" type="button" variant="outline">{t("webhookEvents.copyRawJson")}</Button>
              <Button disabled={!preview} onClick={() => void copy(true)} size="sm" type="button" variant="outline">{t("webhookEvents.copyFormattedJson")}</Button>
            </div>
          </div>
          <AdminCodeEditor
            ariaLabel={`${tabLabel[view]} JSON`}
            code={displayedJson}
            language="json"
            maxHeight="44rem"
            minHeight="24rem"
            readOnly
          />
        </div>
      </AdminSectionCard>
    </div>
  );
}
