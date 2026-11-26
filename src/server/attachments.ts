/**
 * Owner-scoped web composer attachments (PDFs & text/Markdown files).
 *
 * Files are saved under the current owner's `uploads/<uuid>/<safeName>` dir
 * (and best-effort mirrored to RustFS/S3 when configured), capped at 15 MiB
 * per file, and automatically purged after 7 days. The virtual path
 * `/uploads/<uuid>/<safeName>` is inserted into the composer as a chip and
 * resolved strictly inside the current owner's upload directory by the
 * pdf-reader sub-agent (never crossing tenants or exposing the host FS).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ownerPaths } from "../../config.ts";
import { currentOwnerId } from "../core/owner-scope.ts";
import { s3BlobConfigured } from "../store/blobs-s3.ts";
import { LOCAL_OWNER } from "../store/postgres/owner.ts";
import { archiveUploadedBlob } from "./blobs.ts";
import { getPgPool, hasDatabaseUrl } from "./db.ts";
import { postgresStorageEnabled, stores } from "./stores.ts";

/** Per-file upload cap: 15 MiB. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Total multipart request cap: 25 MiB (matches next.config.ts proxyClientMaxBodySize). */
export const MAX_ATTACHMENT_REQUEST_BYTES = 25 * 1024 * 1024;
/** Attachments are automatically deleted after 7 days. */
export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Small text/Markdown files up to 64 KiB are returned inline for immediate use. */
export const MAX_INLINE_TEXT_BYTES = 64 * 1024;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"
const UPLOAD_VIRTUAL_PATH = /^\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^/\\\0]+)$/i;
const SWEEP_THROTTLE_MS = 60 * 60 * 1000; // at most once per hour per process

let lastSweepAt = 0;

export interface SavedAttachment {
	kind: "pdf" | "text";
	id: string;
	filename: string;
	sizeBytes: number;
	virtualPath: string;
	inlineText?: string;
}

export class AttachmentUploadError extends Error {
	constructor(message: string, public readonly status = 400) {
		super(message);
		this.name = "AttachmentUploadError";
	}
}

/** Collapse a client filename to a single safe basename segment. */
export function sanitizeAttachmentFilename(raw: string): string {
	const base = path.basename(raw.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f-\u009f`]/g, "").trim();
	const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ").trim();
	if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
	return cleaned.slice(0, 120);
}

function isPdfBytes(bytes: Uint8Array): boolean {
	return bytes.byteLength >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

function isLikelyBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 8192).includes(0);
}

/** Save one uploaded web attachment into the current owner's upload directory. */
export async function saveUploadedAttachment(file: File, now = Date.now()): Promise<SavedAttachment> {
	if (file.size === 0) throw new AttachmentUploadError("Cannot attach an empty file.", 400);
	if (file.size > MAX_ATTACHMENT_BYTES) {
		throw new AttachmentUploadError(`File "${file.name}" exceeds the 15 MB per-file limit.`, 413);
	}

	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.byteLength === 0) throw new AttachmentUploadError("Cannot attach an empty file.", 400);
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
		throw new AttachmentUploadError(`File "${file.name}" exceeds the 15 MB per-file limit.`, 413);
	}

	const filename = sanitizeAttachmentFilename(file.name);
	const pdf = isPdfBytes(bytes);
	if (!pdf && isLikelyBinary(bytes)) {
		throw new AttachmentUploadError(
			`Unsupported binary file "${filename}". Upload a PDF or plain-text/Markdown file.`,
			415,
		);
	}

	const id = randomUUID();
	const uploadsRoot = ownerPaths().uploads;
	const entryDir = path.join(/* turbopackIgnore: true */ uploadsRoot, id);
	const targetPath = path.join(/* turbopackIgnore: true */ entryDir, filename);

	await fs.mkdir(entryDir, { recursive: true });
	await fs.writeFile(targetPath, bytes);

	const mimeType = pdf ? "application/pdf" : (file.type || "text/plain; charset=utf-8");
	// Best-effort archive to RustFS/S3 when configured (never blocks local storage).
	await archiveUploadedBlob({ filename, mimeType, bytes }).catch(() => undefined);

	// Opportunistic throttled cleanup of attachments older than 7 days.
	if (now - lastSweepAt >= SWEEP_THROTTLE_MS) {
		lastSweepAt = now;
		void purgeExpiredAttachments(now).catch(() => undefined);
	}

	const virtualPath = `/uploads/${id}/${filename}`;
	if (!pdf && bytes.byteLength <= MAX_INLINE_TEXT_BYTES) {
		return {
			kind: "text",
			id,
			filename,
			sizeBytes: bytes.byteLength,
			virtualPath,
			inlineText: new TextDecoder().decode(bytes),
		};
	}
	return {
		kind: pdf ? "pdf" : "text",
		id,
		filename,
		sizeBytes: bytes.byteLength,
		virtualPath,
	};
}

/**
 * Resolve `/uploads/<uuid>/<filename>` strictly inside the CURRENT owner's
 * upload directory. Returns null if not an upload path, missing, outside the
 * owner's jail, or expired (> 7 days old).
 */
export async function resolveUploadedAttachmentPath(rawPath: string, now = Date.now()): Promise<string | null> {
	const match = UPLOAD_VIRTUAL_PATH.exec(rawPath.trim());
	if (!match) return null;
	const [, id, filename] = match;
	if (!id || !filename || filename === "." || filename === "..") return null;

	const uploadsRoot = path.resolve(/* turbopackIgnore: true */ ownerPaths().uploads);
	const entryDir = path.resolve(/* turbopackIgnore: true */ uploadsRoot, id);
	const candidate = path.resolve(/* turbopackIgnore: true */ entryDir, filename);

	// Strict containment check inside the current owner's uploads root.
	const rel = path.relative(uploadsRoot, candidate);
	if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;

	try {
		const stat = await fs.stat(candidate);
		if (!stat.isFile()) return null;
		if (now - stat.mtimeMs > ATTACHMENT_TTL_MS) {
			await fs.rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
			return null;
		}
		return candidate;
	} catch {
		return null;
	}
}

export interface LoadedAttachment {
	bytes: Uint8Array;
	filename: string;
	contentType: string;
	kind: "pdf" | "text";
}

/**
 * Read one uploaded attachment belonging to the current owner. Reuses
 * `resolveUploadedAttachmentPath` so tenant isolation, path containment, and
 * 7-day TTL are enforced identically to pdf-reader.
 */
export async function readUploadedAttachment(
	id: string,
	filename: string,
	now = Date.now(),
): Promise<LoadedAttachment | null> {
	const resolved = await resolveUploadedAttachmentPath(`/uploads/${id}/${filename}`, now);
	if (!resolved) return null;
	try {
		const buf = await fs.readFile(resolved);
		const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		const pdf = isPdfBytes(bytes);
		return {
			bytes,
			filename: path.basename(resolved),
			contentType: pdf ? "application/pdf" : "text/plain; charset=utf-8",
			kind: pdf ? "pdf" : "text",
		};
	} catch {
		return null;
	}
}

/**
 * Delete uploaded attachments older than ATTACHMENT_TTL_MS (7 days) from the
 * current owner's upload directory (and from Postgres/RustFS uploaded_blobs
 * when active). Returns the number of local upload directories removed.
 */
export async function purgeExpiredAttachments(now = Date.now()): Promise<number> {
	let removed = 0;
	const uploadsRoot = ownerPaths().uploads;
	try {
		const entries = await fs.readdir(uploadsRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dirPath = path.join(/* turbopackIgnore: true */ uploadsRoot, entry.name);
			try {
				const stat = await fs.stat(dirPath);
				if (now - stat.mtimeMs > ATTACHMENT_TTL_MS) {
					await fs.rm(dirPath, { recursive: true, force: true });
					removed++;
				}
			} catch {
				// Best-effort per entry.
			}
		}
	} catch {
		// Directory may not exist yet.
	}

	// Also purge expired rows/objects from Postgres + RustFS if active.
	if (hasDatabaseUrl() && postgresStorageEnabled()) {
		try {
			const cutoff = new Date(now - ATTACHMENT_TTL_MS).toISOString();
			const owner = currentOwnerId() ?? LOCAL_OWNER;
			const { rows } = await getPgPool().query<{ id: string; blob_key: string }>(
				`DELETE FROM uploaded_blobs
				 WHERE owner_id = $1 AND created_at < $2
				 RETURNING id, blob_key`,
				[owner, cutoff],
			);
			if (s3BlobConfigured()) {
				for (const row of rows) {
					await Promise.resolve(stores.blobStore.delete(row.blob_key)).catch(() => undefined);
				}
			}
		} catch {
			// Best-effort cleanup.
		}
	}

	return removed;
}
