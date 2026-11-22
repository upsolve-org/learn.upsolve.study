import { getChat, ownerScoped } from "@/src/server";

/** Session-owned snapshots only: never opens a source path or accepts uploaded bytes. */
async function GETHandler(req: Request, { params }: { params: Promise<{ id: string; snapshotId: string }> }) {
	const { id, snapshotId } = await params;
	if (!/^[a-f0-9]{64}$/.test(snapshotId)) return Response.json({ error: "Not found" }, { status: 404 });
	const image = (await getChat(id))?.imageSnapshots?.[snapshotId];
	if (!image) return Response.json({ error: "Not found" }, { status: 404 });

	// `?format=raw` serves the processed bytes for <img>/CSS consumers; the
	// default JSON shape is unchanged for the existing session/export clients.
	if (new URL(req.url).searchParams.get("format") === "raw") {
		const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
		return new Response(bytes, {
			headers: {
				"Content-Type": image.mimeType,
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "private, max-age=31536000, immutable",
			},
		});
	}
	return Response.json(image, { headers: { "Cache-Control": "private, no-store" } });
}

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
