/** Small per-package/generation cache used by bridge-owned Testudo resources. */
export class TestudoGenerationResourceCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  get(key: string, create: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = Promise.resolve().then(create).catch(error => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
      this.entries.set(key, entry);
    }
    return entry;
  }

  async remove(key: string, dispose: (value: T) => void | Promise<void>): Promise<void> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry) await dispose(await entry);
  }

  has(key: string): boolean { return this.entries.has(key); }
}

/** Fences a single async mount against a replaced Testudo package generation. */
export class TestudoGenerationMount {
  private generation = 0;
  private mounted = false;

  async mount(generation: number, isCurrent: () => boolean, apply: () => void | Promise<void>): Promise<boolean> {
    if (this.mounted && this.generation === generation) return true;
    this.clear();
    this.generation = generation;
    await apply();
    if (!isCurrent() || this.generation !== generation) {
      if (this.generation === generation) this.clear();
      return false;
    }
    this.mounted = true;
    return true;
  }

  clear(): void { this.generation = 0; this.mounted = false; }
  isMounted(generation: number): boolean { return this.mounted && this.generation === generation; }
}
