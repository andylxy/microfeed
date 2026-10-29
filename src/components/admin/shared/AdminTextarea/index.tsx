import clsx from "clsx";
import {Textarea} from "@/components/ui/textarea";

export default function AdminTextarea({ label, value, onChange, minRows = 3, maxRows = 10,
                                        customCss = '', placeholder='', disabled = false }: any) {
  return (<label className="">
    <div className="mb-2 text-sm font-semibold text-foreground">{label}</div>
    <div className="w-full">
      <Textarea
        className={clsx("field-sizing-content w-full resize-y", customCss, disabled && "bg-muted")}
        value={value || ''}
        onChange={onChange}
        placeholder={placeholder}
        rows={minRows}
        disabled={disabled}
        style={{maxHeight: `${maxRows * 1.625 + 1}rem`}}
      />
    </div>
  </label>);
}
