import React from 'react';
import i18n from "@/client/i18n";
import clsx from 'clsx';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.min.css';
import Requests from '@/client/requests';
import {
  randomHex,
  resolvePublicBucketUrl,
  urlJoinWithRelative,
} from '@/shared/StringUtils';
import type {ImageMetadataTarget} from "@/types";
import AdminDialog from "../AdminDialog";
import FileUploader from "../AdminFileUploader";
import {
  CloudUploadIcon,
  ExternalLinkIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import {showToast} from "@/client/ToastUtils";
import MediaStorageUnavailableDialog from "../MediaStorageUnavailableDialog";
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
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import AdminImagePreviewDialog from "../AdminImagePreviewDialog";

const UPLOAD_STATUS__START = 1;

function EmptyImage({fileTypes}: any) {
  return (<div className="text-brand-light text-sm flex flex-col justify-center items-center h-full">
    <div className="mb-2">
      <CloudUploadIcon className="w-8" />
    </div>
    <div className="font-semibold">
      {i18n.t("shared.clickOrDragUpload")}
    </div>
    <div className="mt-2">
      {fileTypes.join(',')}
    </div>
  </div>);
}

function PreviewImage({url}: {url: string}) {
  return (<div className="relative flex h-full w-full justify-center overflow-hidden rounded-md">
    <img
      alt={i18n.t("shared.uploadedImage")}
      src={url}
      className="h-full w-full object-cover"
    />
    <div className="absolute right-2 bottom-2 flex size-10 items-center justify-center rounded-lg border bg-background text-foreground shadow-md">
      <PencilIcon aria-hidden="true" className="size-5" />
    </div>
  </div>);
}

const MINIMUM_IMAGE_EDGE = 1400;

// Source dimensions have to be read from the decoded image, not from the file
// header, so this is async. Square-ness is deliberately NOT checked: the
// cropper runs with aspectRatio 1.0 and produces the square image itself, so
// requiring a square source would reject perfectly usable photos.
function readImageSize(
  file: File,
): Promise<{height: number; width: number} | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    const finish = (size: {height: number; width: number} | null) => {
      URL.revokeObjectURL(objectUrl);
      resolve(size);
    };
    image.onload = () => finish({
      height: image.naturalHeight,
      width: image.naturalWidth,
    });
    image.onerror = () => finish(null);
    image.src = objectUrl;
  });
}

// Returns a ready-to-display message, or null when the file is acceptable.
async function isInvalidImage(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/")) {
    return i18n.t("shared.imageNotAnImage");
  }
  const size = await readImageSize(file);
  if (!size) {
    return i18n.t("shared.imageNotAnImage");
  }
  if (size.width < MINIMUM_IMAGE_EDGE || size.height < MINIMUM_IMAGE_EDGE) {
    return i18n.t("shared.imageTooSmall", {
      width: size.width,
      height: size.height,
    });
  }
  return null;
}

export default class AdminImageUploaderApp extends React.Component<any, any> {
  private inputFile: HTMLInputElement | null = null;

  constructor(props: any) {
    super(props);

    this.onFileUploadClick = this.onFileUploadClick.bind(this);
    this.onFileUpload = this.onFileUpload.bind(this);
    this.onFileUploadToR2 = this.onFileUploadToR2.bind(this);
    this.onDeleteImage = this.onDeleteImage.bind(this);
    this.showMediaStorageUnavailable =
      this.showMediaStorageUnavailable.bind(this);

    const webGlobalSettings = props.feed.settings.webGlobalSettings || {};
    const publicBucketUrl = resolvePublicBucketUrl(
      props.publicBucketUrl || webGlobalSettings.publicBucketUrl,
      window.location.hostname,
    );

    this.initState = {
      currentImageUrl: props.currentImageUrl,
      mediaType: props.mediaType || 'channel',
      uploadStatus: null,
      progressText: '0.00%',
      publicBucketUrl,

      showModal: false,
      showDeleteConfirm: false,
      showPreview: false,
      showMediaStorageUnavailable: false,
      deleting: false,
      previewImageUrl: null,
      cropper: null,
      cdnFilename: null,
      contentType: '',
      imageWidth: 0,
      imageHeight: 0,
    };

    this.state = {
      ...this.initState,
    };
  }

  componentDidMount() {
  }

  componentDidUpdate(previousProps: any) {
    if (
      previousProps.currentImageUrl !== this.props.currentImageUrl &&
      this.props.currentImageUrl !== this.state.currentImageUrl
    ) {
      this.setState({currentImageUrl: this.props.currentImageUrl || null});
    }
    if (
      previousProps.publicBucketUrl !== this.props.publicBucketUrl &&
      this.props.publicBucketUrl !== this.state.publicBucketUrl
    ) {
      this.setState({
        publicBucketUrl: resolvePublicBucketUrl(
          this.props.publicBucketUrl,
          window.location.hostname,
        ),
      });
    }
  }

  componentWillUnmount() {
    if (this.state.previewImageUrl) {
      URL.revokeObjectURL(this.state.previewImageUrl);
    }
    if (this.state.cropper) {
      this.state.cropper.destroy();
    }
  }

  onFileUploadClick(e?: {preventDefault?: () => void}) {
    e?.preventDefault?.();
    if (this.props.mediaStorageReady === false) {
      this.showMediaStorageUnavailable();
      return;
    }
    if (!this.inputFile) {
      return;
    }
    const {uploadStatus} = this.state;
    if (uploadStatus === UPLOAD_STATUS__START) {
      return;
    }

    this.inputFile.click();
  }

  async onDeleteImage() {
    const {currentImageUrl, deleting} = this.state;
    if (!currentImageUrl || deleting) {
      return;
    }
    this.setState({deleting: true});
    try {
      await Requests.deleteImage(
        currentImageUrl,
        this.props.imageMetadataTarget as ImageMetadataTarget | undefined,
      );
      await this.props.onImageDeleted?.();
      this.setState({
        currentImageUrl: null,
        deleting: false,
        showDeleteConfirm: false,
        showPreview: false,
      }, () => showToast(i18n.t('shared.imageDeleted'), 'success'));
    } catch (error: any) {
      this.setState({deleting: false}, () => {
        if (!error.response) {
          showToast(i18n.t('common.networkError'), 'error');
        } else {
          showToast(i18n.t('shared.failedDeleteImage'), 'error');
        }
      });
    }
  }

  async onFileUpload(file: any) {
    if (this.props.mediaStorageReady === false) {
      this.showMediaStorageUnavailable();
      return;
    }
    const {mediaType} = this.state;
    if (!file) {
      return;
    }

    const errorMessage = await isInvalidImage(file);
    if (errorMessage) {
      showToast(errorMessage, "error");
      return;
    }

    const {name, type} = file;
    const extension = name.slice((name.lastIndexOf(".") - 1 >>> 0) + 2);
    let newFilename = `${mediaType}-${randomHex(32)}`;
    if (extension && extension.length > 0) {
      newFilename += `.${extension}`;
    }
    if (this.state.previewImageUrl) {
      URL.revokeObjectURL(this.state.previewImageUrl);
    }
    const previewUrl = URL.createObjectURL(file);
    this.setState({
      previewImageUrl: previewUrl,
      showModal: true,
      cdnFilename: `images/${newFilename}`,
      contentType: type,
    })
  }

  onFileUploadToR2() {
    if (this.props.mediaStorageReady === false) {
      this.showMediaStorageUnavailable();
      return;
    }
    const {cropper, cdnFilename, previewImageUrl} = this.state;
    if (!cropper) {
      return;
    }
    this.setState({ uploadStatus: UPLOAD_STATUS__START });
    cropper.getCroppedCanvas().toBlob((blob: Blob | null) => {
      if (!blob) {
        showToast(i18n.t('shared.failedPrepareImage'), 'error');
        this.setState({...this.initState});
        return;
      }
      cropper.disable();

      Requests.upload(blob, cdnFilename, (percentage: any) => {
        this.setState({
          progressText: `${Number(percentage * 100.0).toFixed(2)}%`,
        });
      }, (cdnUrl: any) => {
        const replacedImageUrl = this.state.currentImageUrl;
        this.props.onImageUploaded(
          cdnUrl,
          blob.type || 'image/png',
          replacedImageUrl,
        );
        cropper.destroy();
        if (previewImageUrl) {
          URL.revokeObjectURL(previewImageUrl);
        }
        this.setState({
          ...this.initState,
          currentImageUrl: cdnUrl,
          publicBucketUrl: resolvePublicBucketUrl(
            this.props.publicBucketUrl || this.state.publicBucketUrl,
            window.location.hostname,
          ),
        });
      }, () => {
        showToast(i18n.t('shared.failedUpload'), 'error', 2000);
        this.setState({...this.initState});
      }, (error: any) => {
        this.setState({...this.initState}, () => {
          if (!error.response) {
            showToast(i18n.t('common.networkError'), 'error');
          } else {
            showToast(i18n.t('common.failed'), 'error');
          }
        });
      });
    }, 'image/png');
  }

  showMediaStorageUnavailable() {
    this.setState({showMediaStorageUnavailable: true});
  }

  render() {
    const {uploadStatus, currentImageUrl, deleting, progressText, showModal,
      showDeleteConfirm,
      showPreview,
      showMediaStorageUnavailable, publicBucketUrl, previewImageUrl,
      imageWidth, imageHeight} = this.state;
    const absoluteImageUrl =  currentImageUrl ? urlJoinWithRelative(publicBucketUrl, currentImageUrl) : null;
    const fileTypes = ['PNG', 'JPG', 'JPEG'];
    const uploading = uploadStatus === UPLOAD_STATUS__START;
    const mediaStorageReady = this.props.mediaStorageReady !== false;
    const {imageSizeNotOkayFunc, imageSizeNotOkayMsgFunc} = this.props;
    const imageSizeNotOkay = imageSizeNotOkayFunc ? imageSizeNotOkayFunc(imageWidth, imageHeight) :
      imageWidth < 1400 || imageHeight < 1400;
    const imageSizeNotOkayMsg = imageSizeNotOkayMsgFunc ? imageSizeNotOkayMsgFunc(imageWidth, imageHeight) :
      i18n.t("shared.imageTooSmall", {width: parseInt(imageWidth), height: parseInt(imageHeight)});
    return (<div className="lh-upload-wrapper">
      {absoluteImageUrl ? <>
        <input
          accept=".png,.jpg,.jpeg"
          className="hidden"
          disabled={uploading || !mediaStorageReady}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) {
              this.onFileUpload(file);
            }
          }}
          ref={(element) => {
            this.inputFile = element;
          }}
          type="file"
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={(
              <button
                aria-label={i18n.t("shared.manageUploadedImage")}
                className="lh-upload-image-size relative overflow-hidden rounded-md border-2 border-dashed border-brand-light outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2"
                disabled={uploading || deleting}
                type="button"
              />
            )}
          >
            <PreviewImage url={absoluteImageUrl} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={this.onFileUploadClick}>
              <RefreshCwIcon aria-hidden="true" />
              {i18n.t("shared.replace")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => this.setState({showPreview: true})}>
              <ExternalLinkIcon aria-hidden="true" />
              {i18n.t("shared.preview")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={deleting}
              onClick={() => this.setState({showDeleteConfirm: true})}
              variant="destructive"
            >
              <Trash2Icon aria-hidden="true" />
              {deleting ? i18n.t("shared.deleting") : i18n.t("shared.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AdminImagePreviewDialog
          imageUrl={absoluteImageUrl}
          onOpenChange={(open) => this.setState({showPreview: open})}
          open={showPreview}
        />
        <AlertDialog
          onOpenChange={(open) => {
            if (!deleting) {
              this.setState({showDeleteConfirm: open});
            }
          }}
          open={showDeleteConfirm}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{i18n.t("shared.deleteThisImage")}</AlertDialogTitle>
              <AlertDialogDescription>
                {i18n.t("shared.deleteImageConfirmDesc")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{i18n.t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleting}
                onClick={this.onDeleteImage}
                type="button"
                variant="destructive"
              >
                {deleting ? i18n.t("shared.deleting") : i18n.t("shared.deleteImage")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </> : <FileUploader
        handleChange={this.onFileUpload}
        name="imageUploader"
        types={fileTypes}
        disabled={uploading || !mediaStorageReady}
        onDisabledClick={!uploading
          ? this.showMediaStorageUnavailable
          : undefined}
        classes="lh-upload-fileinput lh-upload-fileinput-image"
      >
        <div className="lh-upload-image-size lh-upload-box">
          <EmptyImage fileTypes={fileTypes} />
        </div>
      </FileUploader>}
      <MediaStorageUnavailableDialog
        dashboardUrl={this.props.mediaStorage?.dashboardUrl}
        onOpenChange={(open) => this.setState({
          showMediaStorageUnavailable: open,
        })}
        open={showMediaStorageUnavailable}
        state={this.props.mediaStorage?.mediaStorageState}
      />
      <AdminDialog
        title={i18n.t("shared.cropImage")}
        open={showModal}
        onOpenChange={(open) => this.setState({showModal: open})}
        closeDisabled={uploading}
      >
        {previewImageUrl && <div>
          <img
            className="w-full"
            src={previewImageUrl}
            onLoad={(e: any) => {
              const {clientWidth, clientHeight} = e.target;
              const size = Math.min(clientWidth, clientHeight);
              const options: any = {
                aspectRatio: 1.0,
                viewMode: 3,
                cropBoxResizable: true,
                crop: (event: any) => {
                  const {width, height} = event.detail;
                  this.setState({imageWidth: width, imageHeight: height});
                },
                ready: () => {
                  cropper.setCropBoxData({width: size, height: size});
                }
              };
              // if (clientWidth === clientHeight) {
              //   options.minCropBoxHeight = size;
              //   options.minCropBoxWidth = size;
              //   options.cropBoxResizable = false;
              // }
              const cropper = new Cropper(e.target, options);
              this.setState({cropper});
            }}
          />
        </div>}
        <div className="mt-4 flex justify-center">
          <Button
            onClick={this.onFileUploadToR2}
            disabled={uploading || !mediaStorageReady}
          >
            {uploading ? `${i18n.t("shared.uploading")} ${progressText}` : i18n.t("shared.upload")}
          </Button>
        </div>
        {imageWidth > 0 && imageHeight > 0 && <div className={clsx("mt-2 text-xs text-center", imageSizeNotOkay ? 'text-red-500' : 'text-green-500')}>
          {imageSizeNotOkay ? <div>{imageSizeNotOkayMsg}</div> :
            <div>{i18n.t("shared.imageOk", {width: parseInt(imageWidth), height: parseInt(imageHeight)})}</div>}
        </div>}
      </AdminDialog>
    </div>);
  }
}
