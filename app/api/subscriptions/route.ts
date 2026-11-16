import { subscriptionControlsResponse, ownerScoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(subscriptionControlsResponse);
export const POST = ownerScoped(subscriptionControlsResponse);
