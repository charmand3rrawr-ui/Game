/**
 * hub.ts — the WebSocket fan-out
 *
 * `attack.incoming` is the single most time-critical message in the system:
 * the latency budget is under one second from the moment a movement enters the
 * defender's warning radius (spec/05 §4). So this is deliberately a plain
 * in-process map from channel to sockets, with no broker hop.
 *
 * In the topology of spec/01 §3 the fan-out moves behind Redis pub/sub so that
 * several gateway nodes share it. The interface below is what that swap has to
 * satisfy; nothing else in the server knows how delivery happens.
 */

export interface Sendable {
  send(data: string): void;
  readyState?: number;
}

export interface Client {
  id: number;
  socket: Sendable;
  channels: Set<string>;
}

export class Hub {
  private nextId = 1;
  private readonly clients = new Map<number, Client>();
  private readonly byChannel = new Map<string, Set<number>>();

  join(socket: Sendable): Client {
    const client: Client = { id: this.nextId++, socket, channels: new Set() };
    this.clients.set(client.id, client);
    return client;
  }

  leave(client: Client): void {
    for (const ch of client.channels) this.byChannel.get(ch)?.delete(client.id);
    this.clients.delete(client.id);
  }

  subscribe(client: Client, channel: string): void {
    client.channels.add(channel);
    const set = this.byChannel.get(channel) ?? new Set<number>();
    set.add(client.id);
    this.byChannel.set(channel, set);
  }

  unsubscribe(client: Client, channel: string): void {
    client.channels.delete(channel);
    this.byChannel.get(channel)?.delete(client.id);
  }

  /**
   * Push an event to a channel.
   *
   * Every envelope carries the server's own timestamp, because the client
   * renders timers from absolute server time plus a measured offset rather than
   * from its own clock (spec/06 §5).
   */
  publish(channel: string, event: string, data: unknown): number {
    const ids = this.byChannel.get(channel);
    if (!ids || ids.size === 0) return 0;
    const payload = JSON.stringify({ event, channel, at: String(Date.now()), data });
    let delivered = 0;
    for (const id of ids) {
      const c = this.clients.get(id);
      if (!c) continue;
      try {
        c.socket.send(payload);
        delivered++;
      } catch {
        // A dead socket must not stop delivery to the rest of the channel —
        // in a coordinated attack, one broken connection cannot be allowed to
        // swallow the warning for everyone else.
        this.leave(c);
      }
    }
    return delivered;
  }

  get size(): number {
    return this.clients.size;
  }

  channelsOf(client: Client): string[] {
    return [...client.channels];
  }
}
