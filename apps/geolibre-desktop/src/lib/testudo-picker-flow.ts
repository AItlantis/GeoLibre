/** Invoke `choose` synchronously from the caller's activation event, then load the selected handle. */
export function openLocalPackageFromActivation<THandle, TResult>(
  pendingRequestId: string | null,
  activatedRequestId: string,
  choose: () => Promise<THandle>,
  load: (handle: THandle) => Promise<TResult>,
): Promise<TResult | null> {
  if (!pendingRequestId || pendingRequestId !== activatedRequestId) return Promise.resolve(null);
  let selection: Promise<THandle>;
  try { selection = choose(); }
  catch (error) { return Promise.reject(error); }
  return selection.then(load);
}
