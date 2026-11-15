/**
 * Import FIRST, before any `next/*` module.
 *
 * Next picks its AsyncLocalStorage at module load from `globalThis.AsyncLocalStorage`:
 *
 *   const maybeGlobalAsyncLocalStorage =
 *     typeof globalThis !== 'undefined' && globalThis.AsyncLocalStorage;
 *
 * and falls back to a throwing FakeAsyncLocalStorage when that is unset. The Next
 * server (`next start`) provides it; a bare tsx/Node test runner does not, so every
 * Proxy call died on "Invariant: AsyncLocalStorage accessed in runtime where it is
 * not available" the first time Next's request context was entered.
 *
 * Node has the real class on `node:async_hooks`, so we put it where Next looks. This
 * only restores the runtime Next expects under test — no Next internals are patched.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const slot = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage };

if (slot.AsyncLocalStorage === undefined) slot.AsyncLocalStorage = AsyncLocalStorage;

export {};