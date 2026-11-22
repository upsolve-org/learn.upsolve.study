// Image conversion via native sharp (libvips runs off the JS event loop on
// libuv's thread pool). libvips does not decode uncompressed Windows BMPs by
// default, so those are decoded to raw RGBA by a small pure-JS reader first.
import sharp from "sharp";

/** Decode an uncompressed 24/32-bit Windows BMP into raw RGBA pixels. */
function decodeBmpToRgba(bytes) {
    if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null; // "BM"
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pixelOffset = view.getUint32(10, true);
    const dibSize = view.getUint32(14, true);
    if (dibSize < 40 || pixelOffset < 54 || pixelOffset > bytes.length) return null;
    const width = view.getInt32(18, true);
    const rawHeight = view.getInt32(22, true);
    const planes = view.getUint16(26, true);
    const bitsPerPixel = view.getUint16(28, true);
    const compression = view.getUint32(30, true);
    const height = Math.abs(rawHeight);
    if (!(width > 0) || !(height > 0) || planes !== 1 || compression !== 0) return null;
    if (bitsPerPixel !== 24 && bitsPerPixel !== 32) return null;
    if (width > 100_000 || height > 100_000) return null;
    const rowSize = Math.floor((width * bitsPerPixel + 31) / 32) * 4;
    if (pixelOffset + rowSize * height > bytes.length) return null;

    const rgba = new Uint8Array(width * height * 4);
    const bytesPerPixel = bitsPerPixel / 8;
    for (let y = 0; y < height; y++) {
        // Positive height = bottom-up rows in the file; negative = top-down.
        const fileRow = rawHeight > 0 ? height - 1 - y : y;
        const rowStart = pixelOffset + fileRow * rowSize;
        for (let x = 0; x < width; x++) {
            const src = rowStart + x * bytesPerPixel;
            const dst = (y * width + x) * 4;
            rgba[dst] = bytes[src + 2];
            rgba[dst + 1] = bytes[src + 1];
            rgba[dst + 2] = bytes[src];
            rgba[dst + 3] = 255;
        }
    }
    return { rgba, width, height };
}

export async function convertImageBytesToPng(bytes) {
    try {
        if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
            const decoded = decodeBmpToRgba(bytes);
            if (!decoded) return null;
            const png = await sharp(decoded.rgba, {
                raw: { width: decoded.width, height: decoded.height, channels: 4 },
            }).png().toBuffer();
            return new Uint8Array(png);
        }
        // .rotate() applies EXIF orientation, baking it into the PNG output.
        const png = await sharp(bytes).rotate().png().toBuffer();
        return new Uint8Array(png);
    } catch {
        return null;
    }
}
