import React from "react";
import i18n from "@/client/i18n";
import 'quill/dist/quill.snow.css';
import {formatHtmlForEditing} from "@/client/HtmlUtils";
import {stripTransientRichEditorAttributes} from "@/client/RichEditorMedia";
import AdminRadioGroup from "../AdminRadioGroup";
import AdminHtmlEditor from "../AdminHtmlEditor";
import AdminMarkdownEditor from "../AdminMarkdownEditor";
import RichEditorQuill from "./component/RichEditorQuill";
import RichEditorWangEditor from "./component/RichEditorWangEditor";
import {
  BODY_FORMAT_HTML,
  BODY_FORMAT_MARKDOWN,
  bodyFormat,
  bodyToHtml,
} from "@/shared/BodyFormat";
import {htmlToMarkdown} from "@/shared/HtmlToMarkdown";

/**
 * The body as the visual and HTML-source editors need it.
 *
 * A Markdown chapter has to be rendered first. An HTML chapter — which is every
 * chapter that has ever existed here — is handed over as `value || ""`,
 * character for character what these two editors were always given, so nothing
 * about them changes.
 */
function editorBody(value: any, format: string): string {
  return format === BODY_FORMAT_MARKDOWN
    ? bodyToHtml(value, format)
    : (value || "");
}

/** The body as the HTML source box holds it. */
function htmlSourceFor(value: any, format: string): string {
  return formatHtmlForEditing(
    stripTransientRichEditorAttributes(editorBody(value, format) || ""),
  );
}

/**
 * The body as the HTML source box of a wangEditor chapter holds it.
 *
 * `stripTransientRichEditorAttributes` removes the classes and attributes
 * Quill itself writes. A chapter owned by wangEditor never went through Quill,
 * so pointing that cleanup at it would be using the wrong tool — the body is
 * handed over exactly as it is stored.
 */
function htmlSourceForWang(value: any): string {
  return formatHtmlForEditing(value || "");
}

/**
 * The engine a body belongs to. Everything written before wangEditor existed
 * is Quill's; `wang` is a chapter that has been handed over for good.
 */
const BODY_EDITOR_WANG = 'wang';

function isOwnedByWang(bodyEditor: any): boolean {
  return bodyEditor === BODY_EDITOR_WANG;
}

export default class AdminRichEditor extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
    const format = bodyFormat(props.bodyFormat);
    const isWangOwned = isOwnedByWang(props.bodyEditor);
    this.state = {
      // A Markdown chapter opens in the Markdown editor: the visual editor would
      // show it as source, not as the text it represents. Everything else opens
      // in the visual editor, as it always has.
      //
      // A chapter already owned by wangEditor opens in wangEditor: it is the
      // only editor that is allowed to touch it.
      mode: isWangOwned
        ? 'wangeditor'
        : (format === BODY_FORMAT_MARKDOWN ? 'markdown' : 'rich'),
      htmlSource: isWangOwned
        ? htmlSourceForWang(props.value)
        : htmlSourceFor(props.value, format),
      // Whether this body belongs to wangEditor. Recorded the moment the mode
      // is picked rather than when the caller writes it back: until it is set,
      // the modes that must not touch this body are still on screen.
      wangOwned: isWangOwned,

      isOpenImage: false,
    };
    this.onHtmlChange = this.onHtmlChange.bind(this);
    this.onRichChange = this.onRichChange.bind(this);
    this.onWangChange = this.onWangChange.bind(this);
    this.onMarkdownChange = this.onMarkdownChange.bind(this);
    this.onModeChange = this.onModeChange.bind(this);
  }

  /**
   * Both HTML editors store HTML, so a chapter stops being Markdown the moment
   * it is edited through them. Only a Markdown chapter needs that written down:
   * an HTML chapter is the default and is saved without the field, exactly like
   * every chapter written before Markdown was supported.
   */
  markBodyAsHtml() {
    if (
      bodyFormat(this.props.bodyFormat) === BODY_FORMAT_MARKDOWN &&
      this.props.onFormatChange
    ) {
      this.props.onFormatChange(BODY_FORMAT_HTML);
    }
  }

  onHtmlChange(value: string) {
    this.setState({htmlSource: value});
    this.markBodyAsHtml();
    this.props.onChange(value);
  }

  onRichChange(value: string) {
    this.setState({htmlSource: formatHtmlForEditing(value)});
    this.markBodyAsHtml();
    this.props.onChange(value);
  }

  /**
   * Whether this body belongs to wangEditor.
   *
   * The local flag is what makes the handover immediate. The caller records the
   * owner through `onBodyEditorChange`, but the modes that must never touch
   * this body have to disappear on the same click, not one round trip later.
   */
  isWangOwned(): boolean {
    return this.state.wangOwned === true || isOwnedByWang(this.props.bodyEditor);
  }

  /**
   * wangEditor stores HTML of its own making. It is handed over as it comes
   * out of the editor — no reformatting, no Quill cleanup. The owner was
   * already recorded when the mode was picked; re-recording it on every
   * keystroke would only hide a caller that forgot to record it at all.
   */
  onWangChange(value: string) {
    this.props.onChange(value);
  }

  /**
   * Store the Markdown verbatim. Rendering happens when the page is displayed,
   * never here — converting on save is what used to degrade the source every
   * time the body was edited.
   */
  onMarkdownChange(source: string) {
    if (this.props.onFormatChange) {
      this.props.onFormatChange(BODY_FORMAT_MARKDOWN);
    }
    this.props.onChange(source);
  }

  onModeChange(mode: string) {
    const isMarkdownBody = bodyFormat(this.props.bodyFormat) === BODY_FORMAT_MARKDOWN;
    // Picking Markdown on a body that is still HTML hands the chapter over: the
    // body is rewritten as Markdown source on the spot. No confirmation — it is
    // just another mode to pick, and the conversion is where the chapter's own
    // text is kept (checked against every chapter in the database). What cannot
    // survive is styling Markdown has no syntax for: colour, background,
    // alignment, indent.
    if (
      mode === 'markdown'
      && !isMarkdownBody
      && typeof this.props.onFormatChange === "function"
    ) {
      const source = htmlToMarkdown(
        editorBody(this.props.value, bodyFormat(this.props.bodyFormat)),
      );
      this.props.onFormatChange(BODY_FORMAT_MARKDOWN);
      this.props.onChange(source);
    }
    // Picking wangEditor takes the chapter for good. A Markdown body is
    // rendered to HTML first, because wangEditor edits HTML and would show
    // Markdown as literal markup. From here the chapter belongs to wangEditor
    // and the visual and Markdown modes stop being offered for it.
    if (mode === 'wangeditor') {
      // Both callbacks are what make the handover stick, so a caller that
      // offers the mode without them is broken and has to hear about it here.
      // Falling back instead would move the body to wangEditor while leaving
      // the owner unrecorded: the next page load would hand the body back to
      // Quill, which is exactly what this mode exists to prevent.
      if (typeof this.props.onBodyEditorChange !== "function") {
        throw new Error(
          "AdminRichEditor: wangEditor mode needs onBodyEditorChange to record which editor owns the body",
        );
      }
      if (isMarkdownBody && typeof this.props.onFormatChange !== "function") {
        throw new Error(
          "AdminRichEditor: a Markdown body needs onFormatChange to become HTML before wangEditor can edit it",
        );
      }
      if (isMarkdownBody) {
        this.props.onChange(bodyToHtml(this.props.value, BODY_FORMAT_MARKDOWN));
        this.props.onFormatChange(BODY_FORMAT_HTML);
      }
      this.props.onBodyEditorChange(BODY_EDITOR_WANG);
      this.setState({mode: 'wangeditor', wangOwned: true});
      return;
    }
    const isWangOwned = this.isWangOwned();
    // The HTML source box is driven by `htmlSource`, which is captured at mount.
    // Converting a chapter rewrites the body without touching it, so re-read on
    // entry: showing the pre-conversion HTML would let the next keystroke save
    // it back and lose every Markdown edit.
    this.setState((state: any) => ({
      htmlSource: mode === 'html'
        ? (isWangOwned
          ? htmlSourceForWang(this.props.value)
          : htmlSourceFor(this.props.value, bodyFormat(this.props.bodyFormat)))
        : state.htmlSource,
      mode,
    }));
  }

  render() {
    const {htmlSource, mode} = this.state;
    const {label, value, extra, labelComponent} = this.props;
    const format = bodyFormat(this.props.bodyFormat);
    const isMarkdown = format === BODY_FORMAT_MARKDOWN;
    const canRecordFormat = typeof this.props.onFormatChange === "function";
    const isWangOwned = this.isWangOwned();
    const bodyHtml = editorBody(value, format);
    // A chapter owned by wangEditor is kept out of Quill's cleanup, which only
    // knows about the markup Quill itself writes.
    const editorValue = isWangOwned
      ? (value || "")
      : stripTransientRichEditorAttributes(bodyHtml);
    const markdownValue = isMarkdown ? String(value || "") : "";
    return (
      <div className="admin-rich-editor">
        {label && <div className="mb-2 font-semibold text-foreground">
          {label}
        </div>}
        {labelComponent}
        <div className="mb-4 max-h-20">
          <AdminRadioGroup
            ariaLabel={i18n.t("shared.editorMode")}
            className="text-sm text-helper-color"
            name="richOrHtml"
            value={mode}
            options={
              isWangOwned
                // Once wangEditor owns the chapter, those are the only two modes
                // left: wangEditor itself, and the HTML it produced.
                ? [
                  {value: 'wangeditor', label: i18n.t("shared.wangEditor")},
                  {value: 'html', label: i18n.t("shared.htmlSource")},
                ]
                : [
                  {value: 'rich', label: i18n.t("shared.visualEditor")},
                  {value: 'html', label: i18n.t("shared.htmlSource")},
                  // A third mode alongside the other two, picked the same way. Not
                  // offered when the caller cannot record the format (channel and
                  // page descriptions have no `content_format`): storing Markdown
                  // without it would make the reader render `##` as literal text.
                  ...(canRecordFormat
                    ? [{value: 'markdown', label: i18n.t("shared.markdownEditor")}]
                    : []),
                  // wangEditor is opt-in per caller: only the item editor turns
                  // it on, so every other editor keeps the list it always had.
                  ...(this.props.enableWangEditor
                    ? [{value: 'wangeditor', label: i18n.t("shared.wangEditor")}]
                    : []),
                ]
            }
            onValueChange={this.onModeChange}
          />
        </div>
        {/*
          Saving from either HTML mode makes a Markdown chapter HTML for good:
          the body becomes the rendered HTML and the source is overwritten. A
          legitimate choice, but it has to be a conscious one — warn before it
          happens, not after.
        */}
        {isMarkdown && mode !== 'markdown' && (
          <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {i18n.t("shared.markdownToHtmlWarning")}
          </p>
        )}
        {mode === 'rich' ? <RichEditorQuill
          value={editorValue}
          onChange={this.onRichChange}
          extra={extra}
        /> : mode === 'wangeditor'
          ? <RichEditorWangEditor
            value={editorValue}
            onChange={this.onWangChange}
            extra={extra}
          />
          : mode === 'html'
            ? <AdminHtmlEditor value={htmlSource} onChange={this.onHtmlChange} />
            : <AdminMarkdownEditor
              onChange={this.onMarkdownChange}
              value={markdownValue}
            />}
      </div>
    );
  }
}
