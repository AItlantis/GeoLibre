import { useLayoutEffect } from "react";
import { useAppStore } from "@geolibre/core";
import { applyThemeScheme, isHexColor } from "../lib/theme-schemes";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * Keeps the document's accent tokens in sync with the active accent. Pairs with
 * `useThemeMode` (light/dark): mode toggles the `.dark` class, this hook sets the
 * accent on top of it. A project-provided `preferences.ui.accentColor` (already
 * validated by core) wins over the viewer's own scheme; when absent the viewer's
 * persisted scheme applies exactly as before.
 */
export function useThemeScheme(): void {
  const scheme = useDesktopSettingsStore((state) => state.desktopSettings.theme.scheme);
  const customColor = useDesktopSettingsStore((state) => state.desktopSettings.theme.customColor);
  const projectAccent = useAppStore((state) => state.preferences.ui?.accentColor);

  useLayoutEffect(() => {
    if (isHexColor(projectAccent)) {
      applyThemeScheme("custom", projectAccent);
    } else {
      applyThemeScheme(scheme, customColor);
    }
  }, [scheme, customColor, projectAccent]);
}
