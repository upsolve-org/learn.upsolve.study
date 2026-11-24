/**
 * Speech-to-text backend selection. A local Parakeet gateway (the stt-gateway
 * sidecar on 127.0.0.1:8792) takes priority over Deepgram when configured, so
 * the renderer can switch from streaming WebSocket dictation to local batch
 * transcription without a build-time flag.
 */

export function sttGatewayUrl(env: Record<string, string | undefined> = process.env): string | null {
	const value = env.STT_GATEWAY_URL?.trim();
	if (!value) return null;
	const url = value.replace(/\/+$/, "");
	return url.length > 0 ? url : null;
}

export function sttGatewayModel(env: Record<string, string | undefined> = process.env): string {
	return env.STT_GATEWAY_MODEL?.trim() || "parakeet-tdt-0.6b-v2";
}

export function sttMode(env: Record<string, string | undefined> = process.env): "local" | "deepgram" | "unconfigured" {
	if (sttGatewayUrl(env)) return "local";
	if (env.DEEPGRAM_API_KEY?.trim()) return "deepgram";
	return "unconfigured";
}
