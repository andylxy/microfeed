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

const EDITOR_HEIGHT_PX = 500;

interface RichEditorWangEditorProps {
  value: string;
  onChange: (html: string) => void;
  extra?: {
    publicBucketUrl?: string;
    folderName?: string;
    mediaStorageReady?: boolean;
  };
}

/**
 * A wangEditor body editor.
 *
 * The HTML it hands back is whatever wangEditor produced — it is not
 * reformatted, not run through the Quill-specific cleanup, and not
 * sanitised, which is exactly how the visual editor's HTML is treated.
 */
export default function RichEditorWangEditor(
  {value, onChange, extra}: RichEditorWangEditorProps,
) {
  const [editor, setEditor] = useState<IDomEditor | null>(null);
  const editorRef = useRef<IDomEditor | null>(null);

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

  const toolbarConfig: Partial<IToolbarConfig> = {};
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
