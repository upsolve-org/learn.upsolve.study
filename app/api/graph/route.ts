import { graphView, ownerScoped } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns nodes, edges,
 * session provenance, and per-session understanding observations.
 */

export const dynamic = "force-dynamic";

async function GETHandler() {
	return Response.json(await graphView());
}

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
