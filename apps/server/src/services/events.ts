import type { ServerResponse } from 'node:http';

/** Server-sent events hub: live leaderboard and competition updates for every open page. */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  add(res: ServerResponse): void {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) c.write(': keep-alive\n\n');
      }, 25_000);
      this.heartbeat.unref();
    }
  }

  publish(type: 'leaderboard' | 'competition' | 'practice', data: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  get size(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
