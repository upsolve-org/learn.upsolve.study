import { ownerScoped, readUploadedBlob } from "@/src/server";

/** Owner-scoped uploaded file byte stream. The id is an opaque server-minted UUID. */
async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const blob = await readUploadedBlob(id);
	if (!blob) return Response.json({ error: "Not found" }, { status: 404 });
	return new Response(new Uint8Array(blob.body), {
		headers: {
			"Content-Type": blob.contentType,
			"Content-Length": String(blob.contentLength),
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-store",
		},
	});
}

export const GET = ownerScoped(GETHandler);
