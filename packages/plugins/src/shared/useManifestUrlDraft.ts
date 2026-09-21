import { useEffect, useState } from "react";

export interface UseManifestUrlDraftResult {
  /** The input's current (possibly uncommitted) text. */
  urlDraft: string;
  /** Update the draft text directly, e.g. from an `onChange`. */
  setUrlDraft: (value: string) => void;
  /** Commit the draft by calling `onLoad` with its current value. */
  loadPackage: () => void;
  /** Commit on Enter, matching the panels' existing manifest-URL inputs. */
  handleKeyDown: (event: { key: string }) => void;
}

/**
 * Owns the draft-vs-committed split for a manifest URL text input.
 *
 * The plugin store's `manifestUrl` is the COMMITTED value (only updated once a
 * load starts); the input itself needs its own local draft state so the user
 * can type without every keystroke re-triggering a fetch. This hook also
 * resyncs the draft whenever `currentUrl` changes from OUTSIDE the input
 * (a project load, a local-folder load, or another panel/session clearing the
 * package) — this resync already existed inline in NetworkKpiPanel,
 * EmissionsH3Panel and VehiclePlaybackPanel, but was missing from
 * ScenarioComparisonPanel and PathAnalysisPanel (a confirmed latent bug: their
 * draft could go stale after an external change). Adopting this hook fixes
 * that for both panels as an intentional, noted behavior change.
 *
 * @param currentUrl - The committed manifest URL from the plugin store, or null
 * @param onLoad - Called with the draft's current value to commit it
 */
export function useManifestUrlDraft(
  currentUrl: string | null,
  onLoad: (url: string) => void | Promise<void>,
): UseManifestUrlDraftResult {
  const [urlDraft, setUrlDraft] = useState(currentUrl ?? "");

  useEffect(() => {
    setUrlDraft(currentUrl ?? "");
  }, [currentUrl]);

  const loadPackage = () => {
    void onLoad(urlDraft);
  };

  const handleKeyDown = (event: { key: string }) => {
    if (event.key === "Enter") loadPackage();
  };

  return { urlDraft, setUrlDraft, loadPackage, handleKeyDown };
}
