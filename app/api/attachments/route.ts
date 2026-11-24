/**
 * POST /api/attachments — owner-scoped web file uploads for the chat composer.
 * Accepts multipart form data (field "files"), caps each file at 15 MiB and
 * the total request at 25 MiB, stores files per-owner with 7-day retention,
 * and returns virtual `/uploads/<uuid>/<name>` paths (+ inline text for small
 * text/Markdown files).
 */
import {
	AttachmentUploadError,
	MAX_ATTACHMENT_REQUEST_BYTES,
	ownerScoped,
	saveUploadedAttachment,
	type SavedAttachment,
} from "@/src/server";
import { FormBodyLimitError, readProxyBoundedFormData } from "@/lib/bounded-form-data.ts";

export const dynamic = "force-dynamic";

async function POSTHandler(request: Request): Promise<Response> {
	let form: FormData;
	try {
		form = await readProxyBoundedFormData(request, MAX_ATTACHMENT_REQUEST_BYTES);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json(
			{
				error: oversized
					? "Upload exceeds the 25 MB request limit. Select fewer or smaller files."
					: "Could not read the upload. Please try selecting the files again.",
			},
			{ status: oversized ? 413 : 400 },
		);
	}

	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ error: "No files provided." }, { status: 400 });
	}
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	if (totalBytes > MAX_ATTACHMENT_REQUEST_BYTES) {
		return Response.json(
			{ error: "Total upload exceeds the 25 MB limit. Select fewer or smaller files." },
			{ status: 413 },
		);
	}

	const attachments: SavedAttachment[] = [];
	try {
		for (const file of files) {
			attachments.push(await saveUploadedAttachment(file));
		}
	} catch (err) {
		if (err instanceof AttachmentUploadError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		return Response.json({ error: "Failed to save attachment." }, { status: 500 });
	}

	return Response.json({ attachments }, { headers: { "Cache-Control": "no-store" } });
}

export const POST = ownerScoped(POSTHandler);
