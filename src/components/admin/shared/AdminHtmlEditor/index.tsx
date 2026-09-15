import type {ChangeEvent} from "react";

import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import {useTranslation} from "@/client/i18n";

interface Props {
  onChange: (value: string) => void;
  value?: string;
}

export default function AdminHtmlEditor({onChange, value = ""}: Props) {
  const {t} = useTranslation();
  const onCodeChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
  };

  return (
    <AdminCodeEditor
      ariaLabel={t("shared.htmlSourceAria")}
      code={value}
      fontSize={14.4}
      language="html"
      maxHeight="32rem"
      minHeight="16rem"
      onChange={onCodeChange}
      placeholder={t("shared.htmlSourcePlaceholder")}
    />
  );
}
