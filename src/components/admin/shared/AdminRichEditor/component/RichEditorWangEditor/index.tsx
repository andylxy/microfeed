import {useEffect, useRef, useState} from "react";
import {i18nChangeLanguage} from "@wangeditor/editor";
import type {
  IDomEditor,
  IEditorConfig,
  IToolbarConfig,
} from "@wangeditor/editor";
import {Editor, Toolbar} from "@wangeditor/editor-for-react";
import "@wangeditor/editor/dist/css/style.css";
import i18n from "@/client/i18n";
import {uploadRichEditorMedia} from "@/client/RichEditorMedia";
import {ADMIN_URLS} from "@/shared/StringUtils";
// Side-effect import registers the seed `$X{...}` annotation buttons; the live
// DB list is fetched on mount (see below) and registers any extra markers.
import {
  DEFAULT_MARKER_CONFIGS,
  markerMenuKey,
  registerMarkerMenus,
  type MarkerConfig,
} from "./registerMarkerMenus";

const EDITOR_HEIGHT_PX = 500;

interface RichEditorWangEditorProps {
  value: string;
  onChange: (html: string) => void;
  extra?: {
    publicBucketUrl?: string;
    folderName?: string;
    mediaStorageReady?: boolean;
  };
  /**
   * Pre-seeded marker list — skips the live fetch and mounts the editor
   * immediately. Unit tests use it (SSR rendering never runs effects);
   * production leaves it undefined so the live D1 list is fetched.
   */
  initialMarkers?: MarkerConfig[];
}

/**
 * A wangEditor body editor.
 *
 * The HTML it hands back is whatever wangEditor produced — it is not
 * reformatted, not run through the Quill-specific cleanup, and not
 * sanitised, which is exactly how the visual editor's HTML is treated.
 *
 * The Toolbar/Editor pair is mounted **exactly once**, after the marker list
 * settles. wangEditor-for-react's `<Toolbar>` recreates its toolbar on every
 * `editor` prop change *without destroying the previous one*, and `<Editor>`
 * would build a second editor instance — remounting on a key (e.g. when the
 * fetched marker list extends the seed defaults) leaves one toolbar bound to
 * an orphaned editor and crashes on the first click. So the fetch resolves
 * first, then a single mount receives the final button list.
 */
export default function RichEditorWangEditor(
  {value, onChange, extra, initialMarkers}: RichEditorWangEditorProps,
) {
  const [editor, setEditor] = useState<IDomEditor | null>(null);
  const editorRef = useRef<IDomEditor | null>(null);
  // `null` = the live marker list has not settled yet — render a placeholder
  // instead of the editor so the Toolbar/Editor pair mounts exactly once.
  const [markerList, setMarkerList] = useState<MarkerConfig[] | null>(
    initialMarkers ?? null,
  );

  // Follow the admin UI rather than being pinned to Chinese: an English admin
  // must not be handed a Chinese toolbar. This runs on mount, which is before
  // the toolbar is built — it waits for the editor instance to exist.
  useEffect(() => {
    i18nChangeLanguage(i18n.language === "zh-CN" ? "zh-CN" : "en");
  }, []);

  useEffect(() => () => {
    editorRef.current?.destroy();
    editorRef.current = null;
  }, []);

  // Pull the live marker list, then reveal the editor. Registration must
  // happen before the (single) mount so the toolbar can reference the menu
  // keys; already-registered seed keys are skipped inside registerMarkerMenus
  // (wangEditor throws on duplicate registration). If the fetch fails we fall
  // back to the seed defaults — the editor stays usable, with a console trace.
  useEffect(() => {
    if (initialMarkers != null) return; // seeded by the caller: no live fetch.
    let cancelled = false;
    (async () => {
      let list = DEFAULT_MARKER_CONFIGS;
      try {
        const response = await fetch(ADMIN_URLS.ajaxAnnotationMarkersList(), {
          headers: {"content-type": "application/json"},
        });
        if (!response.ok) {
          console.warn(
            `[wangEditor] marker list fetch failed: HTTP ${response.status}`,
          );
        } else {
          const data = (await response.json()) as {markers?: MarkerConfig[]};
          if (Array.isArray(data.markers) && data.markers.length > 0) {
            list = data.markers;
          }
        }
      } catch (error) {
        console.warn("[wangEditor] marker list fetch threw", error);
      }
      if (cancelled) return;
      registerMarkerMenus(list);
      setMarkerList(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [initialMarkers]);

  // A caller-provided list must be registered before the first render too.
  if (initialMarkers != null) {
    registerMarkerMenus(initialMarkers);
  }

  if (markerList == null) {
    // Same footprint as the editor so the page does not jump when it appears.
    return (
      <div
        className="rich-editor-wang rich-editor-wang--loading"
        style={{height: `${EDITOR_HEIGHT_PX}px`}}
        aria-busy="true"
      />
    );
  }

  const toolbarConfig: Partial<IToolbarConfig> = {
    // 把标注按钮（`$f`/`$a`/`$u`/`$x`/…）插到工具栏最前面。
    insertKeys: {
      index: 0,
      keys: markerList.map((marker) => markerMenuKey(marker.code)),
    },
  };
  const editorConfig: Partial<IEditorConfig> = {
    MENU_CONF: {
      uploadImage: {
        customUpload: (file: File, insertFn: (url: string) => void) => {
          uploadRichEditorMedia(file, "image", extra, insertFn);
        },
      },
      uploadVideo: {
        customUpload: (file: File, insertFn: (url: string) => void) => {
          uploadRichEditorMedia(file, "video", extra, insertFn);
        },
      },
    },
  };

  return (
    <div className="rich-editor-wang">
      <Toolbar
        editor={editor}
        defaultConfig={toolbarConfig}
        mode="default"
        style={{borderBottom: "1px solid #ccc"}}
      />
      <Editor
        // Uncontrolled initial content: wangEditor-for-react's <Editor> re-syncs
        // a *controlled* `value` to the editor on every parent re-render via an
        // internal `setHtml(value)`. With a Quill/Markdown body that lag is
        // enough to overwrite the author's last keystroke, so the edited text
        // was lost on save. `defaultHtml` loads the body once and lets the
        // editor own its content; output is read only through `onChange`.
        defaultHtml={value}
        defaultConfig={editorConfig}
        onCreated={(instance: IDomEditor) => {
          editorRef.current = instance;
          setEditor(instance);
        }}
        onChange={(instance: IDomEditor) => {
          onChange(instance.getHtml());
        }}
        mode="default"
        style={{height: `${EDITOR_HEIGHT_PX}px`, overflowY: "hidden"}}
      />
    </div>
  );
}
