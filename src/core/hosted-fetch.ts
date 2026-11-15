/** Server transport only. Keep the public URL for SDK cookie names and OAuth. */
export function hostedFetch(publicUrl: string, internalUrl = process.env.SUPABASE_INTERNAL_URL, transport: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const publicBase = new URL(publicUrl);
		if (internalUrl && url.origin === publicBase.origin) {
			const internal = new URL(internalUrl);
			url.protocol = internal.protocol;
			url.host = internal.host;
		}
		const request = input instanceof Request ? new Request(url, input) : url;
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		return transport(request, {
			...init,
			// Auth APIs should not redirect into app pages. Fail instead of
			// recursively rendering login if ingress is misconfigured.
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
		});
	};
}
