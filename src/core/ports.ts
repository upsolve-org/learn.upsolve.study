/**
 * Storage ports (the hexagonal seams — vision §1 "storage stays swappable").
 *
 * One port per ENTITY, with domain operations — never one generic
 * key/value interface. Core and the service layer that orbits it code
 * against these types only; concrete adapters live in src/store/ (fs
 * JSON/JSONL today, SQLite drop-in later) and are wired exactly once, in
 * the composition root (src/server/stores.ts). Dependencies point one way:
 * adapters may import core; core NEVER imports an adapter.
 */

import type { LhMessage } from "./native-messages.ts";
import type { PluginAgentRecord } from "./plugin-agents.ts";
import type { PluginTaskRecord } from "./plugin-workers.ts";
import type {
	ChatRecord,
	ImageSnapshot,
	ChatSettings,
	ChatSummary,
	GraphChain,
	GraphNode,
	JobKind,
	JobRecord,
	PluginJobMetadata,
	ExtractionRunUsage,
	PlanTree,
	Position,
	CoverageEntry,
	SessionCheckpoint,
	SideChatThread,
	TurnUsage,
	NotesSource,
} from "./contracts.ts";
import type { UserSettings } from "./settings.ts";
import type { Theme, ThemeFile } from "./themes.ts";

/** A port call may be served by an in-process fs adapter or by an async
 *  backend (SQLite, remote store). Every storage method may return a promise;
 *  callers await it. Pure in-memory helpers stay synchronous. */
export type MaybePromise<T> = T | Promise<T>;

/** Bridge a MaybePromise port call into the few seams that must stay
 *  synchronous (the in-process plugin record services and the synchronous
 *  graph-tool factory). Every adapter shipped today answers synchronously;
 *  if an async backend is ever wired into such a seam, this fails LOUDLY
 *  instead of leaking a rejected promise. The rejection is still observed
 *  so it can never surface as an unhandled rejection. */
export function expectSync<T>(value: MaybePromise<T>, operation: string): T {
	if (value !== null && typeof value === "object" && typeof (value as PromiseLike<T>).then === "function") {
		const promise = value as Promise<T>;
		void promise.then(undefined, () => { /* observed here, surfaced by the throw below */ });
		throw new Error(`${operation} must be synchronous at this seam`);
	}
	return value as T;
}

// ─── BlobStore — opaque bytes behind a validated key ────────────────────────

/** A stored blob's bytes + the metadata needed to serve them over HTTP. */
export interface BlobObject {
	body: Uint8Array;
	contentType: string;
	contentLength: number;
}

/** Metadata-only view (HEAD), without downloading the bytes. */
export interface BlobHead {
	contentType: string;
	contentLength: number;
}

/**
 * Binary object storage (PR 6). The fs adapter keeps blobs on local disk;
 * the S3/RustFS adapter keeps them in an object store. Keys are validated by
 * the adapter (never by the caller's path concatenation), and the port stays
 * type-only + browser-safe so it can ship through the core barrel.
 */
export interface BlobStore {
	put(key: string, body: Uint8Array, contentType: string): MaybePromise<void>;
	get(key: string): MaybePromise<BlobObject | null>;
	head(key: string): MaybePromise<BlobHead | null>;
	delete(key: string): MaybePromise<void>;
}

// ─── Plugin sessions — plugin-owned data, separate from core chats ──────────

/** One writer per plugin directory. Failed atomic replacements must throw. */
export interface PluginAgentRecordStore {
	list(): MaybePromise<PluginAgentRecord[]>;
	get(id: string): MaybePromise<PluginAgentRecord | null>;
	save(record: PluginAgentRecord): MaybePromise<void>;
}

/** One writer per plugin task directory; accepted results require an atomic save. */
export interface PluginTaskRecordStore {
	list(): MaybePromise<PluginTaskRecord[]>;
	get(id: string): MaybePromise<PluginTaskRecord | null>;
	save(record: PluginTaskRecord): MaybePromise<void>;
}

// ─── ChatStore — the session record's home (data/chats) ─────────────────────

export interface ChatStore {
	/** Create a session record (persisted immediately). */
	/** Create a session record; kind "practice" marks a practice session
	 *  (absent = teach, the default). */
	createChat(title: string, kind?: "practice"): MaybePromise<ChatRecord>;
	/** The full record, or null if unknown id / corrupt file. */
	getChat(id: string): MaybePromise<ChatRecord | null>;
	/** All sessions, newest activity first (the sidebar's list view). */
	listChats(): MaybePromise<ChatSummary[]>;
	/** Persist the full native message list (the record IS the agent
	 * state — Wave B, owner-approved 2026-09-26). */
	saveMessages(id: string, messages: LhMessage[]): MaybePromise<void>;
	/** Save a processed picture once, without changing conversation activity/order. */
	saveImageSnapshot(id: string, snapshotId: string, image: ImageSnapshot): MaybePromise<void>;
	/** Persist the session plan tree (plan tools call this in execute). */
	saveTree(id: string, tree: PlanTree): MaybePromise<void>;
	/** Append one usage entry to the record's turn log (the money channel,
	 * 2026-09): idempotent per turn id — each request carries its own, so
	 * a turn persisted twice appends once while continuation turns (which
	 * share a response message id) each keep their usage. */
	appendTurnUsage(id: string, entry: TurnUsage): MaybePromise<void>;
	/** Append one extraction-run usage entry — idempotent per startedAt. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): MaybePromise<void>;
	/** Persist the per-chat model/thinking settings (the model control).
	 *  Replace-whole: the picker sends the complete settings object. */
	saveSettings(id: string, settings: ChatSettings): MaybePromise<void>;
	/** Rename a session (the header's click-to-edit title, 2026-09-17).
	 * Like saveSettings: a rename is NOT conversation activity — updatedAt
	 * stays put, so sidebar order never churns on a rename. */
	renameChat(id: string, title: string): MaybePromise<ChatRecord>;
	/** Delete the session record entirely (session-deletion wave 6, owner
	 *  2026-09-22). False when the id is unknown. The graph-ledger purge and
	 *  job cleanup are the caller's choreography (core/graph-deletion.ts +
	 *  the DELETE route), not the store's. */
	deleteChat(id: string): MaybePromise<boolean>;
	/** Read-modify-write the record's side-question threads (inline
	 *  clarification threads, 2026-11-02) in one synchronous section — the
	 *  same per-field discipline as the usage logs, so it never clobbers a
	 *  concurrent turn's messages. Returns the stored threads, or null when
	 *  the chat is unknown (deleted mid-answer is not an error). Silent: the
	 *  side-chat service announces its own changes. Not conversation
	 *  activity — updatedAt stays put. */
	updateSideChats(id: string, update: (threads: SideChatThread[]) => SideChatThread[]): MaybePromise<SideChatThread[] | null>;
}

// ─── GraphStore — the append-only evidence ledgers (data/graph) ──────────────
// Chains are the stored truth (owner, 2026-09-30): nodes + reasoning
// chains; edges are a DERIVED view (core/graph.ts) and never touch this
// seam. Reads return the raw append-order lines; merging chain assertions
// by (premises, conclusion) is DERIVED in core/graph.ts — the store never
// decides. The extraction pipeline is the sole writer; this read surface
// stays.

export interface GraphStore {
	/** Append one GraphNode (ids are unique — no merging needed). */
	appendNode(node: GraphNode): MaybePromise<void>;
	/** Raw node lines in append order. */
	readNodes(): MaybePromise<GraphNode[]>;

	/** Append one chain ASSERTION (a second session asserting the same
	 *  (premises, conclusion) appends another line; readers merge). */
	appendChain(assertion: GraphChain): MaybePromise<void>;
	readChains(): MaybePromise<GraphChain[]>;

	/** Append one emission checkpoint. */
	appendCheckpoint(checkpoint: SessionCheckpoint): MaybePromise<void>;
	readCheckpoints(): MaybePromise<SessionCheckpoint[]>;
	/** Message-granular extraction coverage (vision-extraction-coverage.md):
	 *  append-only; one line per covered message. The chat-extraction
	 *  checkpoint — "uncovered" is derived from these, never tracked. */
	appendCoverage(entry: CoverageEntry): MaybePromise<void>;
	readCoverage(): MaybePromise<CoverageEntry[]>;

	/** Append one cluster-naming run's usage (graph-global money channel) —
	 *  idempotent per startedAt. */

	/** Upsert one imported-notes source record (config.SOURCES_FILE — a
	 *  JSON map, not a ledger; an upsert keeps the existing usage log). */
	upsertSource(source: NotesSource): MaybePromise<void>;
	/** Every notes source record, by id order-insensitive. */
	readSources(): MaybePromise<NotesSource[]>;
	/** Remove imported-source bookkeeping only; the service removes graph traces first. */
	deleteSources(ids: ReadonlySet<string>): MaybePromise<number>;
	/** Append one run's usage to a source record — idempotent per
	 *  startedAt, mirroring ChatRecord.extractions. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): MaybePromise<void>;

	/** The layout ledger (config.POSITIONS_FILE): nodeId → resting {x,y}.
	 *  WRITTEN ONLY by the incremental settle after a merge (core/layout.ts
	 *  settleGraphLayout) — read-only for everything else. */
	readPositions(): MaybePromise<Record<string, Position>>;
	/** Replace the whole ledger (the settle is a full-graph computation). */
	writePositions(positions: Record<string, Position>): MaybePromise<void>;

	/** THE DESTRUCTIVE SEAM (session-deletion wave 6, owner 2026-09-22 —
	 *  the first non-append operation on these ledgers): atomically
	 *  replace the full contents of any subset of the six rewritable
	 *  ledgers. Each provided array is written to a temp file and renamed
	 *  over the ledger (crash-safe: a torn write never replaces the
	 *  original); absent keys leave their ledger untouched. The pure
	 *  computation is core/graph-deletion.ts — the store only makes the
	 *  replacement atomic. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): MaybePromise<void>;
}

/** Separate from graph ledgers and source identity, for future shared views. */
export interface SourceOrganizationStore {
	read(): MaybePromise<import("./source-organization.ts").SourceOrganization>;
	write(state: import("./source-organization.ts").SourceOrganization): MaybePromise<void>;
}

// ─── JobStore — background sub-agent jobs (data/jobs) ─────────────────────────

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	/** First activity line (defaults to "starting"). */
	activity?: string;
	/** Host-owned plugin worker linkage, not model-selected routing. */
	plugin?: PluginJobMetadata;
	/** Saved on the job before its worker is spawned. */
	input?: unknown;
}

/** Mergeable fields — identity (id, kind, chatId, toolCallId, createdAt) is immutable. */
export type JobPatch = Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>;

export interface JobStore {
	/** Create a running job (keyed by toolCallId for spawn dedup). */
	createJob(init: CreateJobInit): MaybePromise<JobRecord>;
	getJob(id: string): MaybePromise<JobRecord | null>;
	/** Merge a patch into the record; null if unknown id. */
	updateJob(id: string, patch: JobPatch): MaybePromise<JobRecord | null>;
	/** All jobs for a chat, newest activity first. */
	listJobs(chatId: string): MaybePromise<JobRecord[]>;
	/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
	findJobByToolCallId(chatId: string, toolCallId: string): MaybePromise<JobRecord | null>;
	/** Delete every job record for a chat — running or finished (session-
	 *  deletion wave 6). Returns how many files were removed. The deletion
	 *  route refuses while jobs are still running, so by the time this
	 *  fires every record is terminal. */
	deleteJobsForChat(chatId: string): MaybePromise<number>;
}

// ─── SettingsStore — THE user settings record (settings-storage wave, 2026-09-19) ──

/**
 * The one record for every non-secret product preference (core/settings.ts
 * UserSettings — delta semantics, see that module's doc). The store is
 * replace-whole on the RECORD; per-section scoping is a server-band concern
 * (single process, no stale-client hazard to defend against at this seam).
 * Schema-version lazy migration happens inside readSettings, never in
 * the callers. (The legacy default-settings.json fold died with the chat
 * section — per-session models, owner 2026-09-28.)
 */
export interface SettingsStore {
	/** The sanitized record, or null when none exists yet (first boot). */
	readSettings(): MaybePromise<UserSettings | null>;
	/** Persist the record (replace-whole). Callers pass a SANITIZED record. */
	writeSettings(settings: UserSettings): MaybePromise<void>;
}

// ─── ThemeStore — imported custom themes (theme wave, 2026-11-04) ──────────

/**
 * Custom themes as `<id>.json` files under config.THEMES_DIR, one per
 * imported theme (core/themes.ts ThemeFile shape). The store persists
 * what it is given; validation and id choice are the route's concern.
 * Unreadable or invalid files are skipped on list, never thrown.
 */
export interface ThemeStore {
	/** Every valid custom theme on disk, sorted by id. */
	listThemes(): MaybePromise<Theme[]>;
	/** One custom theme, or null when the file is absent or invalid. */
	readTheme(id: string): MaybePromise<Theme | null>;
	/** Persist a theme file at `<id>.json` (creates the dir). */
	writeTheme(id: string, theme: ThemeFile): MaybePromise<void>;
	/** Remove `<id>.json`, if present. */
	deleteTheme(id: string): MaybePromise<void>;
}

// ─── PromptOverrideStore — per-segment system-prompt overrides (2026-09-19) ──

/**
 * User text overriding ONE source prompt segment (the shared base or one
 * numeric fragment), stored at the data-dir seam mirroring the source
 * layout (config.PROMPTS_OVERRIDE_DIR). File presence is NOT the override:
 * the settings record's agent.prompts switch is the explicit on/off, so a
 * user can keep a customized file on disk while running the source default.
 * The segment LIST is always derived from source at runtime — see the
 * adapter (src/store/prompt-overrides.ts) for the loader rules.
 */
export interface PromptOverrideStore {
	/** Every override path currently on disk ("system-prompt.md",
	 *  "teacher/20-teaching.md", ...), POSIX-relative, sorted. */
	listOverrides(): MaybePromise<string[]>;
	/** The override text, or null when the path has no file. */
	readOverride(segmentPath: string): MaybePromise<string | null>;
	/** Persist override text for a segment path (creates parents). */
	writeOverride(segmentPath: string, text: string): MaybePromise<void>;
	/** Remove the override file, if present (switches are untouched — an
	 *  on-switch with no file composes the source default, inert). */
	deleteOverride(segmentPath: string): MaybePromise<void>;
}

// ─── AuthStore — BYOK provider keys (auth-keys wave, 2026-09-19) ────────────

/**
 * The long-standing flat {VAR: value} auth.json map (config.AUTH_FILE) —
 * the same file the Electron app has always hand-edited, now first-class
 * server-managed. Values are opaque strings: shape validation is a
 * server-band concern (core/auth-keys.ts validateKeyShape — the store
 * persists what it is given); env precedence is a server-band concern
 * too (src/server/keys.ts). Unknown vars ride along verbatim.
 */
export interface AuthStore {
	/** The whole map — absent or corrupt file = {} ("no keys yet", the
	 *  documented first-boot state). Never throws. */
	authVars(): Record<string, string>;
	/** Set one VAR (atomic write, mode 0600 always, other vars preserved). */
	setAuthVar(name: string, value: string): void;
	/** Remove one VAR if present (absent = no-op, still a silent success). */
	deleteAuthVar(name: string): void;
}

