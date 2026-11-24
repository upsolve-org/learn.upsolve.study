import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveSourcePath } from "./fs-shared.ts";
import { convertImageBytesToPng } from "../image-processing/convert.mjs";
import { resizeImageInProcess } from "../image-processing/resize-core.mjs";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile, type ResizedImage } from "../image-processing/index.ts";
import { checkImageDimensions, MAX_LEARNER_IMAGE_BYTES } from "./learner-image-dimensions.ts";
import type { ImageSnapshot } from "../../core/contracts.ts";

/** One bounded, upright, metadata-free snapshot; path is provenance, not identity. */
export interface LearnerImage extends ImageSnapshot {
	path: string;
	snapshotId: string;
}

export async function checkLearnerImage(rawPath: string): Promise<string> {
	// Reuse the shared file-access policy, including canonical/symlink checks.
	const absolute = resolveSourcePath(rawPath);
	try {
		const stat = await fs.stat(absolute);
		if (!stat.isFile()) throw new Error("it is not a regular file");
		if (stat.size > MAX_LEARNER_IMAGE_BYTES) throw new Error("image exceeds 25 MiB; provide a smaller image");
		if (!await detectSupportedImageMimeTypeFromFile(absolute)) throw new Error("not a supported image (jpg, png, gif, webp, or bmp)");
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot open image ${absolute}: ${reason}`);
	}
	return absolute;
}

async function readBounded(absolute: string, signal?: AbortSignal): Promise<Uint8Array> {
	const handle = await fs.open(absolute, "r");
	try {
		if (!(await handle.stat()).isFile()) throw new Error("Image is not a regular file");
		const chunks: Buffer[] = [];
		let length = 0;
		while (true) {
			signal?.throwIfAborted();
			const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_LEARNER_IMAGE_BYTES + 1 - length));
			const { bytesRead } = await handle.read(chunk);
			if (!bytesRead) break;
			length += bytesRead;
			if (length > MAX_LEARNER_IMAGE_BYTES) throw new Error("Image exceeds 25 MiB; provide a smaller image");
			chunks.push(chunk.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks, length);
	} finally { await handle.close(); }
}

async function normalize(bytes: Uint8Array, signal?: AbortSignal): Promise<ResizedImage> {
	signal?.throwIfAborted();
	const png = await convertImageBytesToPng(bytes);
	if (!png) throw new Error("Could not decode image");
	signal?.throwIfAborted();
	const result = await resizeImageInProcess(png, "image/png", { maxWidth: 1600, maxHeight: 1600, maxBytes: 1024 * 1024 });
	signal?.throwIfAborted();
	if (!result) throw new Error("Could not shrink image to an embeddable size");
	return result;
}

export async function loadLearnerImage(rawPath: string, signal?: AbortSignal): Promise<LearnerImage> {
	signal?.throwIfAborted();
	const absolute = await checkLearnerImage(rawPath);
	const bytes = await readBounded(absolute, signal);
	const mime = detectSupportedImageMimeType(bytes);
	if (!mime) throw new Error(`Not a supported image: ${absolute}`);
	checkImageDimensions(bytes, mime);
	const stored = await normalize(bytes, signal);
	signal?.throwIfAborted();
	if (stored.mimeType !== "image/png" && stored.mimeType !== "image/jpeg") throw new Error("Unexpected stored image format");
	const snapshotId = createHash("sha256").update(Buffer.from(stored.data, "base64")).digest("hex");
	return { path: absolute, snapshotId, mimeType: stored.mimeType, data: stored.data, width: stored.width, height: stored.height };
}
