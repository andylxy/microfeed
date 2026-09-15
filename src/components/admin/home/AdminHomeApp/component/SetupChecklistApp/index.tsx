import {CircleArrowRightIcon, CircleCheckIcon} from "lucide-react";
import {useTranslation} from "@/client/i18n";
import React, {useEffect, useState} from "react";

import {showToast} from "@/client/ToastUtils";
import Requests from "@/client/requests";
import {Button} from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {ONBOARDING_TYPES} from "@/shared/Constants";
import {managementCommand} from "@/shared/ManagementCli";
import {
  ADMIN_URLS,
  normalizeR2CustomDomainUrl,
} from "@/shared/StringUtils";
import type {
  AdminProtectionStatus,
  FeedContent,
  OnboardingCheck,
  OnboardingResult,
} from "@/types";

function CloudflareValue({children}: {children: React.ReactNode}) {
  return (
    <code className="font-semibold text-cloudflare-orange">{children}</code>
  );
}

function CheckListItem({
  children,
  onboardState,
  title,
}: any) {
  return (
    <div className="flex">
      <div className="mr-4">
        {onboardState.ready
          ? <CircleCheckIcon className="w-6 text-green-500" />
          : <CircleArrowRightIcon className="w-6 text-muted-color" />}
      </div>
      <details className="w-full" open={!onboardState.ready}>
        <summary className="cursor-pointer mb-4 font-semibold hover:opacity-50">
          {title}
        </summary>
        <div className="mb-8 text-sm text-helper-color">{children}</div>
      </details>
    </div>
  );
}

interface AdminProtectionDescriptionProps extends AdminProtectionStatus {
  dashboardUrl?: string;
}

function CloudflareAccessLink({dashboardUrl}: {dashboardUrl?: string}) {
  const {t} = useTranslation();
  const label = t('home.cloudflareZeroTrustAccess');
  return dashboardUrl
    ? (
      <a
        className="font-medium underline"
        href={dashboardUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        {label}
      </a>
    )
    : label;
}

export function AdminProtectionDescription({
  builtInLogin,
  cloudflareAccess,
  dashboardUrl,
}: AdminProtectionDescriptionProps) {
  const {t} = useTranslation();
  if (builtInLogin && cloudflareAccess) {
    return (
      <>
        {t('home.protectionBuiltInBothBefore')}
        <CloudflareAccessLink dashboardUrl={dashboardUrl} />{t('home.protectionBuiltInBothAfter')}
      </>
    );
  }

  if (builtInLogin) {
    return (
      <>
        {t('home.protectionBuiltInBothBefore')}
        <CloudflareAccessLink dashboardUrl={dashboardUrl} />{t('home.protectionBuiltInOnlyAfter')}
        <CloudflareValue>{managementCommand("access")}</CloudflareValue>{t('home.protectionBuiltInOnlyEnd')}
      </>
    );
  }

  if (cloudflareAccess) {
    return (
      <>
        <CloudflareAccessLink dashboardUrl={dashboardUrl} />{t('home.protectionCloudflareOnlyAfter')}
      </>
    );
  }

  return (
    <>
      {t('home.protectionNoneBefore')}
      <CloudflareAccessLink dashboardUrl={dashboardUrl} />{t('home.protectionNoneAfter')}
      <CloudflareValue>{managementCommand("auth setup")}</CloudflareValue>{t('home.protectionNoneMiddle')}
      <CloudflareValue>{managementCommand("access")}</CloudflareValue>{t('home.protectionNoneEnd')}
    </>
  );
}

interface SiteCustomDomainDescriptionProps {
  dashboardUrl?: string;
  workerName?: string;
}

const CUSTOM_DOMAIN_DOCUMENTATION_URL =
  "https://docs.microfeed.org/manage/domains-and-access/";

export function SiteCustomDomainDescription({
  dashboardUrl,
  workerName,
}: SiteCustomDomainDescriptionProps) {
  const {t} = useTranslation();
  return (
    <>
      {dashboardUrl
        ? (
          <>
            <a
              className="font-medium underline"
              href={dashboardUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t('home.customDomainWithDashboardBefore')}
              {workerName
                ? <CloudflareValue>{workerName}</CloudflareValue>
                : t('home.workerFallback')}{" "}
              {t('home.customDomainWithDashboardMid')}
            </a>{" "}
            {t('home.customDomainWithDashboardAfter')}
          </>
        )
        : (
          <>
            {t('home.customDomainWithoutDashboard')}
          </>
        )}
      {t('home.customDomainRecommend')}
      <CloudflareValue>{managementCommand("domain")}</CloudflareValue>.{" "}
      <a
        className="font-medium underline"
        href={CUSTOM_DOMAIN_DOCUMENTATION_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        {t('home.customDomainLearnMore')}
      </a>
    </>
  );
}

interface MediaDeliveryDescriptionProps {
  bucketName?: string;
  configured?: boolean;
  dashboardUrl?: string;
  error?: string;
  mediaDomainUrl: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  saving: boolean;
  suggestedUrl?: string;
}

export function MediaDeliveryDescription({
  bucketName,
  configured = false,
  dashboardUrl,
  error,
  mediaDomainUrl,
  onChange,
  onSubmit,
  saving,
  suggestedUrl,
}: MediaDeliveryDescriptionProps) {
  const {t} = useTranslation();
  const suggestion = suggestedUrl ?? "https://media.example.com/";
  const normalizedSuggestion = normalizeR2CustomDomainUrl(suggestion);
  const suggestedHostname = normalizedSuggestion
    ? new URL(normalizedSuggestion).hostname
    : "media.example.com";

  return (
    <div className="space-y-4">
      {configured
        ? (
          <p>
            {t('home.mediaDeliveryConfigured')}
          </p>
        )
        : (
          <p>
            {t('home.mediaDeliveryUnconfigured')}
          </p>
        )}
      <p>
        {t('home.mediaDeliveryBenefits')}
      </p>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          {dashboardUrl
            ? (
              <a
                className="font-medium underline"
                href={dashboardUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t('home.mediaDeliveryStep1Before')}
                {bucketName
                  ? <CloudflareValue>{bucketName}</CloudflareValue>
                  : t('home.r2Fallback')}{" "}
                {t('home.mediaDeliveryStep1Mid')}
              </a>
            )
            : (
              <span>
                {t('home.mediaDeliveryStep1Alt')}<strong>Settings</strong>.
              </span>
            )}
        </li>
        <li>
          {t('home.mediaDeliveryStep2Before')}<strong>Custom Domains</strong>{t('home.mediaDeliveryStep2After')}
          <CloudflareValue>{suggestedHostname}</CloudflareValue>{t('home.mediaDeliveryStep2End')}
        </li>
        <li>{t('home.mediaDeliveryStep3')}</li>
      </ol>
      <p>
        {t('home.mediaDeliveryR2devBefore')}
        <CloudflareValue>r2.dev</CloudflareValue>{t('home.mediaDeliveryR2devAfter')}
      </p>
      <form className="space-y-3" onSubmit={onSubmit}>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="r2-custom-domain">{t('home.mediaDeliveryFieldLabel')}</FieldLabel>
          <Input
            aria-describedby="r2-custom-domain-help"
            aria-invalid={Boolean(error)}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={saving}
            id="r2-custom-domain"
            inputMode="url"
            onChange={(event) => onChange(event.target.value)}
            placeholder={suggestion}
            spellCheck={false}
            type="text"
            value={mediaDomainUrl}
          />
          <FieldDescription id="r2-custom-domain-help">
            {t('home.mediaDeliveryFieldHelp')}<code>https://</code>.
          </FieldDescription>
          <FieldError>{error}</FieldError>
        </Field>
        <Button disabled={saving} type="submit">
          {saving ? t('home.saving') : t('home.saveMediaDomain')}
        </Button>
      </form>
    </div>
  );
}

export function MediaStorageDescription({
  bucketName,
  dashboardUrl,
  state,
}: {
  bucketName?: string;
  dashboardUrl?: string;
  state: "disabled" | "pending" | "ready";
}) {
  const {t} = useTranslation();
  if (state === "ready") {
    return (
      <>
        {t('home.mediaStorageReadyBefore')}
        {bucketName
          ? <CloudflareValue>{bucketName}</CloudflareValue>
          : t('home.instanceFallback')}{t('home.mediaStorageReadyAfter')}
      </>
    );
  }
  if (state === "disabled") {
    return (
      <>
        {t('home.mediaStorageDisabled')}
        <CloudflareValue>{managementCommand("deploy --enable-r2")}</CloudflareValue>.
      </>
    );
  }
  return (
    <>
      {t('home.mediaStoragePendingBefore')}
      {dashboardUrl
        ? (
          <a
            className="font-medium underline"
            href={dashboardUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t('home.mediaStorageActivate')}
          </a>
        )
        : t('home.mediaStorageActivate')}
      {t('home.mediaStoragePendingAfter')}
      <CloudflareValue>{managementCommand("deploy --enable-r2")}</CloudflareValue>.
    </>
  );
}

interface SetupChecklistProps {
  feed: FeedContent;
  onboardingResult: OnboardingResult;
  onCompletionChange?: (complete: boolean) => void;
}

export default function SetupChecklistApp({
  feed,
  onboardingResult,
  onCompletionChange,
}: SetupChecklistProps) {
  const {t} = useTranslation();
  const access: OnboardingCheck = onboardingResult.result[
    ONBOARDING_TYPES.PROTECTED_ADMIN_DASHBOARD
  ] ?? {ready: false, required: false};
  const customDomain: OnboardingCheck = onboardingResult.result[
    ONBOARDING_TYPES.CUSTOM_DOMAIN
  ] ?? {ready: false, required: false};
  const mediaDomain: OnboardingCheck = onboardingResult.result[
    ONBOARDING_TYPES.VALID_PUBLIC_BUCKET_URL
  ] ?? {ready: false, required: false};
  const mediaStorage: OnboardingCheck = onboardingResult.result[
    ONBOARDING_TYPES.MEDIA_STORAGE
  ] ?? {mediaStorageState: "ready", ready: true, required: false};
  const currentMediaUrl = normalizeR2CustomDomainUrl(
    feed.settings?.webGlobalSettings?.publicBucketUrl,
  );
  const [mediaDomainUrl, setMediaDomainUrl] = useState(
    currentMediaUrl || mediaDomain.suggestedUrl || "",
  );
  const [mediaDomainSaved, setMediaDomainSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const effectiveMediaDomain = {
    ...mediaDomain,
    ready: mediaDomain.ready || mediaDomainSaved,
  };
  const effectiveAllOk = Object.entries(onboardingResult.result).every(
    ([type, check]) =>
      Number(type) === ONBOARDING_TYPES.VALID_PUBLIC_BUCKET_URL
        ? effectiveMediaDomain.ready
        : check.ready,
  );
  const adminProtection = access.adminProtection ?? {
    builtInLogin: false,
    cloudflareAccess: false,
  };

  useEffect(() => {
    onCompletionChange?.(effectiveAllOk);
  }, [effectiveAllOk, onCompletionChange]);

  async function saveMediaDomain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedUrl = normalizeR2CustomDomainUrl(mediaDomainUrl);
    if (!normalizedUrl) {
      setError(
        t('home.mediaDomainErrorHttps'),
      );
      return;
    }
    if (new URL(normalizedUrl).hostname === window.location.hostname) {
      setError(
        t('home.mediaDomainErrorSameHost'),
      );
      return;
    }

    setError("");
    setSaving(true);
    const currentWebSettings = feed.settings?.webGlobalSettings ?? {};
    try {
      await Requests.axiosPost(ADMIN_URLS.ajaxFeed(), {
        settings: {
          webGlobalSettings: {
            ...currentWebSettings,
            publicBucketUrl: normalizedUrl,
          },
        },
      });
      setMediaDomainUrl(normalizedUrl);
      setMediaDomainSaved(true);
      showToast(t('home.mediaDomainUpdated'), "success");
    } catch (requestError: any) {
      setError(
        requestError.response
          ? t('home.mediaDomainSaveFailed')
          : t('common.networkError'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <div className="mb-4 text-lg font-semibold tracking-tight">{t('home.setupChecklist')}</div>
      {effectiveAllOk && (
        <div className="rounded-[10px] border border-green-700/40 bg-green-500/10 p-3 text-green-700 dark:text-green-300">
          <i>{t('home.allSet')}</i>
          <div className="mt-2">
            {t('home.startPublishingAt')}{" "}
            <a href={ADMIN_URLS.newItem()}>
              {t('home.addNewItem')} <span className="lh-icon-arrow-right" />
            </a>
          </div>
        </div>
      )}
      <div className="mt-8">
        <CheckListItem
          onboardState={access}
          title={t('home.dashboardProtection')}
        >
          <AdminProtectionDescription
            {...adminProtection}
            dashboardUrl={access.dashboardUrl}
          />
        </CheckListItem>
        <CheckListItem
          onboardState={customDomain}
          title={t('home.customDomainForSite')}
        >
          <SiteCustomDomainDescription
            dashboardUrl={customDomain.dashboardUrl}
            workerName={customDomain.workerName}
          />
        </CheckListItem>
        <CheckListItem
          onboardState={mediaStorage}
          title={t('home.enableMediaStorage')}
        >
          <MediaStorageDescription
            bucketName={mediaStorage.bucketName}
            dashboardUrl={mediaStorage.dashboardUrl}
            state={mediaStorage.mediaStorageState ?? "ready"}
          />
        </CheckListItem>
        {mediaStorage.ready && <CheckListItem
          onboardState={effectiveMediaDomain}
          title={t('home.customDomainForMedia')}
        >
          <MediaDeliveryDescription
            bucketName={mediaDomain.bucketName}
            configured={Boolean(currentMediaUrl || mediaDomainSaved)}
            dashboardUrl={mediaDomain.dashboardUrl}
            error={error}
            mediaDomainUrl={mediaDomainUrl}
            onChange={(value) => {
              setMediaDomainUrl(value);
              setError("");
            }}
            onSubmit={saveMediaDomain}
            saving={saving}
            suggestedUrl={mediaDomain.suggestedUrl}
          />
        </CheckListItem>}
      </div>
    </div>
  );
}
