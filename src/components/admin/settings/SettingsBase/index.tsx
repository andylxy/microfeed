import React from 'react';
import {Button} from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import i18n from "@/client/i18n";

export default class SettingsBase extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {children, currentType, description, onSubmit, submitForType, submitting, title, titleComponent} = this.props;
    const submittingForThis = submitForType === currentType;
    return (<form className="h-full"><Card className="h-full gap-0 py-0">
      <CardHeader className="gap-3 border-b p-5">
        <CardTitle className="min-w-0 text-lg">
          {title}
          {titleComponent}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {onSubmit && <CardAction>
          <Button
            disabled={submittingForThis || submitting}
            onClick={onSubmit}
          >{submittingForThis ? t("settings.updating") : t("settings.update")}</Button>
        </CardAction>}
      </CardHeader>
      <CardContent className="p-5">
        {children}
      </CardContent>
    </Card></form>);
  }
}
