import React from 'react';
import i18n from "@/client/i18n";
import {Trash2Icon} from "lucide-react";
import {navigate} from 'astro:transitions/client';
import AdminPageApp from '@/components/admin/shared/AdminPageApp';
import AdminInput from "@/components/admin/shared/AdminInput";
import Requests from "@/client/requests";
import {
  randomShortUUID,
  ADMIN_URLS,
  PUBLIC_URLS,
  resolvePublicBucketUrl,
} from '@/shared/StringUtils';
import AdminImageUploaderApp from "@/components/admin/shared/AdminImageUploaderApp";
import AdminDatetimePicker from '@/components/admin/shared/AdminDatetimePicker';
import {
  BODY_FORMAT_HTML,
  BODY_FORMAT_MARKDOWN,
  bodyFormat,
} from "@/shared/BodyFormat";
import {datetimeLocalStringToMs, datetimeLocalToMs} from "@/shared/TimeUtils";
import {getPublicBaseUrl} from "@/client/ClientUrlUtils";
import AdminRadioGroup from "@/components/admin/shared/AdminRadioGroup";
import AdminSelect from "@/components/admin/shared/AdminSelect";
import {showToast} from "@/client/ToastUtils";
import MediaManager from "./components/MediaManager";
import {
  ONBOARDING_TYPES,
  STATUSES,
} from "@/shared/Constants";
import {AdminSideQuickLinks, SideQuickLink} from "@/components/admin/shared/AdminSideQuickLinks";
import AdminRichEditor from "@/components/admin/shared/AdminRichEditor";
import AdminHelpLabel from "@/components/admin/shared/AdminHelpLabel";
import {
  ITEM_CONTROLS,
  CONTROLS_TEXTS_DICT
} from "./AdminHelpContent";
import {
  preventCloseWhenChanged,
} from "@/client/BrowserUtils";
import AutosaveCoordinator, {
  type AutosaveState,
} from "@/client/AutosaveCoordinator";
import {getMediaFileFromUrl} from "@/shared/MediaFileUtils";
import type {FeedContent, OnboardingResult} from "@/types";
import {Button} from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {queueReplacedImageUrl} from "@/client/ImageUploadUtils";
import AdminSaveAction from "@/components/admin/shared/AdminSaveAction";
import {nativeWebMcpAvailable} from "@/client/webmcp/feature-detection";
import {WEBMCP_INTERACTION_HEADERS} from "@/shared/WebMcp";
import type {SaveItemDraftInput} from "@/client/webmcp/schemas";

const SUBMIT_STATUS__START = 1;

const STATUS_LABEL_KEYS: Record<number, string> = {
  [STATUSES.PUBLISHED]: "items.statusPublished",
  [STATUSES.UNLISTED]: "items.statusUnlisted",
  [STATUSES.UNPUBLISHED]: "items.statusUnpublished",
};

const STATUS_DESC_KEYS: Record<number, string> = {
  [STATUSES.PUBLISHED]: "items.statusPublishedDesc",
  [STATUSES.UNLISTED]: "items.statusUnlistedDesc",
  [STATUSES.UNPUBLISHED]: "items.statusUnpublishedDesc",
};

function statusLabelKey(status: number): string {
  return STATUS_LABEL_KEYS[status] ?? "items.statusUnknown";
}

function statusDescKey(status: number): string {
  return STATUS_DESC_KEYS[status] ?? "items.statusUnknown";
}

function initItem(itemId: string) {
  return ({
    status: STATUSES.UNPUBLISHED,
    pubDateMs: datetimeLocalToMs(new Date()),
    pubDateIsDraftDefault: true,
    guid: itemId,
    'itunes:explicit': false,
    'itunes:block': false,
    'itunes:episodeType': 'full',
  });
}

interface Props {
  feedContent: FeedContent;
  itemId?: string;
  onboardingResult: OnboardingResult;
}

interface ItemSnapshot {
  deleteImageUrls: string[];
  item: Record<string, unknown>;
  webMcpSignal?: AbortSignal;
}

export default class EditItemApp extends React.Component<Props, any> {
  private autosave: AutosaveCoordinator<ItemSnapshot>;
  private cleanupNavigationGuard?: () => void;
  private mounted = false;
  private publishRequested = false;
  private webMcpController?: AbortController;
  private webMcpLoadVersion = 0;
  private webMcpSaveSignal?: AbortSignal;

  constructor(props: Props) {
    super(props);

    this.onSubmit = this.onSubmit.bind(this);
    this.onDelete = this.onDelete.bind(this);
    this.onPublish = this.onPublish.bind(this);
    this.onUpdateItemMeta = this.onUpdateItemMeta.bind(this);
    this.onUpdateItemStatus = this.onUpdateItemStatus.bind(this);
    this.saveSnapshot = this.saveSnapshot.bind(this);

    const action = props.itemId ? 'edit' : 'create';
    const itemId = props.itemId || randomShortUUID();
    const feed = {
      ...props.feedContent,
      items: props.feedContent.items ? [...props.feedContent.items] : [],
    };
    const item = feed.item
      ? {...feed.item, guid: feed.item.guid || itemId}
      : initItem(itemId);

    this.state = {
      feed,
      item,
      submitStatus: null,
      itemId,
      action,

      autoUpdateLink: action === 'create',
      userChangedLink: false,
      autosaveState: {dirty: false, phase: "idle"} satisfies AutosaveState,
      replacedImageUrls: [],
      books: [],
    };

    this.autosave = new AutosaveCoordinator({
      // Manual save only: `null` disables the countdown autosave, so a half-typed
      // field is never written (and never filed for review) on its own.
      delayMs: null,
      getSnapshot: () => ({
        deleteImageUrls: [...this.state.replacedImageUrls],
        item: {id: this.state.itemId, ...this.state.item},
        ...(this.webMcpSaveSignal
          ? {webMcpSignal: this.webMcpSaveSignal}
          : {}),
      }),
      onError: (error) => this.showSaveError(error),
      onStateChange: (autosaveState) => {
        if (this.mounted) this.setState({autosaveState});
      },
      save: this.saveSnapshot,
    });
  }

  componentDidMount() {
    this.mounted = true;
    this.cleanupNavigationGuard = preventCloseWhenChanged(
      () => this.autosave.hasUnsavedChanges(),
    );

    const {action, item} = this.state;
    if (action === 'create') {
      const {mediaFile} = item;
      const urlParams = new URLSearchParams(window.location.search);
      const title = urlParams.get('title') || '';

      const mediaFileFromUrl = getMediaFileFromUrl(urlParams);

      if (mediaFileFromUrl && Object.keys(mediaFileFromUrl).length > 0) {
        const attrDict = {
          title,
          mediaFile: {
            ...mediaFile,
            ...mediaFileFromUrl,
          },
        };
        this.onUpdateItemMeta(attrDict);
      }
    }
    this.reconcileWebMcpTool();

    // Load the book (channel) list so a chapter can be assigned to a book.
    Requests.axiosGet(ADMIN_URLS.ajaxBooks())
      .then((res: any) => this.setState({books: res?.data?.books || []}))
      .catch(() => this.setState({books: []}));
  }

  componentDidUpdate(_previousProps: Props, previousState: any) {
    if (previousState.item.status !== this.state.item.status) {
      this.reconcileWebMcpTool();
    }
  }

  componentWillUnmount() {
    this.mounted = false;
    this.webMcpLoadVersion += 1;
    this.webMcpController?.abort();
    this.autosave.dispose();
    this.cleanupNavigationGuard?.();
  }

  onUpdateItemMeta(attrDict: any, extraDict?: any, immediate = false) {
    this.setState((prevState: any) => ({
      item: {...prevState.item, ...attrDict,},
      ...extraDict,
    }), () => this.autosave.markChanged({immediate}));
  }

  /** Update a field inside `item._microfeed` (the novel-cms pocket that holds
   *  chapter metadata such as `volume` + `chapterNo`). Mirrors the channel-side
   *  helper in EditChannelApp. The `_microfeed` schema is `.loose()`, so these
   *  writes are never validated and never break the public API contract. */
  onUpdateItemMicrofeedMeta(keyName: any, value: any) {
    this.onUpdateItemMeta({
      '_microfeed': {
        ...(this.state.item._microfeed as Record<string, unknown> || {}),
        [keyName]: value,
      },
    });
  }

  onUpdateItemStatus(nextStatus: number) {
    const publicationFields = nextStatus === STATUSES.PUBLISHED &&
        this.state.item.pubDateIsDraftDefault === true
      ? {
          pubDateIsDraftDefault: false,
          pubDateMs: Date.now(),
        }
      : {};
    this.onUpdateItemMeta({
      ...publicationFields,
      status: nextStatus,
    }, undefined, true);
  }

  onPublish() {
    this.publishRequested = true;
    this.onUpdateItemStatus(STATUSES.PUBLISHED);
  }

  async onDelete() {
    if (!await this.autosave.flush()) return;

    const {item, itemId} = this.state;
    this.setState({submitStatus: SUBMIT_STATUS__START});
    Requests.axiosPost(ADMIN_URLS.ajaxFeed(), {
      item: {id: itemId, ...item, status: STATUSES.DELETED},
    })
      .then(() => {
        showToast(i18n.t('items.deleted'), 'success');
        this.setState({submitStatus: null}, () => {
          setTimeout(() => {
            void navigate(ADMIN_URLS.allItems());
          }, 1000);
        });
      })
      .catch((error: any) => {
        this.setState({submitStatus: null}, () => {
          if (!error.response) {
            showToast(i18n.t('common.networkError'), 'error');
          } else {
            showToast(i18n.t('common.failed'), 'error');
          }
        });
      });
  }

  onSubmit(e: any) {
    e.preventDefault();
    void this.autosave.flush();
  }

  async saveSnapshot(snapshot: ItemSnapshot) {
    const {webMcpSignal, ...body} = snapshot;
    if (webMcpSignal) {
      try {
        await Requests.axiosPost(ADMIN_URLS.ajaxFeed(), body, {
          headers: WEBMCP_INTERACTION_HEADERS,
          signal: webMcpSignal,
        });
      } finally {
        if (this.webMcpSaveSignal === webMcpSignal) {
          this.webMcpSaveSignal = undefined;
        }
      }
    } else {
      await Requests.axiosPost(ADMIN_URLS.ajaxFeed(), body);
    }
    if (!this.mounted) return;

    const created = this.state.action === 'create';
    const publishRequested = this.publishRequested;
    this.publishRequested = false;
    await new Promise<void>((resolve) => {
      this.setState((previousState: any) => ({
        action: created ? 'edit' : previousState.action,
        feed: {
          ...previousState.feed,
          item: snapshot.item,
        },
        replacedImageUrls: previousState.replacedImageUrls.filter(
          (url: string) => !snapshot.deleteImageUrls.includes(url),
        ),
      }), () => {
        if (created) {
          window.history.replaceState(
            window.history.state,
            '',
            ADMIN_URLS.editItem(this.state.itemId),
          );
        }
        resolve();
      });
    });
    showToast(
      publishRequested && snapshot.item.status === STATUSES.PUBLISHED
        ? i18n.t('items.itemPublished')
        : created ? i18n.t('items.itemAdded') : i18n.t('items.itemSaved'),
      'success',
    );
  }

  showSaveError(error: any) {
    if (!error?.response) {
      showToast(i18n.t('items.networkErrorChangesRemain'), 'error');
    } else {
      showToast(i18n.t('saveAction.error'), 'error');
    }
  }

  private reconcileWebMcpTool() {
    this.webMcpLoadVersion += 1;
    const loadVersion = this.webMcpLoadVersion;
    this.webMcpController?.abort();
    this.webMcpController = undefined;
    if (
      !this.mounted || this.state.item.status !== STATUSES.UNPUBLISHED ||
      !nativeWebMcpAvailable()
    ) {
      return;
    }
    void import("@/client/webmcp/editor-tools").then(
      ({registerItemDraftTool}) => {
        if (!this.mounted || loadVersion !== this.webMcpLoadVersion) return;
        const controller = new AbortController();
        this.webMcpController = controller;
        return registerItemDraftTool(
          controller.signal,
          (input, signal) => this.saveWebMcpDraft(input, signal),
        );
      },
    ).catch((error) => {
      if (!this.webMcpController?.signal.aborted) {
        this.webMcpController?.abort();
        console.warn(error);
      }
    });
  }

  private async saveWebMcpDraft(
    input: SaveItemDraftInput,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw signal.reason;
    if (this.state.item.status !== STATUSES.UNPUBLISHED) {
      throw new Error(i18n.t('items.webmcpOnlyUnpublished'));
    }
    this.webMcpSaveSignal = signal;
    await new Promise<void>((resolve) => {
      this.setState((previousState: any) => ({
        item: {
          ...previousState.item,
          ...(input.title !== undefined ? {title: input.title} : {}),
          ...(input.content_html !== undefined
            ? {
                // The tool writes an HTML body, so the way to read it has to
                // say so. Writing only `description` would leave a Markdown
                // chapter flagged as Markdown while holding HTML — the body and
                // its format must move together. Mirrors the two HTML editors,
                // which record HTML only when the chapter was Markdown.
                ...(bodyFormat(previousState.item.content_format) === BODY_FORMAT_MARKDOWN
                  ? {content_format: BODY_FORMAT_HTML}
                  : {}),
                description: input.content_html,
              }
            : {}),
          status: STATUSES.UNPUBLISHED,
        },
      }), () => {
        this.autosave.markChanged({immediate: true});
        resolve();
      });
    });
    if (!await this.autosave.flush()) {
      throw new Error(i18n.t('items.draftCouldNotSave'));
    }
    return {
      content_html: String(this.state.item.description ?? ""),
      editor_url: new URL(
        ADMIN_URLS.editItem(this.state.itemId),
        window.location.origin,
      ).toString(),
      id: this.state.itemId,
      status: "unpublished",
      title: String(this.state.item.title ?? ""),
    };
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {autosaveState, submitStatus, itemId, item, action, feed} = this.state;
    const microfeed = (item._microfeed as Record<string, unknown>) || {};
    const {onboardingResult} = this.props;
    const deleting = submitStatus === SUBMIT_STATUS__START;
    const {mediaFile} = item;
    const status = item.status || STATUSES.UNPUBLISHED;
    const mediaStorage = onboardingResult.result[
      ONBOARDING_TYPES.MEDIA_STORAGE
    ];
    const mediaStorageReady = mediaStorage?.ready !== false;

    const webGlobalSettings = feed.settings.webGlobalSettings || {};
    const publicBucketUrl = resolvePublicBucketUrl(
      webGlobalSettings.publicBucketUrl,
      window.location.hostname,
    );

    return (<AdminPageApp>
      <form className="grid grid-cols-1 gap-4 xl:grid-cols-12" onSubmit={this.onSubmit}>
        <div className="grid grid-cols-1 gap-4 xl:col-span-9">
          <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
            <MediaManager
              labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.MEDIA_FILE]}/>}
              feed={feed}
              mediaStorage={mediaStorage}
              mediaStorageReady={mediaStorageReady}
              initMediaFile={mediaFile || {}}
              onMediaFileUpdated={(newMediaFile: any, options?: {immediate?: boolean}) => {
                this.onUpdateItemMeta({
                  mediaFile: {
                    ...mediaFile,
                    ...newMediaFile,
                  },
                }, undefined, options?.immediate);
              }}
            />
          </div>
          <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
            <div className="flex">
              <div>
                <AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.IMAGE]}/>
                <AdminImageUploaderApp
                  mediaType="item"
                  feed={feed}
                  mediaStorage={mediaStorage}
                  mediaStorageReady={mediaStorageReady}
                  publicBucketUrl={publicBucketUrl}
                  currentImageUrl={item.image}
                  imageMetadataTarget={action === 'edit'
                    ? {id: itemId, type: 'item'}
                    : undefined}
                  onImageDeleted={() => {
                    if (action === 'edit') {
                      this.setState((prevState: any) => ({
                        item: {
                          ...prevState.item,
                          image: undefined,
                        },
                      }));
                    } else {
                      this.onUpdateItemMeta({image: undefined}, undefined, true);
                    }
                  }}
                  onImageUploaded={(
                    cdnUrl: any,
                    _contentType: any,
                    replacedImageUrl: unknown,
                  ) => this.setState((prevState: any) => ({
                    item: {...prevState.item, image: cdnUrl},
                    replacedImageUrls: queueReplacedImageUrl(
                      prevState.replacedImageUrls,
                      replacedImageUrl,
                    ),
                  }), () => this.autosave.markChanged({immediate: true}))}
                />
              </div>
              <div className="ml-8 flex-1">
                <AdminInput
                  labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.TITLE]}/>}
                  value={item.title}
                  onChange={(e: any) => {
                    const nextTitle = e.target.value;
                    const attrDict = {'title': nextTitle};
                    if (this.state.autoUpdateLink && !this.state.userChangedLink) {
                      (attrDict as any).link = PUBLIC_URLS.webItem(
                        itemId,
                        nextTitle,
                        getPublicBaseUrl(),
                      );
                    }
                    this.onUpdateItemMeta(attrDict);
                  }}
                />
                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <AdminDatetimePicker
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.PUB_DATE]}/>}
                    value={item.pubDateMs}
                    onChange={(e: any) => {
                      this.onUpdateItemMeta({
                        'pubDateIsDraftDefault': false,
                        'pubDateMs': datetimeLocalStringToMs(e.target.value),
                      });
                    }}
                  />
                  <AdminInput
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.LINK]}/>}
                    value={item.link}
                    onChange={(e: any) => this.onUpdateItemMeta({'link': e.target.value}, {userChangedLink: true})}
                  />
                </div>
                <div className="grid grid-cols-1 gap-2 mt-4">
                  <AdminRadioGroup
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.STATUS]}/>}
                    name="item-status"
                    value={String(status)}
                    options={[
                      {
                        label: i18n.t(statusLabelKey(STATUSES.PUBLISHED)),
                        value: String(STATUSES.PUBLISHED),
                      },
                      {
                        label: i18n.t(statusLabelKey(STATUSES.UNLISTED)),
                        value: String(STATUSES.UNLISTED),
                      },
                      {
                        label: i18n.t(statusLabelKey(STATUSES.UNPUBLISHED)),
                        value: String(STATUSES.UNPUBLISHED),
                      }]}
                    onValueChange={(value) =>
                      this.onUpdateItemStatus(parseInt(value, 10))}
                  />
                  <div className="text-muted-color text-xs" dangerouslySetInnerHTML={{__html: i18n.t(statusDescKey(status), {url: ADMIN_URLS.allItems()})}} />
                </div>
              </div>
            </div>
            <div className="mt-8 pt-8 border-t">
              <AdminRichEditor
                labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.DESCRIPTION]}/>}
                bodyFormat={item.content_format}
                value={item.description}
                onChange={(value: any) => this.onUpdateItemMeta({'description': value})}
                onFormatChange={(value: string) =>
                  this.onUpdateItemMeta({'content_format': value})}
                extra={{
                  publicBucketUrl,
                  folderName: `items/${itemId}`,
                  mediaStorageReady,
                }}
              />
            </div>
          </div>
          <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
            <details>
              <summary className="m-page-summary">{t('items.podcastFields')}</summary>
              <div className="grid grid-cols-1 gap-8">
                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <AdminRadioGroup
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.ITUNES_EXPLICIT]}/>}
                    name="lh-explicit"
                    value={item['itunes:explicit'] ? 'yes' : 'no'}
                    options={[{
                      label: 'yes',
                      value: 'yes',
                    }, {
                      label: 'no',
                      value: 'no',
                    }]}
                    onValueChange={(value) => this.onUpdateItemMeta({'itunes:explicit': value === 'yes'})}
                  />
                  <AdminInput
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.GUID]}/>}
                    value={item.guid || itemId}
                    onChange={(e: any) => this.onUpdateItemMeta({'guid': e.target.value})}
                  />
                  <AdminInput
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.ITUNES_TITLE]}/>}
                    value={item['itunes:title']}
                    onChange={(e: any) => this.onUpdateItemMeta({'itunes:title': e.target.value})}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <AdminRadioGroup
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.ITUNES_EPISODE_TYPE]}/>}
                    name="feed-itunes-episodetype"
                    value={item['itunes:episodeType']}
                    options={[{
                      label: 'full',
                      value: 'full',
                    }, {
                      label: 'trailer',
                      value: 'trailer',
                    }, {
                      label: 'bonus',
                      value: 'bonus',
                    },
                    ]}
                    onValueChange={(value) => this.onUpdateItemMeta({'itunes:episodeType': value})}
                  />
                  <AdminInput
                    type="number"
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.ITUNES_SEASON]}/>}
                    value={item['itunes:season']}
                    extraParams={{min: "1"}}
                    onChange={(e: any) => this.onUpdateItemMeta({'itunes:season': e.target.value})}
                  />
                  <AdminInput
                    type="number"
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.ITUNES_EPISODE]}/>}
                    value={item['itunes:episode']}
                    extraParams={{min: "1"}}
                    onChange={(e: any) => this.onUpdateItemMeta({'itunes:episode': e.target.value})}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <AdminRadioGroup
                    labelComponent={<AdminHelpLabel help={CONTROLS_TEXTS_DICT[ITEM_CONTROLS.ITUNES_BLOCK]}/>}
                    name="feed-itunes-block"
                    value={item['itunes:block'] ? 'yes' : 'no'}
                    options={[{
                      label: 'Yes',
                      value: 'yes',
                    }, {
                      label: 'No',
                      value: 'no',
                    }]}
                    onValueChange={(value) => this.onUpdateItemMeta({'itunes:block': value === 'yes'})}
                  />
                </div>
              </div>
            </details>
          </div>
          <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
            <h2 className="text-lg font-semibold">{t('items.novelFields')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('items.novelFieldsIntro')}
            </p>
            <div className="mt-5">
              <AdminSelect
                label={t('items.bookId')}
                placeholder={t('items.bookIdPlaceholder')}
                options={[
                  {value: "", label: t('items.noBook')},
                  ...this.state.books.map((b: any) => ({
                    value: b.id,
                    label: b.title,
                  })),
                ]}
                value={
                  (() => {
                    const bid = microfeed.bookId;
                    if (!bid) return {value: "", label: t('items.noBook')};
                    const found = this.state.books.find(
                      (b: any) => b.id === bid,
                    );
                    return {
                      value: String(bid),
                      label: found ? found.title : String(bid),
                    };
                  })()
                }
                onChange={(option: any) => {
                  if (!option || option.value === "") {
                    this.onUpdateItemMicrofeedMeta('bookId', undefined);
                  } else {
                    this.onUpdateItemMicrofeedMeta('bookId', option.value);
                  }
                }}
              />
            </div>
            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
              <AdminInput
                label={t('items.volume')}
                placeholder={t('items.volumePlaceholder')}
                value={microfeed.volume ? String(microfeed.volume) : ''}
                onChange={(e: any) => this.onUpdateItemMicrofeedMeta('volume', e.target.value)}
              />
              <AdminInput
                label={t('items.chapterNo')}
                placeholder={t('items.chapterNoPlaceholder')}
                value={microfeed.chapterNo != null ? String(microfeed.chapterNo) : ''}
                onChange={(e: any) => {
                  const raw = e.target.value.trim();
                  this.onUpdateItemMicrofeedMeta(
                    'chapterNo',
                    raw === '' ? null : raw,
                  );
                }}
              />
            </div>
          </div>
        </div>
        <div className="xl:col-span-3">
          <div className="grid gap-4 xl:sticky xl:top-4">
            <AdminSaveAction
              {...autosaveState}
              idleMessage={action === 'create'
                ? t('items.saveActionIdleCreate')
                : undefined}
            >
              {status !== STATUSES.PUBLISHED && (
                <>
                  <Button
                    aria-describedby="publish-item-description"
                    className="w-full"
                    disabled={autosaveState.phase === "saving"}
                    onClick={this.onPublish}
                    type="button"
                    variant="outline"
                  >
                    {t('items.publish')}
                  </Button>
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    id="publish-item-description"
                  >
                    {t('items.publishDescription')}
                  </p>
                </>
              )}
            </AdminSaveAction>
            {action === 'edit' && <div>
              <AdminSideQuickLinks
                AdditionalLinksDiv={<div className="flex flex-wrap">
                  <SideQuickLink url={PUBLIC_URLS.webItem(itemId, item.title)} text={t('items.webItem')}/>
                  <SideQuickLink url={PUBLIC_URLS.jsonItem(itemId)} text={t('items.jsonItem')}/>
                </div>}
              />
              <div className="mt-4 flex justify-center rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
                <AlertDialog>
                  <AlertDialogTrigger render={<Button disabled={deleting} type="button" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" />}>
                    <Trash2Icon aria-hidden="true" className="size-4" />
                    {t('items.deleteThisItem')}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('items.deleteThisItemConfirm')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('items.deletePermanently')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction disabled={deleting} type="button" variant="destructive" onClick={this.onDelete}>
                        {deleting ? t('items.deleting') : t('items.deleteItem')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>}
          </div>
        </div>
      </form>
    </AdminPageApp>);
  }
}
