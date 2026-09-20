import React from "react";
import i18n from "@/client/i18n";
import 'quill/dist/quill.snow.css';
import {formatHtmlForEditing} from "@/client/HtmlUtils";
import {stripTransientRichEditorAttributes} from "@/client/RichEditorMedia";
import AdminRadioGroup from "../AdminRadioGroup";
import AdminHtmlEditor from "../AdminHtmlEditor";
import AdminMarkdownEditor from "../AdminMarkdownEditor";
import RichEditorQuill from "./component/RichEditorQuill";
import {renderMarkdown} from "@/client/markdown";

export default class AdminRichEditor extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
    this.state = {
      mode: 'rich',
      htmlSource: formatHtmlForEditing(
        stripTransientRichEditorAttributes(props.value || ""),
      ),

      isOpenImage: false,
    };
    this.onHtmlChange = this.onHtmlChange.bind(this);
    this.onRichChange = this.onRichChange.bind(this);
    this.onMarkdownChange = this.onMarkdownChange.bind(this);
  }

  onHtmlChange(value: string) {
    this.setState({htmlSource: value});
    this.props.onChange(value);
  }

  onRichChange(value: string) {
    this.setState({htmlSource: formatHtmlForEditing(value)});
    // The stored Markdown no longer matches the body: drop it rather than let it
    // silently overwrite these edits the next time the tab is opened.
    if (this.props.onMarkdownChange) this.props.onMarkdownChange("");
    this.props.onChange(value);
  }

  onMarkdownChange(source: string) {
    // Same contract as the other two modes: hand the parent the HTML body. The
    // source travels separately so it survives the round trip.
    this.props.onChange(renderMarkdown(source));
    if (this.props.onMarkdownChange) this.props.onMarkdownChange(source);
  }

  render() {
    const {htmlSource, mode} = this.state;
    const {label, value, extra, labelComponent, markdownSource} = this.props;
    const editorValue = stripTransientRichEditorAttributes(value || "");
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
            bodyHtml={String(value || "")}
            onChange={this.onMarkdownChange}
            value={markdownSource || ""}
          />}
      </div>
    );
  }
}
