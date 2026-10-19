import React from 'react';
import {SearchIcon} from "lucide-react";
import AdminPageApp from '@/components/admin/shared/AdminPageApp';
import {Input} from "@/components/ui/input";
import TrackingSettingsApp from "./TrackingSettingsApp";
import AccessSettingsApp from "./AccessSettingsApp";
import SubscribeSettingsApp from "./SubscribeSettingsApp";
import CustomCodeSettingsApp from "./CustomCodeSettingsApp";
import FaviconSettingsApp from "./FaviconSettingsApp";
import SiteSettingsApp, {
  SITE_TITLE_SUBMIT_KEY,
} from "./SiteSettingsApp";
import ContentReviewSettingsApp from "./ContentReviewSettingsApp";
import CloudflareTokenSettingsApp from "./CloudflareTokenSettingsApp";
import ItemEditorSectionsSettingsApp from "./ItemEditorSectionsSettingsApp";
import ItemsSettingsApp, {
  ITEMS_PER_PAGE_SUBMIT_KEY,
} from "./ItemsSettingsApp";
import MediaFileStorageSettingsApp, {
  MEDIA_FILE_STORAGE_SUBMIT_KEY,
} from "./MediaFileStorageSettingsApp";
import Requests from "@/client/requests";
import i18n from "@/client/i18n";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {showToast} from "@/client/ToastUtils";
import {ONBOARDING_TYPES, SETTINGS_CATEGORIES} from "@/shared/Constants";
import {
  preventCloseWhenChanged,
} from "@/client/BrowserUtils";
import {scrollToAdminSettingsHash} from "@/client/AdminSettingsScroll";
import {
  installSettingsSectionNav,
  jumpToSettingsSection,
} from "@/client/settings-section-nav";
import {
  ADMIN_SETTINGS_SECTIONS,
  filterAdminSettingsSections,
  type AdminSettingsSection,
} from "@/shared/AdminSettingsNavigation";
import type {FeedContent, OnboardingResult} from "@/types";

const SUBMIT_STATUS__START = 1;

/** 搜索按用户可见的名称匹配，与旧侧栏搜索框同一口径。 */
const settingsSectionLabel = (section: AdminSettingsSection): string =>
  i18n.t(section.nameKey);

interface Props {
  feedContent: FeedContent;
  onboardingResult: OnboardingResult;
}

export default class SettingsApp extends React.Component<Props, any> {
  private cleanupNavigationGuard?: () => void;
  private cleanupSectionNav?: () => void;
  private initialHashScrollFrame?: number;

  constructor(props: Props) {
    super(props);

    this.onSubmit = this.onSubmit.bind(this);
    this.onSearchKeyDown = this.onSearchKeyDown.bind(this);
    this.setChanged = this.setChanged.bind(this);
    this.updateSettingsState = this.updateSettingsState.bind(this);

    this.state = {
      feed: props.feedContent,
      sectionQuery: "",
      submitStatus: null,
      changedSections: [],
    }
  }

  componentDidMount() {
    this.cleanupNavigationGuard = preventCloseWhenChanged(
      () => this.state.changedSections.length > 0,
    );
    this.initialHashScrollFrame = window.requestAnimationFrame(() => {
      scrollToAdminSettingsHash();
    });
    // 分区导航（滚动高亮跟随 + 点击平滑滚动 + replaceState）由本页装载，
    // 侧栏与移动端抽屉里的分区链接都走这套捕获式处理。
    this.cleanupSectionNav = installSettingsSectionNav();
  }

  componentWillUnmount() {
    if (this.initialHashScrollFrame !== undefined) {
      window.cancelAnimationFrame(this.initialHashScrollFrame);
    }
    this.cleanupNavigationGuard?.();
    this.cleanupSectionNav?.();
  }

  setChanged(sectionKey: string) {
    this.setState((previousState: any) => ({
      changedSections: previousState.changedSections.includes(sectionKey)
        ? previousState.changedSections
        : [...previousState.changedSections, sectionKey],
    }));
  }

  updateSettingsState(bundleKey: string, bundle: Record<string, unknown>) {
    this.setState((previousState: any) => ({
      feed: {
        ...previousState.feed,
        settings: {
          ...previousState.feed.settings,
          [bundleKey]: {
            ...(previousState.feed.settings?.[bundleKey] ?? {}),
            ...bundle,
          },
        },
      },
    }));
  }

  /** 有查询时回车跳到第一个名称命中的分区：搜索的第一动作就是定位。 */
  private onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    const query = this.state.sectionQuery.trim();
    if (query === "") return;
    const first = filterAdminSettingsSections(query, settingsSectionLabel)[0];
    if (first) jumpToSettingsSection(first.id);
  }

  async onSubmit(
    e: any,
    bundleKey: any,
    bundle: any,
    deleteImageUrls: string[] = [],
    submitKey: string = bundleKey,
  ) {
    e?.preventDefault?.();
    const updatedBundle = {
      ...(this.state.feed.settings?.[bundleKey] ?? {}),
      ...bundle,
    };
    this.setState({submitForType: submitKey, submitStatus: SUBMIT_STATUS__START});
    try {
      await Requests.axiosPost(ADMIN_URLS.ajaxFeed(), {
        deleteImageUrls,
        settings: {[bundleKey]: updatedBundle},
      });
      this.setState((previousState: any) => ({
        changedSections: previousState.changedSections.filter(
          (sectionKey: string) => sectionKey !== submitKey,
        ),
        feed: {
          ...previousState.feed,
          settings: {
            ...previousState.feed.settings,
            [bundleKey]: updatedBundle,
          },
        },
        submitForType: null,
        submitStatus: null,
      }), () => showToast(i18n.t('common.updated'), 'success'));
      return true;
    } catch (error: any) {
      this.setState({submitStatus: null, submitForType: null}, () => {
        if (!error.response) {
          showToast(i18n.t('common.networkError'), 'error');
        } else {
          showToast(i18n.t('common.failed'), 'error');
        }
      });
      return false;
    }
  }

  render() {
    const {submitStatus, feed, submitForType} = this.state;
    const {onboardingResult} = this.props;
    const submitting = submitStatus === SUBMIT_STATUS__START;
    const mediaStorage = onboardingResult.result[
      ONBOARDING_TYPES.MEDIA_STORAGE
    ];
    const mediaStorageReady = mediaStorage?.ready !== false;
    // 过滤只切显示：不命中的卡片 display:none，表单状态原样留在 DOM 里，
    // 清空搜索即全部回来。分区 id 保留，滚动观察据此跳过隐藏中的分区。
    const query = this.state.sectionQuery.trim();
    const matched = query
      ? filterAdminSettingsSections(query, settingsSectionLabel)
      : ADMIN_SETTINGS_SECTIONS;
    const matchedIds = new Set<string>(matched.map(({id}) => id));
    const sectionClass = (id: string): string =>
      matchedIds.has(id) ? "scroll-mt-6" : "hidden";
    return (<AdminPageApp>
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-5">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={i18n.t("settings.searchSections")}
              className="h-11 bg-background pl-10"
              onChange={(event) => this.setState({sectionQuery: event.target.value})}
              onKeyDown={this.onSearchKeyDown}
              placeholder={i18n.t("settings.searchSectionsPlaceholder")}
              type="search"
              value={this.state.sectionQuery}
            />
          </div>
          {query !== "" && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {matched.length} / {ADMIN_SETTINGS_SECTIONS.length}
            </span>
          )}
        </div>
        {query !== "" && matched.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {i18n.t("settings.noSectionsMatch")}
          </p>
        )}
        <section className={sectionClass("custom-code")} id="custom-code">
          <CustomCodeSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
          />
        </section>
        <section className={sectionClass("tracking-urls")} id="tracking-urls">
          <TrackingSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            onSubmit={this.onSubmit}
            setChanged={() => this.setChanged(SETTINGS_CATEGORIES.ANALYTICS)}
          />
        </section>
        <section className={sectionClass("access-control")} id="access-control">
          <AccessSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            onSubmit={this.onSubmit}
            setChanged={() => this.setChanged(SETTINGS_CATEGORIES.ACCESS)}
          />
        </section>
        <section className={sectionClass("content-review")} id="content-review">
          <ContentReviewSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            onSubmit={this.onSubmit}
            setChanged={() => this.setChanged(SETTINGS_CATEGORIES.CONTENT_REVIEW)}
          />
        </section>
        <section className={sectionClass("cloudflare-token")} id="cloudflare-token">
          <CloudflareTokenSettingsApp />
        </section>
        <section className={sectionClass("subscribe-methods")} id="subscribe-methods">
          <SubscribeSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            onSubmit={this.onSubmit}
            setChanged={() => this.setChanged(SETTINGS_CATEGORIES.SUBSCRIBE_METHODS)}
          />
        </section>
        <section className={sectionClass("media-file-storage")} id="media-file-storage">
          <MediaFileStorageSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            onSubmit={this.onSubmit}
            setChanged={() => this.setChanged(MEDIA_FILE_STORAGE_SUBMIT_KEY)}
          />
        </section>
        <section className={sectionClass("items-settings")} id="items-settings">
          <ItemsSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            onSubmit={this.onSubmit}
            setChanged={() => this.setChanged(ITEMS_PER_PAGE_SUBMIT_KEY)}
          />
        </section>
        <section className={sectionClass("item-editor-sections")} id="item-editor-sections">
          <ItemEditorSectionsSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            onSubmit={this.onSubmit}
            setChanged={() => this.setChanged(SETTINGS_CATEGORIES.ITEM_EDITOR_SECTIONS)}
          />
        </section>
        <section className={sectionClass("favicon")} id="favicon">
          <FaviconSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            mediaStorage={mediaStorage}
            mediaStorageReady={mediaStorageReady}
            onSubmit={this.onSubmit}
            onSettingsChanged={this.updateSettingsState}
          />
        </section>
        <section className={sectionClass("site")} id="site">
          <SiteSettingsApp
            submitting={submitting}
            submitForType={submitForType}
            feed={feed}
            onSubmit={this.onSubmit}
            setChanged={() => this.setChanged(SITE_TITLE_SUBMIT_KEY)}
          />
        </section>
        <div aria-hidden="true" className="h-[50vh]" />
      </div>
    </AdminPageApp>);
  }
}
