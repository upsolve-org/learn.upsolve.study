/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { customProviderGet, customProviderMutation, ownerScoped } from "@/src/server";

export const dynamic = "force-dynamic";

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(customProviderGet);
export const POST = ownerScoped(customProviderMutation);
export const PATCH = ownerScoped(customProviderMutation);
export const DELETE = ownerScoped(customProviderMutation);
