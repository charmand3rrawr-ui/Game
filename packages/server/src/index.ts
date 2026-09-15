/**
 * index.ts — the single-process server
 *
 * spec/01 §6: do not build the full topology. Build a single-process version
 * containing the scheduler, the resolvers and an HTTP server. The interfaces
 * exist so that splitting it later is mechanical. "A distributed system built
 * before the game logic is a distributed system you will debug instead of
 * building a game."
 */

import { buildApp } from './app.js';
import { BALANCE_REVISION, ASSUMED_CONSTANTS, ROSTER, BUILDINGS } from '@ascendance/shared';

const PORT = Number(process.env['PORT'] ?? 8787);
const HOST = process.env['HOST'] ?? '0.0.0.0';

async function main(): Promise<void> {
  const app = await buildApp({ liveClock: true });

  await app.fastify.listen({ port: PORT, host: HOST });

  console.log(`ascendance: listening on http://${HOST}:${PORT}`);
  console.log(`ascendance: balance revision ${BALANCE_REVISION.slice(0, 16)}…`);
  console.log(`ascendance: ${BUILDINGS.length} buildings, ${ROSTER.length} units`);
  if (ASSUMED_CONSTANTS.length > 0) {
    console.log(`ascendance: ${ASSUMED_CONSTANTS.length} balance constants are still assumptions — see docs/ASSUMPTIONS.md`);
  }
  console.log(`ascendance: player ${app.playerId}`);

  // The world advances on request, and on a slow heartbeat so that scheduled
  // events still land for a player who is offline. This is the single-process
  // stand-in for the simulation workers of spec/01 §3.
  setInterval(() => {
    const now = BigInt(Date.now());
    if (now > app.world.now) app.world.advanceTo(now);
    for (const msg of app.world.drainOutbox()) app.hub.publish(msg.channel, msg.event, msg.data);
  }, 1000).unref?.();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
