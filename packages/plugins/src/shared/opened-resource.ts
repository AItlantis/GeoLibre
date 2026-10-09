export interface ClosableResource { close(): Promise<void> | void; }

/** Install an asynchronously opened resource only while its owner is current.
 * A resource that resolves after cancellation is closed immediately.
 */
export async function installOpenedResourceIfCurrent<T extends ClosableResource>(
  opened: Promise<T>,
  isCurrent: () => boolean,
  install: (resource: T) => void,
): Promise<boolean> {
  const resource = await opened;
  if (!isCurrent()) {
    await resource.close();
    return false;
  }
  install(resource);
  return true;
}
