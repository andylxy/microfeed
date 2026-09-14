import {useEffect, useState} from "react";
import {
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";

import {
  ADMIN_THEME_CHANGE_EVENT,
  currentAdminTheme,
  setAdminTheme,
} from "@/client/admin-theme";
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
  type AdminTheme,
  parseAdminTheme,
} from "@/shared/AdminTheme";

const themeOptions: Array<{
  icon: typeof MonitorIcon;
  labelKey: string;
  value: AdminTheme;
}> = [
  {icon: MonitorIcon, labelKey: "themeMenu.system", value: "system"},
  {icon: SunIcon, labelKey: "themeMenu.light", value: "light"},
  {icon: MoonIcon, labelKey: "themeMenu.dark", value: "dark"},
];

export default function AdminThemeMenu() {
  const {t} = useTranslation();
  const [theme, setThemeState] = useState<AdminTheme>("light");

  useEffect(() => {
    const update = () => setThemeState(currentAdminTheme());
    update();
    window.addEventListener(ADMIN_THEME_CHANGE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(ADMIN_THEME_CHANGE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  const ActiveIcon = themeOptions.find((option) => option.value === theme)?.icon ?? SunIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("themeMenu.colorThemeLabel", {theme: t(themeOptions.find((option) => option.value === theme)?.labelKey ?? "themeMenu.light")})}
            className="rounded-full"
            size="icon"
            variant="ghost"
          />
        }
      >
        <ActiveIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t("themeMenu.colorTheme")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            const nextTheme = parseAdminTheme(value);
            setThemeState(nextTheme);
            setAdminTheme(nextTheme);
          }}
        >
          {themeOptions.map(({icon: Icon, labelKey, value}) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden="true" />
              {t(labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
