import type { ModelImageResizeOptions, ResizedImage } from "./types.ts";
export function resizeImageInProcess(inputBytes: Uint8Array, mimeType: string, options?: ModelImageResizeOptions): Promise<ResizedImage | null>;
