import {useState} from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import AdminSectionCard from "@/components/admin/shared/AdminSectionCard";
import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {adminUrl, browserAdminPath} from "@/shared/AdminPath";
import {
  MICROFEED_MANAGE_COMMAND,
  managementCommand,
} from "@/shared/ManagementCli";
import {
  WEBHOOK_QUICKSTARTS,
  WEBHOOK_QUICKSTART_ENDPOINT_URL,
  type WebhookQuickstartLanguage,
} from "@/shared/WebhookQuickstarts";
import i18n, {useTranslation} from "@/client/i18n";
import type {WebhookOverview} from "@/shared/Webhooks";
import {WEBHOOK_EVENT_TYPES, WEBHOOK_LIMITS} from "@/shared/Webhooks";

interface Props {
  deploymentEnvironment?: "preview" | "production";
  initialQuickstartMode?: FirstEndpointMode;
  instanceName?: string;
  localDevelopment?: boolean;
  overview: WebhookOverview;
}

function ajax(path: string): string {
  return adminUrl(`ajax/webhooks/${path}`, browserAdminPath());
}

async function requestJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(ajax(path), {
    ...init,
    headers: {"content-type": "application/json", ...init?.headers},
  });
  const payload = await response.json().catch(() => ({})) as {error?: string};
  if (!response.ok) {
    throw new Error(payload.error ?? i18n.t("webhookCommon.requestFailed"));
  }
  return payload;
}

export default function WebhookOverviewApp({
  deploymentEnvironment = "production",
  initialQuickstartMode = "no_code",
  instanceName = "<name>",
  localDevelopment = false,
  overview: initialOverview,
}: Props) {
  const [overview, setOverview] = useState(initialOverview);
  const {t} = useTranslation();
  const remaining = Math.max(
    overview.dailyLimit - overview.deliveriesToday,
    0,
  );
  const endpointUrl = adminUrl("webhooks/endpoints", browserAdminPath());
  const endpointCreateUrl = `${endpointUrl}?quickstart=1`;
  const explorerUrl = `${adminUrl(
    "webhooks/events",
    browserAdminPath(),
  )}?event=webhook.test`;
  const deploymentLabel = deploymentEnvironment === "preview"
    ? "Preview"
    : "Production";
  const deploymentCommand = managementCommand(`deploy ${
    deploymentEnvironment === "preview" ? "--preview " : ""
  }--enable-webhooks --instance ${instanceName}`);
  const disableCommand = managementCommand(`deploy ${
    deploymentEnvironment === "preview" ? "--preview " : ""
  }--disable-webhooks --instance ${instanceName}`);
  const infrastructureState = overview.infrastructureState ??
    (overview.enabled ? "enabled" : "unprovisioned");
  const localSimulationEnabled = localDevelopment && overview.enabled &&
    infrastructureState === "enabled";
  const agentDeploymentPrompt =
    `Run \`${MICROFEED_MANAGE_COMMAND}\` and follow every instruction it ` +
    `prints to enable ${deploymentLabel.toLowerCase()} webhooks for my ` +
    `existing microfeed site "${instanceName}". When instructed, run ` +
    `\`${deploymentCommand}\`. Do not change another site or environment. ` +
    `Continue until \`${managementCommand(`status --instance ${instanceName}`)}\` ` +
    "verifies that the webhook Queue and binding are ready.";

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    showToast(t("webhookOverview.copied", {label}), "success");
  };

  return (
    <div className="grid gap-6">
      <AdminSectionCard
        action={<WebhookEnablementDialog
          agentPrompt={agentDeploymentPrompt}
          command={deploymentCommand}
          disableCommand={disableCommand}
          deploymentLabel={deploymentLabel}
          enabled={overview.enabled}
          endpointUrl={endpointUrl}
          infrastructureState={infrastructureState}
          localDevelopment={localDevelopment}
          onCopy={copy}
        />}
        description={t("webhookOverview.availabilityDescription")}
        title={t("webhookOverview.availabilityTitle")}
      >
        <div className="flex items-start gap-3">
          {localSimulationEnabled || overview.enabled
            ? <CheckCircle2Icon className="mt-0.5 size-5 text-emerald-600" aria-hidden="true" />
            : <AlertTriangleIcon className="mt-0.5 size-5 text-amber-600" aria-hidden="true" />}
          <div>
            <p className="font-medium">
              {localDevelopment
                ? localSimulationEnabled
                  ? t("webhookOverview.simulationRunning")
                  : t("webhookOverview.simulationDisabled")
                : overview.enabled
                ? t("webhookOverview.enabled", {label: deploymentLabel})
                : infrastructureState === "disabled"
                ? t("webhookOverview.disabled", {label: deploymentLabel})
                : t("webhookOverview.notProvisioned", {label: deploymentLabel})}
            </p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {localDevelopment
                ? localSimulationEnabled
                  ? t("webhookOverview.simulationRunningDetail", {command: managementCommand("dev")})
                  : t("webhookOverview.simulationDisabledDetail", {command: managementCommand("dev")})
                : overview.enabled
                ? t("webhookOverview.enabledDetail")
                : infrastructureState === "disabled"
                ? t("webhookOverview.disabledDetail")
                : t("webhookOverview.notProvisionedDetail")}
            </p>
            {!localDevelopment && !overview.enabled && (
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted p-3">
                <code className="min-w-0 flex-1 overflow-x-auto text-xs">
                  {deploymentCommand}
                </code>
                <button
                  aria-label={t("webhookOverview.copyAria", {label: t("webhookOverview.deployCommandNoun")})}
                  className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() => void copy(deploymentCommand, t("webhookOverview.deployCommandNoun"))}
                  type="button"
                >
                  <CopyIcon aria-hidden="true" className="size-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </AdminSectionCard>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={t("webhookOverview.metricEndpoints")} value={t("webhookOverview.configured", {count: overview.endpoints})}>
          <p>{t("webhookOverview.activeLimit", {active: overview.activeEndpoints, limit: overview.endpointLimit})}</p>
          <a className="font-medium text-foreground underline underline-offset-4" href={endpointUrl}>
            {t("webhookOverview.manageEndpoints")}
          </a>
        </Metric>
        <BudgetMetric
          onUpdate={(dailyLimit) => setOverview((current) => ({
            ...current,
            dailyLimit,
          }))}
          overview={overview}
          remaining={remaining}
        />
        <Metric
          label={t("webhookOverview.metricQueueOps")}
          value={`~${overview.estimatedQueueOperationsToday.toLocaleString("en-US")}`}
        >
          <p>{t("webhookOverview.queueOpsNote")}</p>
        </Metric>
        <Metric label={t("webhookOverview.metricFailures")} value={overview.recentFailures}>
          <p>{t("webhookOverview.failuresNote")}</p>
        </Metric>
      </div>

      {overview.alerts.length > 0 && (
        <AdminSectionCard
          description={t("webhookOverview.alertsDescription")}
          title={t("webhookOverview.alertsTitle")}
        >
          <ul className="grid gap-3">
            {overview.alerts.map((alert) => (
              <li className="rounded-lg border border-amber-500/35 bg-amber-500/8 p-3" key={alert.id}>
                <p className="font-medium">{alert.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">{new Date(alert.createdAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        </AdminSectionCard>
      )}

      <FirstEndpointQuickstart
        endpointCreateUrl={endpointCreateUrl}
        endpointUrl={endpointUrl}
        explorerUrl={explorerUrl}
        initialMode={initialQuickstartMode}
        localDevelopment={localDevelopment}
        onCopy={copy}
      />

      <AdminSectionCard
        description={t("webhookOverview.safeDescription", {count: WEBHOOK_EVENT_TYPES.length})}
        title={t("webhookOverview.safeTitle")}
      >
        <div className="grid gap-3 text-sm leading-6 text-muted-foreground">
          <p>{t("webhookOverview.safeBody1")}</p>
          <p>{t("webhookOverview.safeBody2")}</p>
          <details>
            <summary className="cursor-pointer font-medium text-foreground">{t("webhookOverview.safeEventTypes", {count: WEBHOOK_EVENT_TYPES.length})}</summary>
            <p className="mt-2 font-mono text-xs">{WEBHOOK_EVENT_TYPES.join(", ")}</p>
          </details>
          <a className="inline-flex w-fit items-center gap-1.5 font-medium text-foreground underline underline-offset-4" href="https://docs.microfeed.org/automation/" rel="noreferrer" target="_blank">
            {t("webhookOverview.contentAutomationGuide")} <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      </AdminSectionCard>
    </div>
  );
}

type FirstEndpointMode = "code" | "no_code";

const LOCAL_LISTENER_ENDPOINT_URL = "http://127.0.0.1:8978/webhook";
const PUBLIC_RECEIVER_ENDPOINT_EXAMPLE = "https://hooks.example.com/webhook";

function deployedReceiverSource(
  language: WebhookQuickstartLanguage,
): string {
  const source = WEBHOOK_QUICKSTARTS[language].source.replaceAll(
    "this local inspector",
    "this starter",
  );
  if (language === "javascript") {
    return source.replace(
      [
        'app.listen(3000, "127.0.0.1", () => {',
        '  console.log("Listening at http://127.0.0.1:3000/webhook");',
        "});",
        "",
      ].join("\n"),
      [
        "const port = Number(process.env.PORT ?? 3000);",
        "",
        'app.listen(port, "0.0.0.0", () => {',
        "  console.log(`Listening on port ${port}; expose /webhook through HTTPS.`);",
        "});",
        "",
      ].join("\n"),
    );
  }
  return source.replace(
    '    app.run(host="127.0.0.1", port=3000)',
    [
      '    port = int(os.environ.get("PORT", "3000"))',
      '    app.run(host="0.0.0.0", port=port)',
    ].join("\n"),
  );
}

function FirstEndpointQuickstart({
  endpointCreateUrl,
  endpointUrl,
  explorerUrl,
  initialMode,
  localDevelopment,
  onCopy,
}: {
  endpointCreateUrl: string;
  endpointUrl: string;
  explorerUrl: string;
  initialMode: FirstEndpointMode;
  localDevelopment: boolean;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const {t} = useTranslation();
  const [mode, setMode] = useState<FirstEndpointMode>(initialMode);
  const [language, setLanguage] =
    useState<WebhookQuickstartLanguage>("javascript");
  const quickstart = WEBHOOK_QUICKSTARTS[language];
  const receiverSource = localDevelopment
    ? quickstart.source
    : deployedReceiverSource(language);

  return (
    <AdminSectionCard
      description={mode === "no_code"
        ? localDevelopment
          ? t("webhookOverview.noCodeLocalDesc")
          : t("webhookOverview.noCodeDeployedDesc")
        : localDevelopment
        ? t("webhookOverview.codeLocalDesc")
        : t("webhookOverview.codeDeployedDesc")}
      title={t("webhookOverview.firstEndpointTitle")}
    >
      <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label={t("webhookOverview.testModeAria")}>
        <Button
          aria-selected={mode === "no_code"}
          onClick={() => setMode("no_code")}
          role="tab"
          size="sm"
          type="button"
          variant={mode === "no_code" ? "default" : "outline"}
        >
          {t("webhookOverview.tabNoCode")}
        </Button>
        <Button
          aria-selected={mode === "code"}
          onClick={() => setMode("code")}
          role="tab"
          size="sm"
          type="button"
          variant={mode === "code" ? "default" : "outline"}
        >
          {t("webhookOverview.tabCode")}
        </Button>
      </div>

      {mode === "no_code"
        ? <NoCodeQuickstart
          endpointUrl={endpointUrl}
          explorerUrl={explorerUrl}
          localDevelopment={localDevelopment}
          onCopy={onCopy}
        />
        : <div className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(22rem,1.15fr)]">
          <div className="grid content-start gap-3 text-sm leading-6">
            <QuickstartStep
              description={t("webhookOverview.scaffoldDescription", {label: quickstart.label})}
              number={1}
              title={t("webhookOverview.scaffoldTitle", {label: quickstart.label})}
            >
              <p>{t("webhookOverview.scaffoldBody")}</p>
              <QuickstartCommand onCopy={onCopy} value={quickstart.scaffoldCommand} />
              {localDevelopment
                ? <p>{t("webhookOverview.scaffoldBodyLocal", {url: WEBHOOK_QUICKSTART_ENDPOINT_URL})}</p>
                : <p>{t("webhookOverview.scaffoldBodyDeployed")}</p>}
            </QuickstartStep>

            <QuickstartStep
              description={localDevelopment
                ? t("webhookOverview.createEndpointDescLocal")
                : t("webhookOverview.createEndpointDescDeployed")}
              number={2}
              title={t("webhookOverview.createEndpointTitle")}
            >
              <p>
                {localDevelopment
                  ? t("webhookOverview.createEndpointBodyLocal", {url: WEBHOOK_QUICKSTART_ENDPOINT_URL})
                  : t("webhookOverview.createEndpointBodyDeployed", {example: PUBLIC_RECEIVER_ENDPOINT_EXAMPLE})}
              </p>
              <Button
                render={<a href={localDevelopment ? endpointCreateUrl : endpointUrl} rel="noreferrer" target="_blank" />}
                size="sm"
              >
                {localDevelopment ? t("webhookOverview.createEndpointButtonLocal") : t("webhookOverview.openEndpoints")}
              </Button>
              <p>{t("webhookOverview.signingSecretBody")}</p>
            </QuickstartStep>

            <QuickstartStep
              description={localDevelopment
                ? t("webhookOverview.installDescLocal", {label: quickstart.label})
                : t("webhookOverview.installDescDeployed", {label: quickstart.label})}
              number={3}
              title={localDevelopment
                ? t("webhookOverview.installTitleLocal", {label: quickstart.label})
                : t("webhookOverview.installTitleDeployed", {label: quickstart.label})}
            >
              <p>{t("webhookOverview.installBody1")}</p>
              <QuickstartCommand onCopy={onCopy} value={quickstart.directoryCommand} />
              {quickstart.installCommands.map((command) => (
                <QuickstartCommand key={command} onCopy={onCopy} value={command} />
              ))}
              {localDevelopment
                ? <>
                  <p>{t("webhookOverview.installBodyLocal1")}</p>
                  <QuickstartCommand onCopy={onCopy} value={quickstart.runCommand} />
                  <p>{t("webhookOverview.installBodyLocal2", {url: WEBHOOK_QUICKSTART_ENDPOINT_URL})}</p>
                </>
                : <>
                  <p>
                    {t("webhookOverview.installBodyDeployed1", {cmd: language === "javascript" ? "yarn start" : "python server.py"})}
                  </p>
                  <p>{t("webhookOverview.installBodyDeployed2")}</p>
                </>}
            </QuickstartStep>

            <TestEventStep explorerUrl={explorerUrl} />
          </div>

          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2" role="tablist" aria-label={t("webhookOverview.receiverLanguageAria")}>
                {(["javascript", "python"] as const).map((value) => (
                  <Button
                    aria-selected={language === value}
                    key={value}
                    onClick={() => setLanguage(value)}
                    role="tab"
                    size="sm"
                    type="button"
                    variant={language === value ? "default" : "outline"}
                  >
                    {WEBHOOK_QUICKSTARTS[value].label}
                  </Button>
                ))}
              </div>
              <Button
                onClick={() => void onCopy(receiverSource, t("webhookOverview.receiverAriaLabel", {label: quickstart.label}))}
                size="sm"
                type="button"
                variant="outline"
              >
                <CopyIcon aria-hidden="true" className="size-4" />
                {t("webhookOverview.copyReceiver", {filename: quickstart.filename})}
              </Button>
            </div>
            <AdminCodeEditor
              ariaLabel={t("webhookOverview.receiverAriaLabel", {label: quickstart.label})}
              code={receiverSource}
              language={quickstart.highlightLanguage}
              maxHeight="36rem"
              minHeight="36rem"
              readOnly
            />
            <div className="mt-3 rounded-xl border border-amber-500/35 bg-amber-500/8 p-4 text-sm leading-6">
              <p className="font-medium">{t("webhookOverview.starterWarningTitle")}</p>
              <p className="mt-1 text-muted-foreground">
                {t("webhookOverview.starterWarningBody")}
              </p>
            </div>
          </div>
        </div>}
    </AdminSectionCard>
  );
}

function NoCodeQuickstart({
  endpointUrl,
  explorerUrl,
  localDevelopment,
  onCopy,
}: {
  endpointUrl: string;
  explorerUrl: string;
  localDevelopment: boolean;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const {t} = useTranslation();
  const listenCommand = localDevelopment
    ? "yarn microfeed webhook listen"
    : "yarn microfeed webhook listen --tunnel";

  return (
    <div className="grid max-w-4xl content-start gap-3 text-sm leading-6">
      <QuickstartStep
        description={localDevelopment
          ? t("webhookOverview.noCodeStep1DescLocal")
          : t("webhookOverview.noCodeStep1DescDeployed")}
        number={1}
        title={localDevelopment
          ? t("webhookOverview.noCodeStep1TitleLocal")
          : t("webhookOverview.noCodeStep1TitleDeployed")}
      >
        <p>
          {t("webhookOverview.noCodeStep1Body")}
          {!localDevelopment && t("webhookOverview.noCodeStep1BodyDeployedExtra")}
        </p>
        <QuickstartCommand onCopy={onCopy} value={listenCommand} />
        {localDevelopment
          ? <p>{t("webhookOverview.noCodeStep1BodyLocal", {url: LOCAL_LISTENER_ENDPOINT_URL})}</p>
          : <p>{t("webhookOverview.noCodeStep1BodyDeployed")}</p>}
      </QuickstartStep>

      <QuickstartStep
        description={localDevelopment
          ? t("webhookOverview.noCodeStep2DescLocal")
          : t("webhookOverview.noCodeStep2DescDeployed")}
        number={2}
        title={t("webhookOverview.noCodeStep2Title")}
      >
        {localDevelopment
          ? <>
            <p>{t("webhookOverview.noCodeStep2BodyLocal")}</p>
            <QuickstartCommand copyLabel={t("webhookOverview.endpointUrlNoun")} onCopy={onCopy} value={LOCAL_LISTENER_ENDPOINT_URL} />
          </>
          : <p>{t("webhookOverview.noCodeStep2BodyDeployed")}</p>}
        <Button
          render={<a href={endpointUrl} rel="noreferrer" target="_blank" />}
          size="sm"
        >
          {t("webhookOverview.openEndpoints")}
        </Button>
        <p>{t("webhookOverview.noCodeStep2Body3")}</p>
      </QuickstartStep>

      <QuickstartStep
        description={t("webhookOverview.noCodeStep3Desc")}
        number={3}
        title={t("webhookOverview.noCodeStep3Title")}
      >
        <p>{t("webhookOverview.noCodeStep3Body")}</p>
      </QuickstartStep>

      <TestEventStep explorerUrl={explorerUrl} />

      {!localDevelopment && (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/8 p-4">
          <p className="font-medium">{t("webhookOverview.tempTestingTitle")}</p>
          <p className="mt-1 text-muted-foreground">
            {t("webhookOverview.tempTestingBody")}
          </p>
        </div>
      )}
    </div>
  );
}

function TestEventStep({explorerUrl}: {explorerUrl: string}) {
  const {t} = useTranslation();
  return (
    <QuickstartStep
      description={t("webhookOverview.sendTestDescription")}
      number={4}
      title={t("webhookOverview.sendTestTitle")}
    >
      <p>{t("webhookOverview.sendTestBody")}</p>
      <Button
        render={<a href={explorerUrl} rel="noreferrer" target="_blank" />}
        size="sm"
        variant="outline"
      >
        {t("webhookOverview.openEventExplorer")}
      </Button>
      <p>{t("webhookOverview.sendTestFooter")}</p>
    </QuickstartStep>
  );
}

function QuickstartStep({
  children,
  description,
  number,
  title,
}: {
  children: React.ReactNode;
  description: string;
  number: number;
  title: string;
}) {
  return (
    <details className="group overflow-hidden rounded-xl border bg-card">
      <summary className="flex cursor-pointer list-none items-start gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
          {number}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium leading-6">{title}</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            {description}
          </span>
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="grid gap-3 border-t px-4 py-4 text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

function QuickstartCommand({
  copyLabel = "command",
  onCopy,
  value,
}: {
  copyLabel?: string;
  onCopy: (value: string, label: string) => Promise<void>;
  value: string;
}) {
  const {t} = useTranslation();
  const label = copyLabel === "command" ? t("webhookOverview.commandNoun") : copyLabel;
  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted p-3 text-foreground">
      <code className="min-w-0 flex-1 overflow-x-auto text-xs leading-5">
        {value}
      </code>
      <button
        aria-label={t("webhookOverview.copyAria", {label})}
        className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        onClick={() => void onCopy(value, label)}
        type="button"
      >
        <CopyIcon aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

function Metric({
  children,
  label,
  value,
}: {
  children?: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-xs">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {children && <div className="mt-3 grid gap-1 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

function BudgetMetric({
  onUpdate,
  overview,
  remaining,
}: {
  onUpdate: (dailyLimit: number) => void;
  overview: WebhookOverview;
  remaining: number;
}) {
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(overview.dailyLimit));
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const numericValue = value.trim() === "" ? Number.NaN : Number(value);
  const higherBudget = Number.isFinite(numericValue) &&
    numericValue > WEBHOOK_LIMITS.dailyDeliveries;
  const percentage = overview.dailyLimit > 0
    ? Math.min(100, overview.deliveriesToday / overview.dailyLimit * 100)
    : overview.deliveriesToday > 0 ? 100 : 0;

  const save = async () => {
    setBusy(true);
    try {
      const result = await requestJson("settings", {
        body: JSON.stringify({
          dailyDeliveryLimit: numericValue,
          highCostAcknowledged: acknowledged,
        }),
        method: "PATCH",
      });
      onUpdate(result.settings.dailyDeliveryLimit);
      setOpen(false);
      showToast(t("webhookOverview.budgetUpdated"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-5 shadow-xs">
      <p className="text-sm text-muted-foreground">{t("webhookOverview.dailyBudgetLabel")}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">
        {t("webhookOverview.usedOf", {
          used: overview.deliveriesToday.toLocaleString("en-US"),
          limit: overview.dailyLimit.toLocaleString("en-US"),
        })}
      </p>
      <div
        aria-label={t("webhookOverview.dailyBudgetLabel")}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(percentage)}
        aria-valuetext={t("webhookOverview.usedOf", {
          used: overview.deliveriesToday.toLocaleString("en-US"),
          limit: overview.dailyLimit.toLocaleString("en-US"),
        })}
        className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div className="h-full rounded-full bg-brand-light" style={{width: `${percentage}%`}} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("webhookOverview.availableReset", {remaining: remaining.toLocaleString("en-US")})}
      </p>
      <Dialog onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setValue(String(overview.dailyLimit));
          setAcknowledged(false);
        }
      }} open={open}>
        <DialogTrigger render={<Button className="mt-3" size="sm" type="button" variant="outline" />}>
          {t("webhookOverview.changeBudget")}
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("webhookOverview.changeBudgetTitle")}</DialogTitle>
            <DialogDescription>
              {t("webhookOverview.changeBudgetDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="flex flex-wrap gap-2">
              {[0, 1_000, 10_000, 100_000].map((preset) => (
                <Button key={preset} onClick={() => setValue(String(preset))} size="sm" type="button" variant={value === String(preset) ? "default" : "outline"}>
                  {preset.toLocaleString("en-US")}
                </Button>
              ))}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="webhook-daily-budget">{t("webhookOverview.deliveriesPerDay")}</Label>
              <Input id="webhook-daily-budget" max={WEBHOOK_LIMITS.maximumDailyDeliveries} min={0} onChange={(event) => {
                setValue(event.target.value);
                setAcknowledged(false);
              }} step={1} type="number" value={value} />
              <p className="text-xs text-muted-foreground">
                {t("webhookOverview.budgetHint", {max: WEBHOOK_LIMITS.maximumDailyDeliveries.toLocaleString("en-US")})}
              </p>
            </div>
            {Number.isFinite(numericValue) && numericValue >= 0 && (
              <div className="rounded-xl bg-muted p-4 text-sm leading-6">
                <p>{t("webhookOverview.projectedOps", {value: (numericValue * 3).toLocaleString("en-US")})}</p>
                <p>{t("webhookOverview.worstCaseOps", {value: (numericValue * 8).toLocaleString("en-US")})}</p>
              </div>
            )}
            {higherBudget && (
              <label className="flex items-start gap-3 rounded-xl border border-amber-500/35 bg-amber-500/8 p-4 text-sm leading-6">
                <input checked={acknowledged} className="mt-1" onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" />
                <span>
                  {t("webhookOverview.higherBudgetAck")}
                </span>
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              {t("webhookOverview.lowerBudgetHint")}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("webhookOverview.pricingNote")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !Number.isInteger(numericValue) || numericValue < 0 || numericValue > WEBHOOK_LIMITS.maximumDailyDeliveries || higherBudget && !acknowledged} onClick={() => void save()} type="button">
                {t("webhookOverview.saveBudget")}
              </Button>
              <a className="inline-flex items-center gap-1.5 px-2 text-sm font-medium underline underline-offset-4" href="https://developers.cloudflare.com/queues/platform/pricing/" rel="noreferrer" target="_blank">
                {t("webhookOverview.currentQueuePricing")} <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
              </a>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WebhookEnablementDialog({
  agentPrompt,
  command,
  disableCommand,
  deploymentLabel,
  enabled,
  endpointUrl,
  infrastructureState,
  localDevelopment,
  onCopy,
}: {
  agentPrompt: string;
  command: string;
  disableCommand: string;
  deploymentLabel: "Preview" | "Production";
  enabled: boolean;
  endpointUrl: string;
  infrastructureState: WebhookOverview["infrastructureState"];
  localDevelopment: boolean;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const {t} = useTranslation();
  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" type="button" variant="outline" />}>
        {localDevelopment
          ? t("webhookOverview.enableDialogLocalTitle")
          : enabled
          ? t("webhookOverview.enableDialogEnabledTitle")
          : infrastructureState === "disabled"
          ? t("webhookOverview.enableDialogDisabledTitle", {label: deploymentLabel})
          : t("webhookOverview.enableDialogProvisionTitle", {label: deploymentLabel})}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("webhookOverview.enableDialogHeading")}</DialogTitle>
          <DialogDescription>
            {t("webhookOverview.enableDialogDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm leading-6">
          <div className="rounded-xl border p-4">
            <p className="font-medium">{t("webhookOverview.localDevTitle")}</p>
            <p className="mt-1 text-muted-foreground">
              {t("webhookOverview.localDevBody", {command: managementCommand("dev"), devDisable: managementCommand("dev --disable-webhooks")})}
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="font-medium">{t("webhookOverview.previewProdTitle")}</p>
            <p className="mt-1 text-muted-foreground">
              {t("webhookOverview.previewProdBody")}
            </p>
            <p className="mt-3 font-medium">{t("webhookOverview.runManuallyTitle")}</p>
            <QuickstartCommand copyLabel={t("webhookOverview.deployCommandNoun")} onCopy={onCopy} value={command} />
            <p className="mt-3 font-medium">{t("webhookOverview.askAgentTitle")}</p>
            <p className="mt-1 text-muted-foreground">
              {t("webhookOverview.askAgentBody")}
            </p>
            <QuickstartCommand copyLabel={t("webhookOverview.codingAgentPromptNoun")} onCopy={onCopy} value={agentPrompt} />
          </div>
          <div className="rounded-xl border p-4">
            <p className="font-medium">{t("webhookOverview.stopTitle")}</p>
            <p className="mt-1 text-muted-foreground">
              {t("webhookOverview.stopBodyBefore")}
              <a className="font-medium text-foreground underline underline-offset-4" href={endpointUrl}>{t("webhookOverview.webhooksEndpointsLink")}</a>
              {t("webhookOverview.stopBodyAfter")}
            </p>
            {!localDevelopment && (
              <QuickstartCommand copyLabel={t("webhookOverview.disableCommandNoun")} onCopy={onCopy} value={disableCommand} />
            )}
          </div>
          {localDevelopment && (
            <p className="rounded-xl bg-emerald-500/10 p-4">
              {t("webhookOverview.loopbackNote")}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
