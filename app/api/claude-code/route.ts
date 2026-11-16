import { claudeCodeInstallationResponse, ownerScoped } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request. */
async function GETHandler(request: Request) {
	return claudeCodeInstallationResponse(request);
}

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
