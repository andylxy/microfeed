import {useState} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {cn} from "@/lib/utils";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {AnnotationMarker} from "@/server/admin/annotation-marker-handlers";

interface Props {
  initialMarkers: AnnotationMarker[];
}

/** Pull the already-localized error message out of a failed admin ajax response. */
async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as {error?: string};
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Admin screen for the annotation markers. The markers are the toolbar buttons
 * the wangEditor body editor turns into `$<code>{...}` wrappers. Adding,
 * renaming or removing a marker here takes effect on the next editor load with
 * no redeploy.
 */
export default function AnnotationMarkersApp({initialMarkers}: Props) {
  const {t} = useTranslation();
  const [markers, setMarkers] = useState<AnnotationMarker[]>(initialMarkers);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newMulti, setNewMulti] = useState(false);

  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editMulti, setEditMulti] = useState(false);

  const refresh = (next: AnnotationMarker[]) => setMarkers(next);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAnnotationMarkersCreate(), {
        body: JSON.stringify({code: newCode, title: newTitle, multi: newMulti}),
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
  };

  const saveEdit = async (code: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAnnotationMarkersUpdate(), {
        body: JSON.stringify({code, title: editTitle, multi: editMulti}),
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

  return (
    <div className="annotation-markers">
      <p className="annotation-markers__hint">{t("annotationMarkers.description")}</p>

      <table className="annotation-markers__table">
        <thead>
          <tr>
            <th>{t("annotationMarkers.code")}</th>
            <th>{t("annotationMarkers.title")}</th>
            <th>{t("annotationMarkers.multi")}</th>
            <th className="annotation-markers__actions">{t("annotationMarkers.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {markers.map((marker) => (
            <tr key={marker.code}>
              <td><code>{marker.code}</code></td>
              <td>
                {editing === marker.code ? (
                  <Input
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                  />
                ) : (
                  marker.title
                )}
              </td>
              <td>
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
              <td className="annotation-markers__actions">
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
          ))}
          {markers.length === 0 && (
            <tr>
              <td colSpan={4} className="annotation-markers__empty">
                {t("annotationMarkers.empty")}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {creating ? (
        <div className="annotation-markers__form">
          <Input
            placeholder={t("annotationMarkers.codePlaceholder")}
            value={newCode}
            onChange={(event) => setNewCode(event.target.value)}
          />
          <Input
            placeholder={t("annotationMarkers.titlePlaceholder")}
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
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
        <Button onClick={() => setCreating(true)} size="sm">
          {t("annotationMarkers.new")}
        </Button>
      )}
    </div>
  );
}
