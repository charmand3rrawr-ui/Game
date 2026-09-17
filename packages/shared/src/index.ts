/**
 * @ascendance/shared — domain types, balance constants, and all game math.
 *
 * Imported by both the server and the client. The combat formula that runs on
 * the server is literally the same code that powers the client-side battle
 * simulator; that guarantee is the reason this project is in one language
 * (spec/01 §2).
 */

export * from './num.js';
export * from './prng.js';
export * from './formulas.js';
export * from './xp.js';
export * from './units.js';
export * from './roster.js';
export * from './npc.js';
export * from './types.js';
export * from './api/index.js';
export { C, CONSTANT_META, BALANCE_REVISION, ASSUMED_CONSTANTS } from './generated/constants.js';
export type { Provenance, ConstantMeta, Constants } from './generated/constants.js';
export * from './generated/refdata.js';
