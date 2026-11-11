import type { Run } from './sender.js';

export class RunHistory {
  private runs: { session: string; run: Run }[] = [];

  constructor(private readonly limit = 200) {}

  add(run: Run, session = ''): void {
    this.runs.unshift({ session, run });
    if (this.runs.length > this.limit) this.runs.length = this.limit;
  }

  list(session = ''): Omit<Run, 'results'>[] {
    return this.runs
      .filter((r) => r.session === session)
      .map(({ run: { results: _results, ...rest } }) => rest);
  }

  get(id: string, session = ''): Run | undefined {
    return this.runs.find((r) => r.run.id === id && r.session === session)?.run;
  }

  get size(): number {
    return this.runs.length;
  }
}
