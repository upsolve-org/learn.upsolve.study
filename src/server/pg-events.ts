/**
 * PostgreSQL LISTEN/NOTIFY bridge for the core event bus (PR 5).
 *
 * The web process and the standalone worker are separate Node processes, so
 * an in-process event bus cannot see the other's emits. This module extends
 * the browser-safe core bus: local emit() -> NOTIFY lh_events; inbound
 * NOTIFY from a DIFFERENT instance -> deliverRemoteEvent() into local SSE
 * subscribers, filtered by the owner captured on the notification.
 *
 * Two independent loop stops:
 *   1. every envelope carries a per-process `origin`; notifications whose
 *      origin is ours are ignored;
 *   2. deliverRemoteEvent() never calls the bridge publisher.
 *
 * NOTIFY is best-effort by design. An oversized payload or a dropped
 * connection is logged and discarded — it NEVER throws into the store write
 * that fired the event. SSE consumers already refetch authoritative state.
 */

import { randomUUID } from "node:crypto";
import { Client, type Notification } from "pg";
import { deliverRemoteEvent, registerEventBridge, type EventEnvelope, type ServerEventType } from "../core/events.ts";
import { hasDatabaseUrl } from "./db.ts";

const CHANNEL = "lh_events";
/** Worker → web: "a sub-agent job of this chat has a pending delivery". */
const JOB_DELIVERY_CHANNEL = "lh_job_delivery";
/** PostgreSQL caps a NOTIFY payload at 8000 bytes including overhead. */
const MAX_PAYLOAD_BYTES = 7500;
const RECONNECT_MS = 2_000;

interface BridgeState {
	instanceId: string;
	client?: Client;
	url: string;
	unregister: () => void;
	reconnectTimer?: ReturnType<typeof setTimeout>;
	connecting: boolean;
	stopped: boolean;
}

interface PgEventsGlobal {
	__lhPgEventsBridge?: BridgeState;
	__lhJobDeliveryHandler?: JobDeliveryHandler;
}

export interface JobDeliveryNotice {
	/** Absent for unscoped (desktop/plain-dev) work. */
	owner?: string;
	chatId: string;
}
export type JobDeliveryHandler = (notice: JobDeliveryNotice) => void;

/** Web process: react to the worker's finished-job announcements. The
 *  handler survives bridge restarts; pass undefined to remove it. */
export function setJobDeliveryHandler(handler: JobDeliveryHandler | undefined): void {
	(globalThis as typeof globalThis & PgEventsGlobal).__lhJobDeliveryHandler = handler;
}

function onJobDeliveryNotification(bridge: BridgeState, payload: string): void {
	let notice: { origin?: unknown; owner?: unknown; chatId?: unknown };
	try {
		notice = JSON.parse(payload) as typeof notice;
	} catch {
		return;
	}
	if (!notice || notice.origin === bridge.instanceId || typeof notice.chatId !== "string") return;
	const handler = (globalThis as typeof globalThis & PgEventsGlobal).__lhJobDeliveryHandler;
	if (!handler) return; // e.g. the worker itself: it never delivers
	try {
		handler({ chatId: notice.chatId, ...(typeof notice.owner === "string" ? { owner: notice.owner } : {}) });
	} catch (error) {
		console.warn("[pg-events] job delivery handler failed:", error);
	}
}

/**
 * Worker process: announce that `chatId` has a pending job delivery. Best
 * effort — false when there is no listener connection; the delivery is
 * already durable on the job record and the web sweep restores it.
 */
export async function publishJobDelivery(notice: JobDeliveryNotice): Promise<boolean> {
	const bridge = (globalThis as typeof globalThis & PgEventsGlobal).__lhPgEventsBridge;
	const client = bridge?.client;
	if (!bridge || !client) return false;
	const payload = JSON.stringify({ origin: bridge.instanceId, owner: notice.owner, chatId: notice.chatId });
	try {
		await client.query("SELECT pg_notify($1, $2)", [JOB_DELIVERY_CHANNEL, payload]);
		return true;
	} catch (error) {
		console.warn("[pg-events] job delivery NOTIFY failed:", error);
		return false;
	}
}

function onNotification(bridge: BridgeState, client: Client, msg: Notification): void {
	if (bridge.client !== client || !msg) return;
	if (msg.channel === JOB_DELIVERY_CHANNEL && msg.payload) {
		onJobDeliveryNotification(bridge, msg.payload);
		return;
	}
	if (msg.channel !== CHANNEL || !msg.payload) return;
	let envelope: { origin?: unknown; type?: unknown; payload?: unknown; owner?: unknown };
	try {
		envelope = JSON.parse(msg.payload) as typeof envelope;
	} catch {
		return; // malformed notification — nothing to deliver
	}
	if (!envelope || envelope.origin === bridge.instanceId) return; // loop stop #1
	const type = envelope.type;
	if (typeof type !== "string") return;
	try {
		deliverRemoteEvent(
			type as ServerEventType,
			envelope.payload,
			typeof envelope.owner === "string" ? envelope.owner : undefined,
		);
	} catch (error) {
		console.warn("[pg-events] remote event delivery failed:", error);
	}
}

function scheduleReconnect(bridge: BridgeState): void {
	if (bridge.stopped || bridge.reconnectTimer) return;
	bridge.reconnectTimer = setTimeout(() => {
		bridge.reconnectTimer = undefined;
		void connect(bridge);
	}, RECONNECT_MS);
	bridge.reconnectTimer.unref?.();
}

function makeClient(bridge: BridgeState): Client {
	const client = new Client({ connectionString: bridge.url });
	client.on("notification", (msg) => onNotification(bridge, client, msg));
	client.on("error", (error) => {
		if (bridge.client !== client) return; // stale connection from a previous attempt
		console.warn("[pg-events] listener error; reconnecting:", error);
		scheduleReconnect(bridge);
	});
	client.on("end", () => {
		if (bridge.client !== client || bridge.stopped) return;
		scheduleReconnect(bridge);
	});
	return client;
}

async function connect(bridge: BridgeState): Promise<void> {
	if (bridge.stopped || bridge.connecting) return;
	bridge.connecting = true;
	const previous = bridge.client;
	const client = makeClient(bridge);
	bridge.client = client;
	// A failed/ended listener must not leave its old connection listening
	// while the replacement takes over (the stale handlers self-ignore).
	if (previous) await previous.end().catch(() => undefined);
	try {
		await client.connect();
		if (bridge.stopped) {
			await client.end().catch(() => undefined);
			return;
		}
		await client.query(`LISTEN ${CHANNEL}`);
		await client.query(`LISTEN ${JOB_DELIVERY_CHANNEL}`);
	} catch (error) {
		if (!bridge.stopped) console.warn("[pg-events] LISTEN setup failed; retrying:", error);
		await client.end().catch(() => undefined);
		scheduleReconnect(bridge);
	} finally {
		bridge.connecting = false;
	}
}

function publish(bridge: BridgeState, envelope: EventEnvelope): void {
	let serialized: string;
	try {
		serialized = JSON.stringify({
			origin: bridge.instanceId,
			owner: envelope.owner,
			type: envelope.type,
			payload: envelope.payload,
		});
	} catch (error) {
		console.warn("[pg-events] could not serialize event; dropped:", error);
		return;
	}
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > MAX_PAYLOAD_BYTES) {
		console.warn(`[pg-events] dropped oversized ${bytes}-byte ${envelope.type} notification (limit ${MAX_PAYLOAD_BYTES})`);
		return;
	}
	const client = bridge.client;
	if (!client) return;
	// A NOTIFY is a hint, never a transaction participant: swallow every
	// failure so a database blip cannot fail the write that emitted it.
	void client.query("SELECT pg_notify($1, $2)", [CHANNEL, serialized]).catch((error: unknown) => {
		console.warn("[pg-events] NOTIFY failed:", error);
	});
}

/** Start the bridge (idempotent). A missing DATABASE_URL is a silent no-op —
 *  fs mode has no database to notify. */
export function startPgEventsBridge(connectionString?: string): void {
	const g = globalThis as typeof globalThis & PgEventsGlobal;
	if (g.__lhPgEventsBridge) return;
	const url = (connectionString ?? process.env.DATABASE_URL ?? "").trim();
	if (!url || !hasDatabaseUrl({ DATABASE_URL: url })) return;

	const bridge: BridgeState = {
		instanceId: randomUUID(),
		url,
		unregister: () => {},
		connecting: false,
		stopped: false,
	};
	g.__lhPgEventsBridge = bridge;
	bridge.unregister = registerEventBridge((envelope) => publish(bridge, envelope));
	void connect(bridge);
}

/** Stop listening and unregister the publisher. Safe to call repeatedly. */
export async function stopPgEventsBridge(): Promise<void> {
	const g = globalThis as typeof globalThis & PgEventsGlobal;
	const bridge = g.__lhPgEventsBridge;
	if (!bridge) return;
	bridge.stopped = true;
	g.__lhPgEventsBridge = undefined;
	bridge.unregister();
	if (bridge.reconnectTimer) clearTimeout(bridge.reconnectTimer);
	await bridge.client?.end().catch(() => undefined);
}
