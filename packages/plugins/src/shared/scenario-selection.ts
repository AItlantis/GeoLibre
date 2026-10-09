export function assertScenarioSelectionSucceeded(status: { loading: boolean; error: string | null }, label: string): void {
  if (status.error) throw new Error(status.error);
  if (status.loading) throw new Error(`${label} scenario selection is still loading.`);
}
