import { pluginTransport, operatorOnly } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function PUTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
	return pluginTransport.setEnabled((await context.params).id, request);
}

// Tenancy + operator gate: enabling/disabling a plugin is an operator
// capability in hosted mode; the body otherwise runs in the caller's scope.
export const PUT = operatorOnly(PUTHandler);
