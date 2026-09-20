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

export default class AdminRichEditor extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
    const format = bodyFormat(props.bodyFormat);
    this.state = {
      // Open in the mode the body was written in: a Markdown chapter must not
      // open in a HTML box full of Markdown.
      mode: format === BODY_FORMAT_MARKDOWN ? 'markdown' : 'rich',
      htmlSource: formatHtmlForEditing(
        stripTransientRichEditorAttributes(
          bodyToHtml(props.value, format) || "",
        ),
      ),

      isOpenImage: false,
    };
    this.onHtmlChange = this.onHtmlChange.bind(this);
    this.onRichChange = this.onRichChange.bind(this);
    this.onMarkdownChange = this.onMarkdownChange.bind(this);
  }

  onHtmlChange(value: string) {
    this.setState({htmlSource: value});
    this.setFormat(BODY_FORMAT_HTML);
    this.props.onChange(value);
  }

  onRichChange(value: string) {
    this.setState({htmlSource: formatHtmlForEditing(value)});
    this.setFormat(BODY_FORMAT_HTML);
    this.props.onChange(value);
  }

  /**
   * Store the Markdown verbatim. Rendering happens when the page is displayed,
   * never here — converting on save is what used to degrade the source every
   * time the body was edited.
   */
  onMarkdownChange(source: string) {
    this.setFormat(BODY_FORMAT_MARKDOWN);
    this.props.onChange(source);
  }

  setFormat(format: string) {
    if (this.props.onFormatChange) this.props.onFormatChange(format);
  }

  render() {
    const {htmlSource, mode} = this.state;
    const {label, value, extra, labelComponent} = this.props;
    const format = bodyFormat(this.props.bodyFormat);
    // `value` is the body exactly as stored, so it is Markdown when the chapter
    // was written in Markdown. The visual and HTML editors need HTML; Markdown
    // is handed over verbatim.
    const bodyHtml = bodyToHtml(value, format);
    const editorValue = stripTransientRichEditorAttributes(bodyHtml);
    const markdownValue = format === BODY_FORMAT_MARKDOWN ? String(value || "") : "";
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
              {value: 'markdown', label: i18n.t("shared.markdownEditor")},
            ]}
            onValueChange={(value) => this.setState({mode: value})}
          />
        </div>
        {mode === 'rich' ? <RichEditorQuill
          value={editorValue}
          onChange={this.onRichChange}
          extra={extra}
        /> : mode === 'html'
          ? <AdminHtmlEditor value={htmlSource} onChange={this.onHtmlChange} />
          : <AdminMarkdownEditor
            bodyHtml={bodyHtml}
            onChange={this.onMarkdownChange}
            value={markdownValue}
          />}
      </div>
    );
  }
}
