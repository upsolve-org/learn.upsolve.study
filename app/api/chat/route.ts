import { handleChatRequest, ownerScoped } from "@/src/server";

async function POSTHandler(req: Request) {
	return handleChatRequest(req);
}

// Tenancy: the body runs inside the caller's owner scope.
export const POST = ownerScoped(POSTHandler);
