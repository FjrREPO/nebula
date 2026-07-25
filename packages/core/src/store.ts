import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append-only JSON run log. Agents record every on-chain action here so the
 * dashboard (and the demo narrative) can replay the run with explorer links —
 * no indexer required.
 */
export interface RunEvent {
  at: string;
  actor: string;
  kind: string;
  summary: string;
  transactionHash?: string;
  explorerUrl?: string;
  data?: Record<string, unknown>;
}

export class RunLog {
  constructor(private readonly path: string) {}

  async read(): Promise<RunEvent[]> {
    if (!existsSync(this.path)) {
      return [];
    }
    return (await Bun.file(this.path).json()) as RunEvent[];
  }

  async append(event: Omit<RunEvent, 'at'>): Promise<RunEvent> {
    const events = await this.read();
    const stamped: RunEvent = { at: new Date().toISOString(), ...event };
    events.push(stamped);
    mkdirSync(dirname(this.path), { recursive: true });
    await Bun.write(this.path, `${JSON.stringify(events, null, 2)}\n`);
    return stamped;
  }
}
