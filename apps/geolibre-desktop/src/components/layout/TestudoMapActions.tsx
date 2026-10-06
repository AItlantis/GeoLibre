import { FolderOpen } from "lucide-react";

interface TestudoMapActionsProps {
  onOpenLocalPackage: () => void;
}

/** Small map-surface actions owned by the Testudo shell. */
export function TestudoMapActions({ onOpenLocalPackage }: TestudoMapActionsProps) {
  return (
    <button
      type="button"
      data-testid="testudo-open-local-package"
      aria-label="Open local package"
      title="Open local package"
      onClick={onOpenLocalPackage}
      className="absolute left-3 top-3 z-20 inline-flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent"
    >
      <FolderOpen className="h-4 w-4" aria-hidden="true" />
      Open local package
    </button>
  );
}
