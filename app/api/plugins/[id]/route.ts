import { pluginTransport, ownerScoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function PUTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
	return pluginTransport.setEnabled((await context.params).id, request);
}

// Tenancy: the body runs inside the caller's owner scope.
export const PUT = ownerScoped(PUTHandler);
