import AdminDialog from "@/components/admin/shared/AdminDialog";
import {Button} from "@/components/ui/button";
import {DialogClose, DialogFooter} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import type {
  RichEditorMediaSettings,
  RichEditorMediaType,
} from "@/client/RichEditorMedia";
import {useTranslation} from "@/client/i18n";

interface Props {
  errors: Partial<Record<"height" | "width", string>>;
  mediaType: RichEditorMediaType;
  onChange: (settings: RichEditorMediaSettings) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  open: boolean;
  settings: RichEditorMediaSettings;
}

export default function RichEditorMediaSettingsDialog({
  errors,
  mediaType,
  onChange,
  onOpenChange,
  onSave,
  open,
  settings,
}: Props) {
  const {t} = useTranslation();
  const typeLabel = mediaType === "image" ? t("shared.image") : t("shared.video");
  const update = (
    field: keyof RichEditorMediaSettings,
    value: string,
  ) => onChange({...settings, [field]: value});

  return (
    <AdminDialog
      onOpenChange={onOpenChange}
      open={open}
      title={`${t("shared.edit")}${typeLabel}`}
    >
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          {t("shared.mediaSettingsIntro", {type: typeLabel})}
        </p>
        <FieldGroup className="gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={Boolean(errors.width)}>
              <FieldLabel htmlFor="rich-editor-media-width">{t("shared.width")}</FieldLabel>
              <Input
                aria-invalid={Boolean(errors.width)}
                id="rich-editor-media-width"
                onChange={(event) => update("width", event.target.value)}
                placeholder={t("shared.widthPlaceholder")}
                value={settings.width}
              />
              <FieldDescription>
                {t("shared.widthDesc")}
              </FieldDescription>
              <FieldError>{errors.width}</FieldError>
            </Field>
            <Field data-invalid={Boolean(errors.height)}>
              <FieldLabel htmlFor="rich-editor-media-height">{t("shared.height")}</FieldLabel>
              <Input
                aria-invalid={Boolean(errors.height)}
                id="rich-editor-media-height"
                onChange={(event) => update("height", event.target.value)}
                placeholder={t("shared.heightPlaceholder")}
                value={settings.height}
              />
              <FieldDescription>
                {mediaType === "video"
                  ? t("shared.heightVideoDesc")
                  : t("shared.heightImageDesc")}
              </FieldDescription>
              <FieldError>{errors.height}</FieldError>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {mediaType === "image" && (
              <Field>
                <FieldLabel htmlFor="rich-editor-media-alt">{t("shared.altText")}</FieldLabel>
                <Input
                  id="rich-editor-media-alt"
                  onChange={(event) => update("alt", event.target.value)}
                  placeholder={t("shared.describeImage")}
                  value={settings.alt}
                />
                <FieldDescription>
                  {t("shared.altTextHelp")}
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="rich-editor-media-title">{t("shared.title")}</FieldLabel>
              <Input
                id="rich-editor-media-title"
                onChange={(event) => update("title", event.target.value)}
                placeholder={t("shared.optionalTitle")}
                value={settings.title}
              />
              {mediaType === "video" && (
                <FieldDescription>
                  {t("shared.titleVideoHelp")}
                </FieldDescription>
              )}
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="rich-editor-media-style">
              {t("shared.additionalStyle")}
            </FieldLabel>
            <Textarea
              id="rich-editor-media-style"
              onChange={(event) => update("style", event.target.value)}
              placeholder={mediaType === "video"
                ? "e.g., aspect-ratio: 9 / 16; border-radius: 12px;"
                : "e.g., border-radius: 12px; object-fit: cover;"}
              rows={3}
              value={settings.style}
            />
            <FieldDescription>
              {t("shared.styleHelp")}
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button onClick={onSave} type="button">{t("shared.apply")}</Button>
        </DialogFooter>
      </div>
    </AdminDialog>
  );
}
