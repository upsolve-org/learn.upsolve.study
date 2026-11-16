import { subscriptionBrowserResponse, ownerScoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(subscriptionBrowserResponse);
export const POST = ownerScoped(subscriptionBrowserResponse);
