import {useEffect, useState} from "react";
import {LanguagesIcon} from "lucide-react";
import {useTranslation} from "@/client/i18n";

import {Button} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ADMIN_LANGUAGES,
  ADMIN_LANGUAGE_TAGS,
  type AdminLanguage,
  parseAdminLanguage,
} from "@/shared/AdminLanguage";
import {
  ADMIN_LANGUAGE_CHANGE_EVENT,
  currentAdminLanguage,
  setAdminLanguage,
} from "@/client/admin-language";

export default function AdminLanguageMenu() {
  const {t} = useTranslation();
  const [language, setLanguageState] = useState<AdminLanguage>("en");

  useEffect(() => {
    const update = () => setLanguageState(currentAdminLanguage());
    update();
    window.addEventListener(ADMIN_LANGUAGE_CHANGE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(ADMIN_LANGUAGE_CHANGE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("languageMenu.switchLanguage")}
            className="rounded-full"
            size="icon"
            variant="ghost"
          />
        }
      >
        <LanguagesIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t("languageMenu.language")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={language}
          onValueChange={(value) => {
            const nextLanguage = parseAdminLanguage(value);
            setLanguageState(nextLanguage);
            setAdminLanguage(nextLanguage);
            window.location.reload();
          }}
        >
          {ADMIN_LANGUAGES.map((code) => (
            <DropdownMenuRadioItem key={code} value={code}>
              {ADMIN_LANGUAGE_TAGS[code]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
