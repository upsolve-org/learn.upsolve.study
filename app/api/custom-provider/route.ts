/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { customProviderGet, customProviderMutation, operatorOnly, ownerScoped } from "@/src/server";

export const dynamic = "force-dynamic";

// Tenancy: the body runs inside the caller's owner scope.
// GET stays learner-readable (it exposes the hostedDefault catalog entry);
// every mutation is an operator capability in hosted mode.
export const GET = ownerScoped(customProviderGet);
export const POST = operatorOnly(customProviderMutation);
export const PATCH = operatorOnly(customProviderMutation);
export const DELETE = operatorOnly(customProviderMutation);
