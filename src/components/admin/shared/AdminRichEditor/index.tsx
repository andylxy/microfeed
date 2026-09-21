import React from "react";
import i18n from "@/client/i18n";
import 'quill/dist/quill.snow.css';
import {formatHtmlForEditing} from "@/client/HtmlUtils";
import {stripTransientRichEditorAttributes} from "@/client/RichEditorMedia";
import AdminRadioGroup from "../AdminRadioGroup";
import AdminHtmlEditor from "../AdminHtmlEditor";
import AdminMarkdownEditor from "../AdminMarkdownEditor";
import RichEditorQuill from "./component/RichEditorQuill";
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

export default class AdminRichEditor extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
    const format = bodyFormat(props.bodyFormat);
    this.state = {
      // A Markdown chapter opens in the Markdown editor: the visual editor would
      // show it as source, not as the text it represents. Everything else opens
      // in the visual editor, as it always has.
      mode: format === BODY_FORMAT_MARKDOWN ? 'markdown' : 'rich',
      htmlSource: htmlSourceFor(props.value, format),

      isOpenImage: false,
    };
    this.onHtmlChange = this.onHtmlChange.bind(this);
    this.onRichChange = this.onRichChange.bind(this);
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
    // The HTML source box is driven by `htmlSource`, which is captured at mount.
    // Converting a chapter rewrites the body without touching it, so re-read on
    // entry: showing the pre-conversion HTML would let the next keystroke save
    // it back and lose every Markdown edit.
    this.setState((state: any) => ({
      htmlSource: mode === 'html'
        ? htmlSourceFor(this.props.value, bodyFormat(this.props.bodyFormat))
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
    const bodyHtml = editorBody(value, format);
    const editorValue = stripTransientRichEditorAttributes(bodyHtml);
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
            options={[
              {value: 'rich', label: i18n.t("shared.visualEditor")},
              {value: 'html', label: i18n.t("shared.htmlSource")},
              // A third mode alongside the other two, picked the same way. Not
              // offered when the caller cannot record the format (channel and
              // page descriptions have no `content_format`): storing Markdown
              // without it would make the reader render `##` as literal text.
              ...(canRecordFormat
                ? [{value: 'markdown', label: i18n.t("shared.markdownEditor")}]
                : []),
            ]}
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
        /> : mode === 'html'
          ? <AdminHtmlEditor value={htmlSource} onChange={this.onHtmlChange} />
          : <AdminMarkdownEditor
            onChange={this.onMarkdownChange}
            value={markdownValue}
          />}
      </div>
    );
  }
}
