export interface HeightSliderProps {
  min: number;
  max: number;
  value: number;
  /** Disabled (not hidden/unmounted) while flat, so the panel never reflows. */
  disabled: boolean;
}

/**
 * Pure prop derivation for the flat/extruded toggle's height slider.
 *
 * Codifies the "disabled not hidden" convention documented inline in
 * NetworkKpiPanel.tsx (around the `maxHeightM` SliderRow, "disabled rather
 * than hidden — hiding it would make the 2D/3D toggle reflow the card under
 * the pointer") and mirrored in EmissionsH3Panel.tsx: the slider stays
 * mounted at a fixed position, only its `disabled` state changes with
 * `extruded`.
 */
export function heightSliderProps(
  extruded: boolean,
  maxHeightM: number,
  min: number,
  max: number,
): HeightSliderProps {
  return { min, max, value: maxHeightM, disabled: !extruded };
}

export interface UseViewModeToggleArgs {
  extruded: boolean;
  maxHeightM: number;
  heightMin: number;
  heightMax: number;
  onExtrudedChange: (extruded: boolean) => void;
  onMaxHeightChange: (maxHeightM: number) => void;
}

export interface UseViewModeToggleResult {
  extruded: boolean;
  /** Select flat (2D) rendering. */
  setFlat: () => void;
  /** Select extruded (3D) rendering. */
  setExtruded: () => void;
  /** Props for the height ceiling slider — disabled while flat, never unmounted. */
  heightSlider: HeightSliderProps;
  /** Commit a new height ceiling value. */
  setMaxHeight: (value: number) => void;
}

/**
 * Flat/extruded view-mode toggle plus its height slider, shared by Network
 * KPI and Emissions H3 (and any future extruded-choropleth panel).
 */
export function useViewModeToggle(args: UseViewModeToggleArgs): UseViewModeToggleResult {
  const { extruded, maxHeightM, heightMin, heightMax, onExtrudedChange, onMaxHeightChange } = args;
  return {
    extruded,
    setFlat: () => onExtrudedChange(false),
    setExtruded: () => onExtrudedChange(true),
    heightSlider: heightSliderProps(extruded, maxHeightM, heightMin, heightMax),
    setMaxHeight: onMaxHeightChange,
  };
}
