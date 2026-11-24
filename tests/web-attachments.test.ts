/**
 * Web composer attachment uploads (POST /api/attachments):
 *   - Saves PDFs per-owner and resolves `/uploads/<uuid>/<name>` strictly
 *     within the owning tenant's directory.
 *   - Returns inlineText for small text/Markdown files (<= 64 KiB).
 *   - Enforces the 15 MiB per-file size limit and rejects unsupported binaries.
 *   - Automatically expires and deletes attachments older than 7 days.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-web-attachments-"));
process.env.LH_DATA_DIR = dataDir;

const { runAsOwner } = await import("../src/core/owner-scope.ts");
const {
	ATTACHMENT_TTL_MS,
	MAX_ATTACHMENT_BYTES,
	AttachmentUploadError,
	purgeExpiredAttachments,
	resolveUploadedAttachmentPath,
	saveUploadedAttachment,
} = await import("../src/server/attachments.ts");
const { POST } = await import("../app/api/attachments/route.ts");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

after(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("web composer attachments", () => {
	it("saves a PDF per-owner and isolates resolution across owners", async () => {
		const pdf = new File(["%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"], "lecture 1.pdf", { type: "application/pdf" });
		const saved = await runAsOwner(OWNER_A, () => saveUploadedAttachment(pdf));

		assert.equal(saved.kind, "pdf");
		assert.equal(saved.filename, "lecture 1.pdf");
		assert.equal(saved.inlineText, undefined);
		assert.match(saved.virtualPath, /^\/uploads\/[0-9a-f-]{36}\/lecture 1\.pdf$/);

		const resolvedA = await runAsOwner(OWNER_A, () => resolveUploadedAttachmentPath(saved.virtualPath));
		assert.ok(resolvedA && fs.existsSync(resolvedA), "owning tenant resolves its uploaded PDF");

		const resolvedB = await runAsOwner(OWNER_B, () => resolveUploadedAttachmentPath(saved.virtualPath));
		assert.equal(resolvedB, null, "another tenant cannot resolve Owner A's uploaded PDF");

		// Traversal attempts must return null.
		assert.equal(await runAsOwner(OWNER_A, () => resolveUploadedAttachmentPath("/uploads/../settings.json")), null);
	});

	it("returns inlineText for small text/Markdown files", async () => {
		const md = new File(["# Notes\nHello world"], "notes.md", { type: "text/markdown" });
		const saved = await runAsOwner(OWNER_A, () => saveUploadedAttachment(md));
		assert.equal(saved.kind, "text");
		assert.equal(saved.inlineText, "# Notes\nHello world");
	});

	it("rejects files larger than 15 MiB and non-PDF binary files", async () => {
		const oversized = new File([new Uint8Array(1)], "big.pdf", { type: "application/pdf" });
		Object.defineProperty(oversized, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
		await assert.rejects(
			() => runAsOwner(OWNER_A, () => saveUploadedAttachment(oversized)),
			(err: unknown) => err instanceof AttachmentUploadError && err.status === 413,
		);

		const binary = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "malware.bin", { type: "application/octet-stream" });
		await assert.rejects(
			() => runAsOwner(OWNER_A, () => saveUploadedAttachment(binary)),
			(err: unknown) => err instanceof AttachmentUploadError && err.status === 415,
		);
	});

	it("expires and deletes attachments older than 7 days", async () => {
		const now = Date.now();
		const pdf = new File(["%PDF-1.7\n"], "old.pdf", { type: "application/pdf" });
		const saved = await runAsOwner(OWNER_A, () => saveUploadedAttachment(pdf, now));
		const resolvedNow = await runAsOwner(OWNER_A, () => resolveUploadedAttachmentPath(saved.virtualPath, now));
		assert.ok(resolvedNow && fs.existsSync(resolvedNow));

		// 8 days later: resolveUploadedAttachmentPath rejects and removes it.
		const eightDaysLater = now + ATTACHMENT_TTL_MS + 24 * 60 * 60 * 1000;
		const resolvedLater = await runAsOwner(OWNER_A, () => resolveUploadedAttachmentPath(saved.virtualPath, eightDaysLater));
		assert.equal(resolvedLater, null);
		assert.equal(fs.existsSync(resolvedNow), false);

		// Also verify purgeExpiredAttachments sweeps old upload directories.
		const pdf2 = new File(["%PDF-1.7\n"], "sweep.pdf", { type: "application/pdf" });
		const saved2 = await runAsOwner(OWNER_A, () => saveUploadedAttachment(pdf2, now));
		const resolved2 = await runAsOwner(OWNER_A, () => resolveUploadedAttachmentPath(saved2.virtualPath, now));
		assert.ok(resolved2 && fs.existsSync(resolved2));
		const removed = await runAsOwner(OWNER_A, () => purgeExpiredAttachments(eightDaysLater));
		assert.ok(removed >= 1);
		assert.equal(fs.existsSync(resolved2), false);
	});

	it("POST /api/attachments handles multipart uploads and returns attachments", async () => {
		const form = new FormData();
		form.append("files", new File(["%PDF-1.7\n"], "hw.pdf", { type: "application/pdf" }), "hw.pdf");
		const response = await POST(new Request("http://localhost/api/attachments", { method: "POST", body: form }));
		assert.equal(response.status, 200);
		const body = (await response.json()) as { attachments: Array<{ kind: string; filename: string; virtualPath: string }> };
		assert.equal(body.attachments.length, 1);
		assert.equal(body.attachments[0]!.kind, "pdf");
		assert.equal(body.attachments[0]!.filename, "hw.pdf");
		assert.match(body.attachments[0]!.virtualPath, /^\/uploads\/[0-9a-f-]{36}\/hw\.pdf$/);
	});
});
