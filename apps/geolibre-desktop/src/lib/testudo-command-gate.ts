const SAFE_WHILE_COMMAND_BUSY = new Set([
  "testudoSetLegendVisibility",
  "testudoSetEsriWorldImagery",
  "testudoSetKpiGeometry",
  "testudoGetMapControlState",
  "testudoGetKpiGeometryState",
]);
const SAFE_WHILE_PACKAGE_BUSY = new Set([
  "testudoGetMapControlState",
  "testudoGetKpiGeometryState",
]);

/** Complete a package operation's ownership cleanup before callers publish its result. */
export function runWithPackageOwnerRelease<T>(run: () => Promise<T>, release: () => void): Promise<T> {
  return run().finally(release);
}

/** Keeps package replacement and ordinary viewer commands under separate owners. */
export class TestudoCommandGate {
  private packageOwner: number | null = null;
  private commandOwner: number | null = null;
  private nextCommandOwner = 0;

  get packageBusy(): boolean { return this.packageOwner !== null; }
  get commandBusy(): boolean { return this.commandOwner !== null; }

  beginPackage(owner: number): void { this.packageOwner = owner; }

  finishPackage(owner: number): void {
    if (this.packageOwner === owner) this.packageOwner = null;
  }

  beginCommand(type: string): number | null {
    const safeDuringCommandBusy = SAFE_WHILE_COMMAND_BUSY.has(type);
    if (this.packageBusy && !SAFE_WHILE_PACKAGE_BUSY.has(type)) throw new Error("The viewer is loading a package. Please wait.");
    if (this.commandBusy && !safeDuringCommandBusy) throw new Error("The viewer is changing mode or scenario. Please wait.");
    if (safeDuringCommandBusy || this.packageBusy) return null;
    const owner = ++this.nextCommandOwner;
    this.commandOwner = owner;
    return owner;
  }

  finishCommand(owner: number | null): void {
    if (owner !== null && this.commandOwner === owner) this.commandOwner = null;
  }
}
