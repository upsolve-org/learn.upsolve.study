/**
 * Pure uploaded-attachment path parsing and collection helpers.
 *
 * Browser-safe: identifies owner-scoped web attachment virtual paths
 * (`/uploads/<uuid>/<filename>`) inside chat transcripts and maps them to
 * the authenticated read route `/api/attachments/<id>/<filename>`.
 */
import { parseComposerTokens } from "./composer-tokens.ts";

const UPLOAD_VIRTUAL_PATH_RE =
	/^\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^/\\\0]+)$/i;

export interface UploadedAttachmentRef {
	path: string;
	id: string;
	filename: string;
	kind: "pdf" | "text";
	url: string;
}

export function parseUploadedAttachmentPath(rawPath: string): UploadedAttachmentRef | null {
	const trimmed = rawPath.trim();
	const match = UPLOAD_VIRTUAL_PATH_RE.exec(trimmed);
	if (!match) return null;
	const [, id, filename] = match;
	if (!id || !filename || filename === "." || filename === "..") return null;
	const kind: "pdf" | "text" = /\.pdf$/i.test(filename) ? "pdf" : "text";
	return {
		path: trimmed,
		id,
		filename,
		kind,
		url: `/api/attachments/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`,
	};
}

export function collectUploadedAttachments(texts: readonly string[]): UploadedAttachmentRef[] {
	const seen = new Set<string>();
	const out: UploadedAttachmentRef[] = [];
	for (const text of texts) {
		for (const token of parseComposerTokens(text)) {
			if (token.kind !== "path") continue;
			const ref = parseUploadedAttachmentPath(token.path);
			if (!ref || seen.has(ref.path)) continue;
			seen.add(ref.path);
			out.push(ref);
		}
	}
	return out;
}
