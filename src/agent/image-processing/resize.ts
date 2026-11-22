// Ported from @earendil-works/pi-coding-agent 1.1.0, dist/utils/image-resize.js (MIT).
// sharp performs resizing off the JS event loop on libuv's thread pool, so
// there is no worker to spawn (and no cwd-relative .mjs to trace).
import { resizeImageInProcess } from "./resize-core.mjs";
import type { ModelImageResizeOptions, ResizedImage } from "./types.ts";

export async function resizeImage(inputBytes: Uint8Array, mimeType: string, options?: ModelImageResizeOptions): Promise<ResizedImage | null> {
	return resizeImageInProcess(inputBytes, mimeType, options);
}

export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) return undefined;
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
