/**
 * Local batch transcription for the Parakeet STT gateway. The renderer
 * captures PCM in the same AudioWorklet as Deepgram dictation, wraps it in a
 * WAV, and posts it here; the real gateway address stays server-side. The
 * gateway exposes an OpenAI-compatible /v1/audio/transcriptions endpoint.
 */
import { ownerScoped, sttGatewayModel, sttGatewayUrl } from "@/src/server";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

async function POSTHandler(request: Request): Promise<Response> {
	const gateway = sttGatewayUrl();
	if (!gateway) {
		return Response.json({ message: "Local STT gateway is not configured." }, { status: 503 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return Response.json({ message: "Invalid multipart upload" }, { status: 400 });
	}
	const file = form.get("file");
	if (!(file instanceof Blob)) {
		return Response.json({ message: "Missing audio file" }, { status: 400 });
	}
	if (file.size > MAX_AUDIO_BYTES) {
		return Response.json({ message: "Audio file exceeds 25 MiB" }, { status: 413 });
	}

	const language = form.get("language");
	const forward = new FormData();
	// Keep the original filename (e.g. dictation.wav); gateways commonly key
	// their decoding/extension handling off it.
	forward.append("file", file, file instanceof File ? file.name : "dictation.wav");
	forward.append("model", sttGatewayModel());
	if (typeof language === "string" && language.trim() && language !== "multi") {
		forward.append("language", language);
	}

	try {
		const res = await fetch(`${gateway}/v1/audio/transcriptions`, {
			method: "POST",
			body: forward,
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) {
			const detail = await res.text();
			return Response.json(
				{ message: `Local STT gateway failed (${res.status}): ${detail.slice(0, 200)}` },
				{ status: 502 },
			);
		}
		const data = (await res.json()) as { text?: unknown };
		return Response.json({ text: typeof data.text === "string" ? data.text.trim() : "" });
	} catch {
		return Response.json({ message: "Local STT gateway unreachable" }, { status: 502 });
	}
}

// Tenancy: the body runs inside the caller's owner scope.
export const POST = ownerScoped(POSTHandler);
