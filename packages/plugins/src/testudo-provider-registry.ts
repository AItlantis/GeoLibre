import type { TestudoPackageBootstrap, TestudoFeatureProviderFactory } from "./testudo-feature-bridge";
import type { TestudoCapabilityKey } from "./shared/testudo-feature-session";

export interface TestudoPackageProviderRegistration {
  capability: TestudoCapabilityKey;
  factory: TestudoFeatureProviderFactory;
}

interface OwnedRegistration extends TestudoPackageProviderRegistration {
  owner: string;
}

const providers = new Map<TestudoCapabilityKey, OwnedRegistration>();

/** Register one package loader/feature adapter under its manifest capability. */
export function registerTestudoPackageProvider(
  registration: TestudoPackageProviderRegistration,
  owner: string,
): () => void {
  if (!owner.trim()) throw new Error("A provider owner id is required.");
  const previous = providers.get(registration.capability);
  if (previous) throw new Error(`A Testudo provider is already registered for ${registration.capability}.`);
  const entry: OwnedRegistration = { ...registration, owner };
  providers.set(registration.capability, entry);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    if (providers.get(registration.capability) === entry) providers.delete(registration.capability);
  };
}

/** Resolve only a provider registered by an active plugin. */
export function getTestudoPackageProvider(
  capability: TestudoCapabilityKey,
  bootstrap: TestudoPackageBootstrap,
): TestudoFeatureProviderFactory | null {
  const declared = bootstrap.capabilities?.find((item) => item.id === capability && item.available);
  if (!declared) return null;
  return providers.get(capability)?.factory ?? null;
}

export function clearTestudoPackageProvidersForOwner(owner: string): void {
  for (const [capability, entry] of providers) {
    if (entry.owner === owner) providers.delete(capability);
  }
}
