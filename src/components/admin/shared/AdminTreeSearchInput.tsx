import type {ChangeEvent} from "react";

import {XIcon} from "lucide-react";

import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";

interface AdminTreeSearchInputProps {
  /** 输入框的无障碍名；左栏首元素带 `aria-label` 时同时命名 `<nav>` 地标。 */
  ariaLabel: string;
  /** 值变化回调，字符串口径——清空按钮直接回传空串。 */
  onValueChange: (value: string) => void;
  placeholder: string;
  value: string;
}

/**
 * 分组树左栏的搜索输入框，在输入框最右叠加一个清空按钮（仅在有值时出现）。
 *
 * 完全受控：值与回调都由调用方持有，本组件不认识「搜索」「分组」「树」任何业务
 * 概念，也不参与过滤——过滤与展开规则仍留在页面（见 `docs/zh/admin-group-tree.md`）。
 * 清空按钮的视觉沿用 `AdminSelect` 的 `ComboboxClear`：幽灵图标按钮、hover 转
 * destructive、只在有内容时渲染。
 */
export function AdminTreeSearchInput({
  ariaLabel,
  onValueChange,
  placeholder,
  value,
}: AdminTreeSearchInputProps) {
  const {t} = useTranslation();
  return (
    <div className="relative">
      <Input
        aria-label={ariaLabel}
        className="w-full pr-9"
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onValueChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      {value.length > 0 && (
        <Button
          aria-label={t("common.clearSearch")}
          className="absolute top-1/2 right-1 size-7 -translate-y-1/2 p-0 hover:text-destructive"
          onClick={() => onValueChange("")}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      )}
    </div>
  );
}
