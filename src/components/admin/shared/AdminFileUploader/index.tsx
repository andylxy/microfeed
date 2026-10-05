import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useId,
  useRef,
} from "react";

interface AdminFileUploaderProps {
  children: ReactNode;
  classes?: string;
  disabled?: boolean;
  handleChange: (file: File) => void;
  name: string;
  onDisabledClick?: () => void;
  /**
   * 文件被拒（扩展名不在 `types` 里）时回调。
   *
   * 不传时保持既有行为：**静默忽略**。调用方传入即可给出提示 —— 否则用户拖错文件
   * 时既不上传也没反馈，看起来像拖拽坏了。
   */
  onRejected?: (file: File) => void;
  types?: string[];
}

function acceptsFile(file: File, types: string[]): boolean {
  if (types.length === 0) {
    return true;
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  return Boolean(
    extension &&
    types.some((type) => type.replace(/^\./u, "").toLowerCase() === extension),
  );
}

export default function AdminFileUploader({
  children,
  classes = "",
  disabled = false,
  handleChange,
  name,
  onDisabledClick,
  onRejected,
  types = [],
}: AdminFileUploaderProps) {
  const generatedId = useId().replaceAll(":", "");
  const inputId = `${name}-${generatedId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = types
    .map((type) => `.${type.replace(/^\./u, "").toLowerCase()}`)
    .join(",");

  const selectFile = (file: File | undefined) => {
    if (disabled || !file) {
      return;
    }
    if (acceptsFile(file, types)) {
      handleChange(file);
      return;
    }
    // 类型不符：不静默丢弃，交给调用方决定要不要提示。
    onRejected?.(file);
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    selectFile(event.currentTarget.files?.[0]);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (disabled) {
      onDisabledClick?.();
      return;
    }
    selectFile(event.dataTransfer.files?.[0]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (disabled) {
        onDisabledClick?.();
      } else {
        inputRef.current?.click();
      }
    }
  };

  const onClick = (event: MouseEvent<HTMLLabelElement>) => {
    if (disabled) {
      event.preventDefault();
      onDisabledClick?.();
    }
  };

  return (
    <label
      aria-disabled={disabled}
      className={`${classes}${disabled ? " is-disabled" : ""}`}
      htmlFor={inputId}
      onClick={onClick}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={disabled && !onDisabledClick ? -1 : 0}
    >
      <input
        accept={accept || undefined}
        disabled={disabled}
        id={inputId}
        name={name}
        onChange={onInputChange}
        onClick={(event) => {
          event.currentTarget.value = "";
        }}
        ref={inputRef}
        type="file"
      />
      {children}
    </label>
  );
}
