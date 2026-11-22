/**
 * S3 / RustFS BlobStore adapter (PR 6). RustFS speaks the S3 API, so this is
 * plain AWS SDK v3 with `forcePathStyle: true` (RustFS is addressed by its
 * endpoint, not by virtual-hosted bucket DNS). Not-found responses map to
 * `null`/no-op, matching the fs adapter's ENOENT semantics.
 */

import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import type { BlobHead, BlobObject, BlobStore } from "../core/ports.ts";
import { validateBlobKey } from "./blobs-key.ts";

export interface S3BlobConfig {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
}

type Env = Record<string, string | undefined>;
const CONFIG_KEYS = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

/** All four connection variables must be present and non-blank. */
export function s3BlobConfigured(env: Env = process.env): boolean {
	return CONFIG_KEYS.every((key) => Boolean(env[key]?.trim()));
}

/** Read a resolved config (S3_REGION defaults to us-east-1). Throws when incomplete. */
export function readS3BlobConfig(env: Env = process.env): S3BlobConfig {
	const missing = CONFIG_KEYS.filter((key) => !env[key]?.trim());
	if (missing.length > 0) throw new Error(`Missing S3 configuration: ${missing.join(", ")}`);
	return {
		endpoint: env.S3_ENDPOINT!.trim(),
		bucket: env.S3_BUCKET!.trim(),
		accessKeyId: env.S3_ACCESS_KEY_ID!.trim(),
		secretAccessKey: env.S3_SECRET_ACCESS_KEY!.trim(),
		region: env.S3_REGION?.trim() || "us-east-1",
	};
}

/** AWS SDK v3 may return a streaming body, a Buffer, or an async iterable (tests). */
async function bodyToBytes(body: unknown): Promise<Uint8Array> {
	if (body == null) return new Uint8Array(0);
	const candidate = body as {
		transformToByteArray?: () => Promise<Uint8Array>;
		[Symbol.asyncIterator]?: () => AsyncIterable<Uint8Array>;
	};
	if (typeof candidate.transformToByteArray === "function") {
		return candidate.transformToByteArray();
	}
	if (body instanceof Uint8Array) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (typeof candidate[Symbol.asyncIterator] === "function") {
		const chunks: Uint8Array[] = [];
		for await (const chunk of candidate as unknown as AsyncIterable<Uint8Array>) {
			chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
		}
		const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
		return out;
	}
	throw new Error("Unsupported S3 response body");
}

/** 404 / NoSuchKey / NotFound from any layer of the SDK means "no object". */
function isNotFound(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as {
		name?: string;
		Code?: string;
		code?: string;
		$metadata?: { httpStatusCode?: number };
	};
	return candidate.$metadata?.httpStatusCode === 404
		|| candidate.name === "NoSuchKey"
		|| candidate.name === "NotFound"
		|| candidate.Code === "NoSuchKey"
		|| candidate.Code === "NotFound"
		|| candidate.code === "NoSuchKey"
		|| candidate.code === "NotFound";
}

/**
 * Create the adapter. `clientOverride` is the test seam: anything with a
 * compatible `send` can stand in for the real S3Client.
 */
export function createS3BlobStore(
	config?: S3BlobConfig,
	clientOverride?: Pick<S3Client, "send">,
): BlobStore {
	const cfg = config ?? readS3BlobConfig();
	const client = clientOverride ?? new S3Client({
		endpoint: cfg.endpoint,
		region: cfg.region,
		forcePathStyle: true,
		credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
	});
	const Bucket = cfg.bucket;
	const keyOf = (key: string): string => validateBlobKey(key);

	return {
		async put(key, body, contentType) {
			await client.send(new PutObjectCommand({
				Bucket,
				Key: keyOf(key),
				Body: body,
				ContentType: contentType,
				ContentLength: body.byteLength,
			}));
		},

		async get(key): Promise<BlobObject | null> {
			try {
				const out = await client.send(new GetObjectCommand({ Bucket, Key: keyOf(key) }));
				const body = await bodyToBytes(out.Body);
				return {
					body,
					contentType: out.ContentType ?? "application/octet-stream",
					contentLength: out.ContentLength ?? body.byteLength,
				};
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},

		async head(key): Promise<BlobHead | null> {
			try {
				const out = await client.send(new HeadObjectCommand({ Bucket, Key: keyOf(key) }));
				return {
					contentType: out.ContentType ?? "application/octet-stream",
					contentLength: out.ContentLength ?? 0,
				};
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},

		async delete(key): Promise<void> {
			try {
				await client.send(new DeleteObjectCommand({ Bucket, Key: keyOf(key) }));
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		},
	};
}
