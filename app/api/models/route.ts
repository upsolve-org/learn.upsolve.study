import { modelCatalog, refreshConnectionCatalog, ownerScoped } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Static
 * catalog: no network, stable within a pi-ai version.
 */
async function GETHandler() {
	await refreshConnectionCatalog();
	return Response.json(await modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
