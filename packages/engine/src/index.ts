/**
 * @ascendance/engine — the authoritative simulation
 *
 * Runs identically in a Node server process and in a browser tab: the store is
 * an interface, the simulation is pure, and nothing here reads a clock or
 * touches the network (DECISIONS.md D4).
 */

export { World, CommandError } from './world.js';
export type { WorldOptions, EnqueueArgs, DispatchArgs, Options } from './world.js';
export { seedWorld } from './bootstrap.js';
export type { SeedOptions, SeededWorld } from './bootstrap.js';
export { Scheduler, IdFactory, compareEvents } from './scheduler.js';
export type { Handler, Handlers, DrainResult } from './scheduler.js';
export { MemoryStore, NotFound } from './store/memory.js';
export type { Store, Tx, Repo, KeyedRepo } from './store/types.js';
export * from './sim/settlement.js';
export * from './sim/combat.js';
export * from './sim/veterancy.js';
export * from './sim/military.js';
export * from './sim/research.js';
export * from './sim/cultivation.js';
export * from './sim/governor.js';
