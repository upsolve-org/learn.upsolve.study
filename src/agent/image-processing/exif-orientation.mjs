// Pure EXIF orientation metadata reader (ported from
// @earendil-works/pi-coding-agent 1.1.0, MIT). sharp/.rotate() performs the
// actual pixel transform; this reader supplies the oriented source dimensions
// for formats whose EXIF tag libvips does not surface via metadata() (WebP),
// and doubles as a fixture oracle in tests.
function readOrientationFromTiff(bytes, tiffStart) {
    if (tiffStart + 8 > bytes.length)
        return 1;
    const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1];
    const le = byteOrder === 0x4949;
    const read16 = (pos) => {
        if (le)
            return bytes[pos] | (bytes[pos + 1] << 8);
        return (bytes[pos] << 8) | bytes[pos + 1];
    };
    const read32 = (pos) => {
        if (le)
            return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
        return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    };
    const ifdOffset = read32(tiffStart + 4);
    const ifdStart = tiffStart + ifdOffset;
    if (ifdStart + 2 > bytes.length)
        return 1;
    const entryCount = read16(ifdStart);
    for (let i = 0; i < entryCount; i++) {
        const entryPos = ifdStart + 2 + i * 12;
        if (entryPos + 12 > bytes.length)
            return 1;
        if (read16(entryPos) === 0x0112) {
            const value = read16(entryPos + 8);
            return value >= 1 && value <= 8 ? value : 1;
        }
    }
    return 1;
}
function findJpegTiffOffset(bytes) {
    let offset = 2;
    while (offset < bytes.length - 1) {
        if (bytes[offset] !== 0xff)
            return -1;
        const marker = bytes[offset + 1];
        if (marker === 0xff) {
            offset++;
            continue;
        }
        if (marker === 0xe1) {
            if (offset + 4 >= bytes.length)
                return -1;
            const segmentStart = offset + 4;
            if (segmentStart + 6 > bytes.length)
                return -1;
            if (hasExifHeader(bytes, segmentStart))
                return segmentStart + 6;
        }
        if (offset + 4 > bytes.length)
            return -1;
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 2 + length;
    }
    return -1;
}
function findWebpTiffOffset(bytes) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const chunkSize = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
        const dataStart = offset + 8;
        if (chunkId === "EXIF") {
            if (dataStart + chunkSize > bytes.length)
                return -1;
            // Some WebP files have an "Exif\0\0" prefix before the TIFF header.
            return chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
        }
        // RIFF chunks are padded to even size.
        offset = dataStart + chunkSize + (chunkSize % 2);
    }
    return -1;
}
function hasExifHeader(bytes, offset) {
    return (bytes[offset] === 0x45 &&
        bytes[offset + 1] === 0x78 &&
        bytes[offset + 2] === 0x69 &&
        bytes[offset + 3] === 0x66 &&
        bytes[offset + 4] === 0x00 &&
        bytes[offset + 5] === 0x00);
}
export function getExifOrientation(bytes) {
    let tiffOffset = -1;
    // JPEG: starts with FF D8.
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        tiffOffset = findJpegTiffOffset(bytes);
    }
    // WebP: starts with RIFF....WEBP.
    else if (bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50) {
        tiffOffset = findWebpTiffOffset(bytes);
    }
    if (tiffOffset === -1)
        return 1;
    return readOrientationFromTiff(bytes, tiffOffset);
}
