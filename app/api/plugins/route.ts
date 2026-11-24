import { pluginTransport, operatorOnly, ownerScoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function GETHandler() { return pluginTransport.list(); }
function POSTHandler(request: Request) { return pluginTransport.refresh(request); }

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
// Installing/refreshing plugins is an operator capability in hosted mode.
export const POST = operatorOnly(POSTHandler);
