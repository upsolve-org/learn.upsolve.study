import { createPluginDocumentRoute, pluginTransport } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This exact route skips Proxy body cloning, NOT desktop authentication.
// Tenancy: because it bypasses the Proxy, a client-supplied x-lh-owner header
// is never overwritten here — so the handlers derive the owner scope from the
// VERIFIED session themselves (createPluginDocumentRoute), not from the header.
const handlers = createPluginDocumentRoute(pluginTransport);
export const POST = handlers.POST;
export const OPTIONS = handlers.OPTIONS;
export const GET = handlers.GET;
export const HEAD = handlers.HEAD;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
