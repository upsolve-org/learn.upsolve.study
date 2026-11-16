import { pluginTransport, ownerScoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function GETHandler() { return pluginTransport.list(); }
function POSTHandler(request: Request) { return pluginTransport.refresh(request); }

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
export const POST = ownerScoped(POSTHandler);
