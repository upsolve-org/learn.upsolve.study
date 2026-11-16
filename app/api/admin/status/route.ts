import { isOperator } from "@/src/core";
import { currentAccountEmail } from "@/src/server";

export const dynamic = "force-dynamic";

/** Is the signed-in account the operator? Drives the sidebar entry only; the
 *  page and the actions re-check independently. */
export async function GET() {
	return Response.json({ operator: isOperator(await currentAccountEmail()) }, { headers: { "Cache-Control": "no-store" } });
}