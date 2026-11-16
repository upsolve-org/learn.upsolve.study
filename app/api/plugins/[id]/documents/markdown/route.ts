import { createPluginDocumentRoute, pluginTransport, ownerScoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This exact route skips Proxy body cloning, NOT desktop authentication.
const handlers = createPluginDocumentRoute(pluginTransport);
// Tenancy: the route bypasses the Proxy, so it enters the owner scope here —
// the same reason it re-enforces the request policy inside its own handler.
export const POST = ownerScoped(handlers.POST);
export const OPTIONS = handlers.OPTIONS;
export const GET = ownerScoped(handlers.GET);
export const HEAD = ownerScoped(handlers.HEAD);
export const PUT = ownerScoped(handlers.PUT);
export const PATCH = ownerScoped(handlers.PATCH);
export const DELETE = ownerScoped(handlers.DELETE);