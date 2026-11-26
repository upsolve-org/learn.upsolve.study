import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { quoteFilePath } from "../src/core/file-paths.ts";
import { collectUploadedAttachments, parseUploadedAttachmentPath } from "../src/core/uploaded-attachments.ts";
import { runAsOwner } from "../src/core/owner-scope.ts";
import { readUploadedAttachment, saveUploadedAttachment } from "../src/server/attachments.ts";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lh-attach-viewer-"));
const prevDataDir = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = tmpRoot;

after(async () => {
	if (prevDataDir === undefined) delete process.env.LH_DATA_DIR;
	else process.env.LH_DATA_DIR = prevDataDir;
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("uploaded attachment path parsing & collection", () => {
	it("parses valid /uploads/<uuid>/<filename> paths and rejects invalid or traversal paths", () => {
		const pdf = parseUploadedAttachmentPath("/uploads/12345678-1234-1234-1234-1234567890ab/lecture 1.pdf");
		assert.deepEqual(pdf, {
			path: "/uploads/12345678-1234-1234-1234-1234567890ab/lecture 1.pdf",
			id: "12345678-1234-1234-1234-1234567890ab",
			filename: "lecture 1.pdf",
			kind: "pdf",
			url: "/api/attachments/12345678-1234-1234-1234-1234567890ab/lecture%201.pdf",
		});

		const md = parseUploadedAttachmentPath("/uploads/12345678-1234-1234-1234-1234567890ab/notes.md");
		assert.equal(md?.kind, "text");

		assert.equal(parseUploadedAttachmentPath("/etc/passwd"), null);
		assert.equal(parseUploadedAttachmentPath("/uploads/not-a-uuid/file.pdf"), null);
		assert.equal(parseUploadedAttachmentPath("/uploads/12345678-1234-1234-1234-1234567890ab/.."), null);
		assert.equal(parseUploadedAttachmentPath("/uploads/12345678-1234-1234-1234-1234567890ab/sub/file.pdf"), null);
	});

	it("collects unique uploaded files from quoted message paths in order", () => {
		const id1 = "11111111-1111-1111-1111-111111111111";
		const id2 = "22222222-2222-2222-2222-222222222222";
		const files = collectUploadedAttachments([
			`Study ${quoteFilePath(`/uploads/${id1}/chapter1.pdf`)} and ${quoteFilePath("/tmp/not-an-upload.txt")}`,
			`Also check ${quoteFilePath(`/uploads/${id1}/chapter1.pdf`)} and ${quoteFilePath(`/uploads/${id2}/notes.md`)}`,
		]);
		assert.deepEqual(
			files.map((f) => ({ filename: f.filename, kind: f.kind })),
			[
				{ filename: "chapter1.pdf", kind: "pdf" },
				{ filename: "notes.md", kind: "text" },
			],
		);
	});
});

describe("readUploadedAttachment owner isolation & headers", () => {
	it("reads PDF and text attachments for the owning tenant and blocks cross-tenant reads", async () => {
		const ownerA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
		const ownerB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

		const pdfBytes = new TextEncoder().encode("%PDF-1.4\n%fake\n%%EOF\n");
		const savedPdf = await runAsOwner(ownerA, () =>
			saveUploadedAttachment(new File([pdfBytes], "slides.pdf", { type: "application/pdf" })),
		);
		const savedTxt = await runAsOwner(ownerA, () =>
			saveUploadedAttachment(new File(["# Notes\nHello world"], "notes.md", { type: "text/markdown" })),
		);

		const loadedPdf = await runAsOwner(ownerA, () => readUploadedAttachment(savedPdf.id, savedPdf.filename));
		assert.ok(loadedPdf);
		assert.equal(loadedPdf.kind, "pdf");
		assert.equal(loadedPdf.contentType, "application/pdf");
		assert.equal(loadedPdf.filename, "slides.pdf");

		const loadedTxt = await runAsOwner(ownerA, () => readUploadedAttachment(savedTxt.id, savedTxt.filename));
		assert.ok(loadedTxt);
		assert.equal(loadedTxt.kind, "text");
		assert.equal(loadedTxt.contentType, "text/plain; charset=utf-8");
		assert.equal(new TextDecoder().decode(loadedTxt.bytes), "# Notes\nHello world");

		// Cross-tenant isolation: ownerB cannot read ownerA's attachment
		const crossTenant = await runAsOwner(ownerB, () => readUploadedAttachment(savedPdf.id, savedPdf.filename));
		assert.equal(crossTenant, null);

		// Path traversal rejected
		const traversal = await runAsOwner(ownerA, () => readUploadedAttachment(savedPdf.id, "../slides.pdf"));
		assert.equal(traversal, null);
	});
});
