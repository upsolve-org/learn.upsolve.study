/**
 * Better Auth's catch-all handler (sign-in, sign-out, sessions, OAuth
 * callbacks). Public by design: the Proxy lets /api/auth/* through so an
 * unauthenticated learner can actually sign in. With HOSTED_MODE off there
 * are no accounts and the endpoints do not exist.
 */
import { hostedMode } from "@/src/core";
import { getAuth, toNextJsHandler } from "@/src/server";

function notFound(): Response {
	return Response.json({ error: "Not found." }, { status: 404 });
}

export async function GET(request: Request): Promise<Response> {
	if (!hostedMode()) return notFound();
	return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
	if (!hostedMode()) return notFound();
	return toNextJsHandler(getAuth()).POST(request);
}
