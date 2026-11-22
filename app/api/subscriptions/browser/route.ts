import { subscriptionBrowserResponse, operatorOnly } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tenancy + operator gate: browser subscription controls are operator-only
// in hosted mode; the body otherwise runs in the caller's owner scope.
export const GET = operatorOnly(subscriptionBrowserResponse);
export const POST = operatorOnly(subscriptionBrowserResponse);
