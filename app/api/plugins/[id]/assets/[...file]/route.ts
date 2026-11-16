import { pluginTransport, ownerScoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function GETHandler(_request: Request, context: { params: Promise<{ id: string; file: string[] }> }) {
	const { id, file } = await context.params;
	return pluginTransport.asset(id, file);
}

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
