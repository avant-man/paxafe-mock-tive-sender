import type { Run } from './sender.js';

/** In-memory run history, newest first, capped. Lost on restart by design (no database). */
export class RunHistory {
  private runs: Run[] = [];

  constructor(private readonly limit = 200) {}

  add(run: Run): void {
    this.runs.unshift(run);
    if (this.runs.length > this.limit) this.runs.length = this.limit;
  }

  list(): Omit<Run, 'results'>[] {
    return this.runs.map(({ results: _results, ...rest }) => rest);
  }

  get(id: string): Run | undefined {
    return this.runs.find((r) => r.id === id);
  }

  clear(): void {
    this.runs = [];
  }

  get size(): number {
    return this.runs.length;
  }
}
