/** Collect SDK cookie writes until the final response has been selected. */
import { serializeCookieHeader } from "@supabase/ssr";

export type CookieWrite = { name: string; value: string; options?: Record<string, unknown> };

export function cookieWrites() {
	const written: CookieWrite[] = [];
	return {
		written,
		setAll(list: CookieWrite[]) { written.push(...list); },
		landOn(_upstream: Response, response: Response): Response {
			// Never copy middleware control headers to redirects, or iterate a
			// Headers object while appending to it. Set-Cookie iteration is live.
			for (const { name, value, options } of written) {
				response.headers.append("set-cookie", serialize(name, value, options));
			}
			response.headers.set("Cache-Control", "private, no-store");
			return response;
		},
	};
}

export function serialize(name: string, value: string, options: Record<string, unknown> = {}): string {
	return serializeCookieHeader(name, value, options);
}
