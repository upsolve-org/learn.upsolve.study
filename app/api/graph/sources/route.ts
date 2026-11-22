import { deleteSources, readOrganizationAction, sourceDirectory, SourceDeletionError, SourceOrganizationInputError, ownerScoped } from "@/src/server";
import { emit } from "@/src/core";

export const dynamic = "force-dynamic";

async function GETHandler() {
	try { return Response.json(await sourceDirectory.read()); }
	catch { return Response.json({ error: "Could not read source organization." }, { status: 500 }); }
}

async function DELETEHandler(request: Request) {
	try { return Response.json(await deleteSources(await readOrganizationAction(request))); }
	catch (error) {
		if (error instanceof SourceDeletionError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
		if (error instanceof SourceOrganizationInputError) return Response.json({ error: error.message }, { status: 400 });
		return Response.json({ error: "Could not finish source deletion. Some entries may already have been removed; refresh or retry." }, { status: 500 });
	} finally {
		emit("sources-changed", {}); emit("chats-changed", {}); emit("activity-changed", {});
	}
}

async function POSTHandler(request: Request) {
	try { return Response.json(await sourceDirectory.change(await readOrganizationAction(request))); }
	catch (error) {
		const input = error instanceof SourceOrganizationInputError;
		return Response.json({ error: input ? error.message : "Could not save source organization." }, { status: input ? 400 : 500 });
	}
}

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
export const DELETE = ownerScoped(DELETEHandler);
export const POST = ownerScoped(POSTHandler);
