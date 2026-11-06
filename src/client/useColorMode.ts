import {useEffect, useState} from "react";

/**
 * 后台 Markdown 预览的明暗来源：观察 `<html data-color-mode>`（`applyAdminTheme`
 * 写入的解析结果），用户切换主题、系统偏好变化都能跟上，预览与后台主题不错位。
 *
 * `enabled=false` 时不挂 MutationObserver——预览根本没渲染的场景（如只读开关
 * 全关）就不必常驻一个观察器。`enabled` 由 false 变 true 时会重新挂载并读取。
 */
export function useColorMode(enabled = true): "dark" | "light" | undefined {
  const [colorMode, setColorMode] = useState<"dark" | "light" | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!enabled) return;
    const read = () => setColorMode(
      document.documentElement.dataset.colorMode === "dark" ? "dark" : "light",
    );
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-mode"],
    });
    return () => observer.disconnect();
  }, [enabled]);
  return colorMode;
}
