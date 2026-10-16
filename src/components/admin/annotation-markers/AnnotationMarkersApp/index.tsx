import {useState} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {cn} from "@/lib/utils";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {DEFAULT_SMALL_FONT_SCALE} from "@/shared/TcmMarkers";
import type {AnnotationMarker} from "@/server/admin/annotation-marker-handlers";

interface Props {
  initialMarkers: AnnotationMarker[];
}

/** Fallback colour for the create form — the renderer's own grey. */
const DEFAULT_MARKER_COLOR = "#808080";

/** `#RGB`, the short form a colour input expands on read-back. */
const HEX_TRIPLE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu;
/** `#RRGGBB`, the only shape a native colour input stores. */
const HEX_FULL = /^#[0-9a-f]{6}$/iu;
/** `rgb()` / `rgba()` prefixes; the alpha, if any, is dropped on read-back. */
const RGB_FUNC = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/iu;

/** One channel as two lowercase hex digits, clamped to the 0–255 range. */
const channelHex = (channel: string | undefined) =>
  Math.min(255, Math.max(0, Number(channel ?? "0"))).toString(16).padStart(2, "0");

/**
 * The value a native colour input can display: lowercase `#RRGGBB`.
 *
 * `#RGB` is expanded, `rgb()`/`rgba()` keep their channels and drop the alpha
 * (the native picker has no alpha channel), and anything unrecognised falls
 * back to the renderer's grey so the swatch never paints as black.
 */
export function colorInputValue(color: string): string {
  if (HEX_TRIPLE.test(color)) return color.toLowerCase().replace(HEX_TRIPLE, "#$1$1$2$2$3$3");
  if (HEX_FULL.test(color)) return color.toLowerCase();
  const func = RGB_FUNC.exec(color);
  if (func) return `#${func.slice(1).map(channelHex).join("")}`;
  return DEFAULT_MARKER_COLOR;
}

/** link_type values and the i18n key naming each one. */
const LINK_TYPES: Array<{value: number; label: string}> = [
  {value: 0, label: "annotationMarkers.linkTypeNone"},
  {value: 1, label: "annotationMarkers.linkTypeYao"},
  {value: 2, label: "annotationMarkers.linkTypeFang"},
  {value: 3, label: "annotationMarkers.linkTypeTerm"},
];

/** The presentation fields, shared by the edit row and the create form. */
interface StyleDraft {
  color: string;
  smallFont: boolean;
  smallFontScale: string;
  linkType: number;
}

function draftOf(marker: AnnotationMarker): StyleDraft {
  return {
    color: marker.color,
    smallFont: marker.smallFont,
    smallFontScale: String(marker.smallFontScale),
    linkType: marker.linkType,
  };
}

const EMPTY_DRAFT: StyleDraft = {
  color: DEFAULT_MARKER_COLOR,
  smallFont: false,
  smallFontScale: String(DEFAULT_SMALL_FONT_SCALE),
  linkType: 0,
};

/** Pull the already-localized error message out of a failed admin ajax response. */
async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as {error?: string};
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

/** The marker text as the public pages will paint it: colour + optional size. */
function MarkerPreview({draft}: {draft: StyleDraft}) {
  return (
    <span
      className="mf-mk"
      style={{
        color: draft.color,
        ...(draft.smallFont ? {fontSize: `${draft.smallFontScale}em`} : {}),
      }}
    >
      示例
    </span>
  );
}

/** The shared props every style field takes: the draft, its setter, the translator. */
interface StyleFieldProps {
  draft: StyleDraft;
  onChange: (next: StyleDraft) => void;
  t: (key: string) => string;
}

/**
 * The colour well. A native colour input styled down to the 20×20 swatch the
 * read-only row shows, plus the stored value as text so the committed colour
 * stays readable (rgba() rows keep their exact string until a pick overwrites it).
 */
function ColorField({draft, onChange, t}: StyleFieldProps) {
  return (
    <span className="flex items-center gap-2">
      <input
        aria-label={t("annotationMarkers.color")}
        className="h-5 w-5 shrink-0 cursor-pointer appearance-none rounded border p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-none [&::-moz-color-swatch]:border-none"
        onChange={(event) => onChange({...draft, color: event.target.value})}
        type="color"
        value={colorInputValue(draft.color)}
      />
      <span className="font-mono text-xs">{draft.color}</span>
    </span>
  );
}

/** The reduced-size toggle. */
function SmallFontField({draft, onChange, t}: StyleFieldProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        checked={draft.smallFont}
        onChange={(event) => onChange({...draft, smallFont: event.target.checked})}
        type="checkbox"
      />
      {t("annotationMarkers.smallFont")}
    </label>
  );
}

/** The reduced-size ratio, only editable while the toggle is on. */
function SmallFontScaleField({draft, onChange, t}: StyleFieldProps) {
  return (
    <Input
      aria-label={t("annotationMarkers.smallFontScale")}
      className="w-20"
      disabled={!draft.smallFont}
      max={1}
      min={0.3}
      onChange={(event) => onChange({...draft, smallFontScale: event.target.value})}
      step={0.05}
      type="number"
      value={draft.smallFontScale}
    />
  );
}

/** Which entity the marker links to (none / 中药 / 方剂 / 名词). */
function LinkTypeField({draft, onChange, t}: StyleFieldProps) {
  return (
    <select
      aria-label={t("annotationMarkers.linkType")}
      className="rounded-md border bg-background px-3 py-2 text-sm"
      onChange={(event) => onChange({...draft, linkType: Number(event.target.value)})}
      value={draft.linkType}
    >
      {LINK_TYPES.map((option) => (
        <option key={option.value} value={option.value}>
          {t(option.label)}
        </option>
      ))}
    </select>
  );
}

/**
 * The four style inputs as one inline group, for the create form below the
 * table. The edit row places each field in its own cell instead, so every
 * control sits under its column header.
 */
export function StyleFields({draft, onChange, t}: StyleFieldProps) {
  return (
    <>
      <ColorField draft={draft} onChange={onChange} t={t} />
      <SmallFontField draft={draft} onChange={onChange} t={t} />
      <SmallFontScaleField draft={draft} onChange={onChange} t={t} />
      <LinkTypeField draft={draft} onChange={onChange} t={t} />
    </>
  );
}

/**
 * Admin screen for the annotation markers. The markers are the toolbar buttons
 * the wangEditor body editor turns into `$<code>{...}` wrappers, and the same
 * catalogue is what the public pages paint those wrappers with — so the colour,
 * the reduced size (and its ratio) and the link type are all edited here rather
 * than in a migration. Changes take effect on the next page load, no redeploy.
 */
export default function AnnotationMarkersApp({initialMarkers}: Props) {
  const {t} = useTranslation();
  const [markers, setMarkers] = useState<AnnotationMarker[]>(initialMarkers);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newMulti, setNewMulti] = useState(false);
  const [newDraft, setNewDraft] = useState<StyleDraft>(EMPTY_DRAFT);

  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editMulti, setEditMulti] = useState(false);
  const [editDraft, setEditDraft] = useState<StyleDraft>(EMPTY_DRAFT);

  const refresh = (next: AnnotationMarker[]) => setMarkers(next);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAnnotationMarkersCreate(), {
        body: JSON.stringify({
          code: newCode,
          title: newTitle,
          multi: newMulti,
          color: newDraft.color,
          smallFont: newDraft.smallFont,
          smallFontScale: Number(newDraft.smallFontScale),
          linkType: newDraft.linkType,
        }),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("annotationMarkers.createFailed")));
      }
      const data = (await response.json()) as {markers: AnnotationMarker[]};
      refresh(data.markers);
      setCreating(false);
      setNewCode("");
      setNewTitle("");
      setNewMulti(false);
      setNewDraft(EMPTY_DRAFT);
      showToast(t("annotationMarkers.created"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("annotationMarkers.createFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (marker: AnnotationMarker) => {
    setEditing(marker.code);
    setEditTitle(marker.title);
    setEditMulti(marker.multi);
    setEditDraft(draftOf(marker));
  };

  const saveEdit = async (code: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAnnotationMarkersUpdate(), {
        body: JSON.stringify({
          code,
          title: editTitle,
          multi: editMulti,
          color: editDraft.color,
          smallFont: editDraft.smallFont,
          smallFontScale: Number(editDraft.smallFontScale),
          linkType: editDraft.linkType,
        }),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("annotationMarkers.saveFailed")));
      }
      const data = (await response.json()) as {markers: AnnotationMarker[]};
      refresh(data.markers);
      setEditing(null);
      showToast(t("annotationMarkers.saved"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("annotationMarkers.saveFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (marker: AnnotationMarker) => {
    if (busy) return;
    if (!window.confirm(t("annotationMarkers.confirmDelete", {title: marker.title}))) return;
    setBusy(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAnnotationMarkersDelete(), {
        body: JSON.stringify({code: marker.code}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, t("annotationMarkers.deleteFailed")));
      }
      const data = (await response.json()) as {markers: AnnotationMarker[]};
      refresh(data.markers);
      showToast(t("annotationMarkers.deleted"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("annotationMarkers.deleteFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const linkTypeLabel = (value: number) =>
    t(LINK_TYPES.find((option) => option.value === value)?.label ?? "annotationMarkers.linkTypeNone");

  return (
    <div className="annotation-markers">
      <p className="annotation-markers__hint">{t("annotationMarkers.description")}</p>

      <div className="overflow-x-auto">
        <table className="annotation-markers__table w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="py-2 pr-4">{t("annotationMarkers.code")}</th>
              <th className="py-2 pr-4">{t("annotationMarkers.title")}</th>
              <th className="py-2 pr-4">{t("annotationMarkers.preview")}</th>
              <th className="py-2 pr-4">{t("annotationMarkers.color")}</th>
              <th className="py-2 pr-4">{t("annotationMarkers.smallFont")}</th>
              <th className="py-2 pr-4">{t("annotationMarkers.smallFontScale")}</th>
              <th className="py-2 pr-4">{t("annotationMarkers.linkType")}</th>
              <th className="py-2 pr-4">{t("annotationMarkers.multi")}</th>
              <th className="annotation-markers__actions py-2">{t("annotationMarkers.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {markers.map((marker) => {
              const draft = editing === marker.code ? editDraft : draftOf(marker);
              return (
                <tr key={marker.code} className="border-b align-middle">
                  <td className="py-2 pr-4"><code>{marker.code}</code></td>
                  <td className="py-2 pr-4">
                    {editing === marker.code ? (
                      <Input
                        value={editTitle}
                        onChange={(event) => setEditTitle(event.target.value)}
                      />
                    ) : (
                      marker.title
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <MarkerPreview draft={draft} />
                  </td>
                  {editing === marker.code ? (
                    // 每个字段一个单元格，各自对其表头：合在一个 colSpan 里时，
                    // 控件会偏离各自列（比例输入出现在「缩小」列下那种错位）。
                    <>
                      <td className="py-2 pr-4">
                        <ColorField draft={editDraft} onChange={setEditDraft} t={t} />
                      </td>
                      <td className="py-2 pr-4">
                        <SmallFontField draft={editDraft} onChange={setEditDraft} t={t} />
                      </td>
                      <td className="py-2 pr-4">
                        <SmallFontScaleField draft={editDraft} onChange={setEditDraft} t={t} />
                      </td>
                      <td className="py-2 pr-4">
                        <LinkTypeField draft={editDraft} onChange={setEditDraft} t={t} />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-2 pr-4">
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="inline-block h-5 w-5 shrink-0 rounded border"
                            style={{background: marker.color}}
                          />
                          <span className="font-mono text-xs">{marker.color}</span>
                        </span>
                      </td>
                      <td className="py-2 pr-4">{marker.smallFont ? "✓" : "—"}</td>
                      <td className="py-2 pr-4">{marker.smallFont ? `${marker.smallFontScale}×` : "—"}</td>
                      <td className="py-2 pr-4">{linkTypeLabel(marker.linkType)}</td>
                    </>
                  )}
                  <td className="py-2 pr-4">
                    {editing === marker.code ? (
                      <label className="annotation-markers__multi">
                        <input
                          checked={editMulti}
                          onChange={(event) => setEditMulti(event.target.checked)}
                          type="checkbox"
                        />
                        {t("annotationMarkers.multi")}
                      </label>
                    ) : marker.multi ? (
                      <span className="annotation-markers__badge">{t("annotationMarkers.multi")}</span>
                    ) : (
                      ""
                    )}
                  </td>
                  <td className="annotation-markers__actions py-2">
                    {editing === marker.code ? (
                      <>
                        <Button disabled={busy} onClick={() => saveEdit(marker.code)} size="sm">
                          {t("annotationMarkers.save")}
                        </Button>
                        <Button
                          onClick={() => setEditing(null)}
                          size="sm"
                          variant="ghost"
                        >
                          {t("annotationMarkers.cancel")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button onClick={() => startEdit(marker)} size="sm" variant="ghost">
                          {t("annotationMarkers.edit")}
                        </Button>
                        <Button
                          className={cn("annotation-markers__danger")}
                          onClick={() => remove(marker)}
                          size="sm"
                          variant="ghost"
                        >
                          {t("annotationMarkers.delete")}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {markers.length === 0 && (
              <tr>
                <td colSpan={9} className="annotation-markers__empty">
                  {t("annotationMarkers.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating ? (
        <div className="annotation-markers__form mt-4 flex flex-wrap items-center gap-3">
          <Input
            className="w-24"
            placeholder={t("annotationMarkers.codePlaceholder")}
            value={newCode}
            onChange={(event) => setNewCode(event.target.value)}
          />
          <Input
            className="w-48"
            placeholder={t("annotationMarkers.titlePlaceholder")}
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            {t("annotationMarkers.preview")}：
            <MarkerPreview draft={newDraft} />
          </span>
          <StyleFields draft={newDraft} onChange={setNewDraft} t={t} />
          <label className="annotation-markers__multi">
            <input
              checked={newMulti}
              onChange={(event) => setNewMulti(event.target.checked)}
              type="checkbox"
            />
            {t("annotationMarkers.multi")}
          </label>
          <Button disabled={busy} onClick={create} size="sm">
            {t("annotationMarkers.add")}
          </Button>
          <Button onClick={() => setCreating(false)} size="sm" variant="ghost">
            {t("annotationMarkers.cancel")}
          </Button>
        </div>
      ) : (
        <Button className="mt-4" onClick={() => setCreating(true)} size="sm">
          {t("annotationMarkers.new")}
        </Button>
      )}
    </div>
  );
}
