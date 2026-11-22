/**
 * Live app notifications for turn, job, record and availability changes.
 * Consumers fetch authoritative state after a notification and refetch on
 * reconnect; notifications are not a durable replay log. The plugin-message
 * channel additionally carries plugin-scoped JSON data, with the same
 * live-only delivery limitation.
 */
import { currentOwnerId } from "./owner-scope.ts";

/** The core event vocabulary plus the namespaced plugin extension channel. */
export interface ServerEvents {
	/** A native conversation turn began server-side, including sends, wake
	 * turns and turns initiated from another window. */
	"turn-started": { chatId: string };
	/** A turn settled after turn persistence. Refetch the saved record; this
	 * does not mean asynchronous extraction or background work has completed. */
	"turn-settled": { chatId: string };
	/** A job record changed (dispatch, progress, settle, abort, recovery).
	 *  chatId when known — consumers that own one chat filter on it. */
	"jobs-changed": { chatId?: string };
	/** An extraction run changed phase (activity dock). */
	"activity-changed": Record<string, never>;
	/** The session list changed (create, delete, title). */
	"chats-changed": Record<string, never>;
	/** Source inventory, display names, or organizational folders changed. */
	"sources-changed": Record<string, never>;
	/** Web subscription state changed. No account or credential data on the bus. */
	"subscriptions-changed": Record<string, never>;
	/** A chat's record changed WITHOUT a turn (the silent dismissal write).
	 *  Same notify-then-fetch contract as the turn events: open views of
	 *  the chat refetch and adopt the durable record. */
	"record-changed": { chatId: string };
	/** Context compaction started or finished for this chat. While running is
	 * true, the server gates model interaction and the client disables related
	 * composer/dock submission. This is live state, not a persisted marker. */
	"compaction-changed": { chatId: string; running: boolean };
	/** A side conversation changed. Notify-then-fetch: open views refetch
	 *  GET /api/chats/:id/side-chats. Closing never deletes it. */
	"side-chats-changed": { chatId: string };
	/** Plugin availability/lifecycle changed; refetch installed packages. */
	"plugins-changed": Record<string, never>;
	/** Live-only, plugin-scoped notifications. Reconnect requires snapshot resync. */
	"plugin-message": { pluginId: string; topic: string; data?: unknown };
}

export type ServerEventType = keyof ServerEvents;

/** The vocabulary's runtime names — the client wires one listener per
 *  name (types are erased; this list is the single source of truth for
 *  what the SSE channel can carry). */
export const SERVER_EVENT_TYPES = [
	"turn-started",
	"turn-settled",
	"jobs-changed",
	"activity-changed",
	"chats-changed",
	"sources-changed",
	"subscriptions-changed",
	"record-changed",
	"compaction-changed",
	"side-chats-changed",
	"plugins-changed",
	"plugin-message",
] as const satisfies readonly ServerEventType[];

/** One notification: distribute over the vocabulary so narrowing `type`
 * actually narrows its payload (including plugin-scoped messages). */
export type ServerEvent<K extends ServerEventType = ServerEventType> = {
	[T in K]: { type: T } & ServerEvents[T];
}[K];

export type ServerEventListener = (event: ServerEvent) => void;

/** A listener plus the owner it is scoped to. `owner === undefined` is the
 *  legacy unscoped subscriber (desktop/local/tests): it sees EVERY event,
 *  whatever scope the emitter ran in. A scoped subscriber sees only its
 *  owner's events — never another tenant's, never an unscoped tenant event. */
interface Subscriber {
	listener: ServerEventListener;
	owner?: string;
}

interface LhEventsGlobal {
	__lhEventBus?: Set<Subscriber>;
}

/** The shared listener set — globalThis-backed so every Next module entry
 *  (and every layer) sees ONE bus. Ephemeral by design: a process restart
 *  drops the listeners with their connections; emitters never queue. */
function listeners(): Set<Subscriber> {
	const g = globalThis as typeof globalThis & LhEventsGlobal;
	return (g.__lhEventBus ??= new Set());
}

/** Listen. Returns the unsubscribe function — the SSE route's cancel and
 *  any test cleanup call it; a dropped listener leaks nothing.
 *
 *  `options.owner` is the VERIFIED owner of the SSE connection. Pass it on
 *  hosted requests so this window cannot be fed another tenant's frames. */
export function subscribe(listener: ServerEventListener, options?: { owner?: string }): () => void {
	const set = listeners();
	const subscriber: Subscriber = options?.owner === undefined ? { listener } : { listener, owner: options.owner };
	set.add(subscriber);
	return () => set.delete(subscriber);
}

/** Notify every listener. Zero subscribers is a no-op (no window open —
 *  the emission was for the stores' own bookkeeping anyway). One
 *  listener throwing must never break the others or the emitter: each
 *  call is isolated, the failure logged, the loop continues. */
export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	// The emitter's scope is the event's ownership. Captured ONCE so an
	// async listener cannot observe a different scope than its neighbours.
	const eventOwner = currentOwnerId();
	// Snapshot: a listener that unsubscribes (or subscribes) mid-emit must
	// not mutate the set under iteration.
	for (const subscriber of [...listeners()]) {
		if (subscriber.owner !== undefined) {
			const sameOwner = eventOwner === subscriber.owner;
			// Boot/plugin availability can be announced before a tenant scope
			// exists; that ONE channel is safe (it carries no tenant data).
			if (!sameOwner && !(eventOwner === undefined && type === "plugins-changed")) continue;
		}
		try {
			subscriber.listener({ type, ...payload } as ServerEvent);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}
