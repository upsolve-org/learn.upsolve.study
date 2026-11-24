import { claudeCodeInstallationResponse, operatorOnly } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request. */
async function GETHandler(request: Request) {
	return claudeCodeInstallationResponse(request);
}

// Tenancy + operator gate: installation/version details are operator-only
// in hosted mode; the body otherwise runs in the caller's owner scope.
export const GET = operatorOnly(GETHandler);
