import { pluginTransport, ownerScoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
	return pluginTransport.call((await context.params).id, request);
}

// Tenancy: the body runs inside the caller's owner scope.
export const POST = ownerScoped(POSTHandler);
