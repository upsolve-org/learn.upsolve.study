import { subscriptionControlsResponse, operatorOnly } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tenancy + operator gate: web subscription controls are operator-only in
// hosted mode; the body otherwise runs in the caller's owner scope.
export const GET = operatorOnly(subscriptionControlsResponse);
export const POST = operatorOnly(subscriptionControlsResponse);
