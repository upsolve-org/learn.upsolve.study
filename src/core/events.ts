/**
 * Live app notifications for turn, job, record and availability changes.
 * Consumers fetch authoritative state after a notification and refetch on
 * reconnect; notifications are not a durable replay log. The plugin-message
 * channel additionally carries plugin-scoped JSON data, with the same
 * live-only delivery limitation.
 *
 * Browser-safe: reads the server's globalThis.__lhOwnerScope AsyncLocalStorage
 * without importing node:async_hooks so client components can import
 * SERVER_EVENT_TYPES from @/src/core cleanly.
 */
function activeEventOwner(): string | undefined {
	return (globalThis as { __lhOwnerScope?: { getStore(): string | undefined } }).__lhOwnerScope?.getStore();
}

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

/**
 * The wire shape for an event handed to (or received from) an external
 * bridge — the Postgres LISTEN/NOTIFY SSE fan-out in src/server/pg-events.ts.
 * `owner` is the VERIFIED scope of the emitting request; remote subscribers
 * are filtered against it exactly like local ones. Never carry secrets: the
 * frames are notify-then-fetch hints, not a data channel.
 */
export interface EventEnvelope {
	type: ServerEventType;
	payload: unknown;
	owner?: string;
}

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
	/** Optional server-side publisher. Absent in the browser and in fs mode. */
	__lhEventBridge?: (envelope: EventEnvelope) => void;
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

/** Deliver to LOCAL subscribers only. Both paths (local emit and a remote
 *  bridge notification) go through this one function so the owner filter can
 *  never drift between them. The owner is captured by the CALLER once — an
 *  async listener cannot observe a different scope than its neighbours. */
function deliver(type: ServerEventType, payload: unknown, owner: string | undefined): void {
	const event = { type, ...((payload ?? {}) as object) } as ServerEvent;
	// Snapshot: a listener that unsubscribes (or subscribes) mid-emit must
	// not mutate the set under iteration.
	for (const subscriber of [...listeners()]) {
		if (subscriber.owner !== undefined) {
			const sameOwner = owner === subscriber.owner;
			// Boot/plugin availability can be announced before a tenant scope
			// exists; that ONE channel is safe (it carries no tenant data).
			if (!sameOwner && !(owner === undefined && type === "plugins-changed")) continue;
		}
		try {
			subscriber.listener(event);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}

/**
 * Install the optional external publisher (the Postgres NOTIFY bridge).
 * Returns an unsubscribe that removes ONLY this registration, so a stale
 * teardown cannot silence a newer bridge after a dev/HMR reload.
 *
 * This module stays browser-safe: no Node import, no connection, no I/O —
 * just an injectable function on globalThis.
 */
export function registerEventBridge(publish: (envelope: EventEnvelope) => void): () => void {
	const g = globalThis as typeof globalThis & LhEventsGlobal;
	g.__lhEventBridge = publish;
	return () => {
		if (g.__lhEventBridge === publish) delete g.__lhEventBridge;
	};
}

/**
 * Deliver a notification received FROM the external bridge to this process's
 * SSE subscribers, scoped to `owner`. Critically this does NOT call the
 * bridge: a remote event is never re-published, which (together with the
 * bridge's origin check) is what stops an infinite NOTIFY loop.
 */
export function deliverRemoteEvent(type: ServerEventType, payload: unknown, owner?: string): void {
	// A remote message is untrusted data: ignore unknown event names and
	// non-object payloads rather than handing a malformed frame to a view.
	if (!(SERVER_EVENT_TYPES as readonly string[]).includes(type)) return;
	const safe = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
	deliver(type, safe, owner);
}

/** Notify every listener, then hand the event to the external bridge if one
 *  is installed. Zero subscribers is a no-op locally (the emission was for
 *  the stores' own bookkeeping anyway); a missing bridge is a no-op in fs
 *  mode. A bridge failure is logged and NEVER thrown into the caller — an
 *  SSE notification must never fail the write that triggered it. */
export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	// The emitter's scope is the event's ownership. Captured ONCE so an
	// async listener cannot observe a different scope than its neighbours.
	const eventOwner = activeEventOwner();
	deliver(type, payload, eventOwner);
	const bridge = (globalThis as typeof globalThis & LhEventsGlobal).__lhEventBridge;
	if (bridge) {
		try {
			bridge({ type, payload, owner: eventOwner });
		} catch (err) {
			console.warn(`[events] bridge publish failed on ${type}:`, err);
		}
	}
}
