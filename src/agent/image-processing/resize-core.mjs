// Image resizing via native sharp (libvips). sharp runs decode/encode/resize
// on libuv's thread pool, so no per-image node:worker_threads spawning is
// needed. Read EXIF orientation from the metadata for the oriented source
// dimensions (sharp reports raw width/height before .rotate()). For WebP,
// libvips does not expose the EXIF tag through metadata(), so fall back to
// the small pure-JS reader (both "Exif\0\0"-prefixed and bare TIFF layouts).
import sharp from "sharp";
import { getExifOrientation } from "./exif-orientation.mjs";

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;
const DEFAULT_OPTIONS = {
    maxWidth: 2000,
    maxHeight: 2000,
    maxBytes: DEFAULT_MAX_BYTES,
    jpegQuality: 80,
};
function encodeCandidate(buffer, mimeType) {
    const data = Buffer.from(buffer).toString("base64");
    return {
        data,
        encodedSize: Buffer.byteLength(data, "utf-8"),
        mimeType,
    };
}
/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try PNG first, then JPEG qualities in insertion order (first under cap wins)
 * 3. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImageInProcess(inputBytes, mimeType, options) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
    try {
        const metadata = await sharp(inputBytes).metadata();
        let originalWidth = metadata.width;
        let originalHeight = metadata.height;
        if (!(originalWidth > 0) || !(originalHeight > 0)) return null;
        const orientation = metadata.orientation ?? getExifOrientation(inputBytes);
        // sharp reports width/height BEFORE rotation; transposing orientations
        // swap the oriented source dimensions.
        if (orientation >= 5 && orientation <= 8) {
            const swapped = originalWidth;
            originalWidth = originalHeight;
            originalHeight = swapped;
        }
        const format = mimeType.split("/")[1] ?? "png";
        // Check if already within all limits (dimensions AND encoded size).
        if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
            return {
                data: Buffer.from(inputBytes).toString("base64"),
                mimeType: mimeType || `image/${format}`,
                originalWidth,
                originalHeight,
                width: originalWidth,
                height: originalHeight,
                wasResized: false,
            };
        }
        // Calculate initial dimensions respecting max limits (sequential rounding).
        let targetWidth = originalWidth;
        let targetHeight = originalHeight;
        if (targetWidth > opts.maxWidth) {
            targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
            targetWidth = opts.maxWidth;
        }
        if (targetHeight > opts.maxHeight) {
            targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
            targetHeight = opts.maxHeight;
        }
        const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
        let currentWidth = targetWidth;
        let currentHeight = targetHeight;
        while (true) {
            try {
                const base = sharp(inputBytes).rotate().resize(currentWidth, currentHeight, {
                    fit: "fill",
                    kernel: sharp.kernel.lanczos3,
                });
                const pngCandidate = encodeCandidate(await base.clone().png().toBuffer(), "image/png");
                if (pngCandidate.encodedSize < opts.maxBytes) {
                    return {
                        data: pngCandidate.data,
                        mimeType: pngCandidate.mimeType,
                        originalWidth,
                        originalHeight,
                        width: currentWidth,
                        height: currentHeight,
                        wasResized: true,
                    };
                }
                for (const quality of qualitySteps) {
                    const candidate = encodeCandidate(await base.clone().jpeg({ quality }).toBuffer(), "image/jpeg");
                    if (candidate.encodedSize < opts.maxBytes) {
                        return {
                            data: candidate.data,
                            mimeType: candidate.mimeType,
                            originalWidth,
                            originalHeight,
                            width: currentWidth,
                            height: currentHeight,
                            wasResized: true,
                        };
                    }
                }
            } catch {
                return null;
            }
            if (currentWidth === 1 && currentHeight === 1) break;
            const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
            const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
            if (nextWidth === currentWidth && nextHeight === currentHeight) break;
            currentWidth = nextWidth;
            currentHeight = nextHeight;
        }
        return null;
    } catch {
        return null;
    }
}
