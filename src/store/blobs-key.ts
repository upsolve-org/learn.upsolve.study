/**
 * Blob key discipline (PR 6). A BlobStore key is a RELATIVE POSIX path, not
 * a filesystem path: every adapter validate()s it before touching its root.
 * The same helper builds owner-scoped keys so tenant isolation is structural
 * (the owner is the first segment) rather than a caller convention.
 */

/** Owner categories that own a blob namespace. */
export type BlobCategory = "images" | "uploads";

/**
 * Normalize a blob key and refuse anything that could escape its root.
 * Rejected: empty keys, leading/trailing slashes, backslashes, null bytes,
 * and `.`/`..` path segments. Repeated `/` are collapsed to one, so the
 * returned key is always a clean relative POSIX path.
 */
export function validateBlobKey(key: string): string {
	if (typeof key !== "string" || key.length === 0) {
		throw new Error("Blob key must not be empty");
	}
	if (key.includes("\0")) throw new Error("Blob key must not contain a null byte");
	if (key.includes("\\")) throw new Error("Blob key must not contain a backslash");
	if (key.startsWith("/") || key.endsWith("/")) {
		throw new Error("Blob key must not start or end with a slash");
	}

	const normalized = key.replace(/\/{2,}/g, "/");
	const segments = normalized.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new Error("Blob key must not contain empty, '.' or '..' segments");
	}
	return normalized;
}

/** Build `<owner>/<category>/<filename>` and validate it in one step. */
export function ownerBlobKey(owner: string, category: BlobCategory, filename: string): string {
	return validateBlobKey(`${owner}/${category}/${filename}`);
}

/** File extension for a MIME type — used to give stored blobs a useful name. */
export function extForMime(mimeType: string): string {
	switch (mimeType.split(";", 1)[0]!.trim().toLowerCase()) {
		case "image/png": return "png";
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		case "image/bmp": return "bmp";
		case "application/pdf": return "pdf";
		case "text/markdown": return "md";
		case "text/plain": return "txt";
		default: return "bin";
	}
}
