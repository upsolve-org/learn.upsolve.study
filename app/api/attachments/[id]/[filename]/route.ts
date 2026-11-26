/**
 * GET /api/attachments/[id]/[filename] — owner-scoped inline reader for
 * uploaded web attachments (PDFs and text/Markdown files) used by the
 * right-side split file viewer in chat sessions.
 */
import { ownerScoped, readUploadedAttachment } from "@/src/server";

export const dynamic = "force-dynamic";

function safeDispositionFilename(name: string): string {
	return name.replace(/["\\\r\n]/g, "_");
}

async function GETHandler(
	_request: Request,
	ctx: { params: Promise<{ id: string; filename: string }> },
): Promise<Response> {
	const { id, filename } = await ctx.params;
	const decodedName = (() => {
		try {
			return decodeURIComponent(filename);
		} catch {
			return filename;
		}
	})();
	const file = await readUploadedAttachment(id, decodedName);
	if (!file) {
		return Response.json(
			{ error: "Attachment not found or expired." },
			{ status: 404, headers: { "Cache-Control": "no-store" } },
		);
	}
	return new Response(new Uint8Array(file.bytes), {
		status: 200,
		headers: {
			"Content-Type": file.contentType,
			"Content-Disposition": `inline; filename="${safeDispositionFilename(file.filename)}"`,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export const GET = ownerScoped(GETHandler);
