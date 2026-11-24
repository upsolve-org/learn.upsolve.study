import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { encodePcm16Wav } from "../components/dictation.tsx";
import { realHeadless, resolveChromeWsEndpoint } from "../src/agent/subagents/headless.ts";
import { sttGatewayModel, sttGatewayUrl, sttMode } from "../src/server/stt.ts";

const savedEnv = { ...process.env };
afterEach(() => {
	process.env = { ...savedEnv };
});

describe("sandboxed Chromium endpoint", () => {
	it("accepts ws:// and wss:// (trimmed) and rejects everything else", () => {
		assert.equal(resolveChromeWsEndpoint({ CHROME_WS_ENDPOINT: "  ws://127.0.0.1:3003  " }), "ws://127.0.0.1:3003");
		assert.equal(resolveChromeWsEndpoint({ CHROME_WS_ENDPOINT: "wss://chrome.example/cdp" }), "wss://chrome.example/cdp");
		for (const value of [undefined, "", "   ", "http://127.0.0.1:3003", "127.0.0.1:3003", "//ws://x"]) {
			assert.equal(resolveChromeWsEndpoint({ CHROME_WS_ENDPOINT: value }), null, String(value));
		}
		assert.equal(resolveChromeWsEndpoint({}), null);
	});

	it("marks the real helper available when CHROME_WS_ENDPOINT is set", () => {
		process.env.CHROME_WS_ENDPOINT = "ws://127.0.0.1:3003";
		assert.equal(realHeadless.available(), true);
		assert.equal(realHeadless.unavailableReason(), null);
	});
});

describe("local STT configuration", () => {
	it("normalizes the gateway URL and picks the default Parakeet model", () => {
		assert.equal(sttGatewayUrl({ STT_GATEWAY_URL: "  http://127.0.0.1:8792///  " }), "http://127.0.0.1:8792");
		assert.equal(sttGatewayUrl({ STT_GATEWAY_URL: "   " }), null);
		assert.equal(sttGatewayUrl({}), null);
		assert.equal(sttGatewayModel({}), "parakeet-tdt-0.6b-v2");
		assert.equal(sttGatewayModel({ STT_GATEWAY_MODEL: "  custom-model  " }), "custom-model");
	});

	it("selects local over Deepgram and reports unconfigured when neither is set", () => {
		assert.equal(sttMode({ STT_GATEWAY_URL: "http://127.0.0.1:8792", DEEPGRAM_API_KEY: "key" }), "local");
		assert.equal(sttMode({ DEEPGRAM_API_KEY: "key" }), "deepgram");
		assert.equal(sttMode({}), "unconfigured");
	});

	it("GET /api/stt/token reports local mode when the gateway is configured", async () => {
		process.env.STT_GATEWAY_URL = "http://127.0.0.1:8792";
		const { GET } = await import("../app/api/stt/token/route.ts");
		const response = await GET();
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { mode: "local" });
	});
});

describe("POST /api/stt/transcribe", () => {
	async function withGateway<T>(handler: (base: string, received: () => { fields: Record<string, string>; fileName: string | null; bytes: Buffer }) => Promise<T>): Promise<T> {
		const received: { fields: Record<string, string>; fileName: string | null; bytes: Buffer } = { fields: {}, fileName: null, bytes: Buffer.alloc(0) };
		const server = http.createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const request = new Request(`http://127.0.0.1${req.url}`, {
				method: "POST",
				headers: { "content-type": req.headers["content-type"] ?? "application/octet-stream" },
				body: Buffer.concat(chunks),
			});
			const form = await request.formData();
			for (const [key, value] of form.entries()) {
				if (typeof value === "string") received.fields[key] = value;
				else {
					received.fileName = (value as File).name;
					received.bytes = Buffer.from(await (value as Blob).arrayBuffer());
				}
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ text: "  hello from parakeet  " }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		try {
			return await handler(`http://127.0.0.1:${address.port}`, () => received);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	}

	it("forwards the multipart WAV with model + filename and returns trimmed text", async () => {
		await withGateway(async (base, received) => {
			process.env.STT_GATEWAY_URL = `${base}///`;
			process.env.STT_GATEWAY_MODEL = "parakeet-tdt-0.6b-v2";
			const { POST } = await import("../app/api/stt/transcribe/route.ts");
			const pcm = Uint8Array.from([1, 2, 3, 4]).buffer;
			const form = new FormData();
			form.append("file", new Blob([pcm], { type: "audio/wav" }), "dictation.wav");
			form.append("language", "pl");
			const response = await POST(new Request("http://localhost/api/stt/transcribe", { method: "POST", body: form }));
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { text: "hello from parakeet" });
			const data = received();
			assert.equal(data.fields.model, "parakeet-tdt-0.6b-v2");
			assert.equal(data.fields.language, "pl");
			assert.equal(data.fileName, "dictation.wav");
			assert.deepEqual(Array.from(data.bytes), [1, 2, 3, 4]);
		});
	});

	it("omits the language field for 'multi' and other falsy values", async () => {
		await withGateway(async (base, received) => {
			process.env.STT_GATEWAY_URL = base;
			const { POST } = await import("../app/api/stt/transcribe/route.ts");
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array(2)]), "dictation.wav");
			form.append("language", "multi");
			const response = await POST(new Request("http://localhost/api/stt/transcribe", { method: "POST", body: form }));
			assert.equal(response.status, 200);
			assert.equal(received().fields.language, undefined);
		});
	});

	it("returns 503 when unconfigured and 400 when the file is missing", async () => {
		delete process.env.STT_GATEWAY_URL;
		const { POST } = await import("../app/api/stt/transcribe/route.ts");
		const unconfigured = await POST(new Request("http://localhost/api/stt/transcribe", { method: "POST", body: new FormData() }));
		assert.equal(unconfigured.status, 503);
		assert.deepEqual(await unconfigured.json(), { message: "Local STT gateway is not configured." });

		process.env.STT_GATEWAY_URL = "http://127.0.0.1:1";
		const missing = await POST(new Request("http://localhost/api/stt/transcribe", { method: "POST", body: new FormData() }));
		assert.equal(missing.status, 400);
	});
});

describe("encodePcm16Wav", () => {
	it("writes a valid 44-byte RIFF/WAVE header and the exact PCM payload", async () => {
		const a = Uint8Array.from([0x01, 0xff, 0x80, 0x7f]).buffer;
		const b = Uint8Array.from([0x00, 0x10]).buffer;
		const blob = encodePcm16Wav([a, b], 16000);
		assert.equal(blob.type, "audio/wav");
		const bytes = Buffer.from(await blob.arrayBuffer());
		assert.equal(bytes.length, 44 + 6);
		assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
		assert.equal(bytes.readUInt32LE(4), 36 + 6);
		assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
		assert.equal(bytes.subarray(12, 16).toString("ascii"), "fmt ");
		assert.equal(bytes.readUInt32LE(16), 16);
		assert.equal(bytes.readUInt16LE(20), 1); // PCM
		assert.equal(bytes.readUInt16LE(22), 1); // mono
		assert.equal(bytes.readUInt32LE(24), 16000);
		assert.equal(bytes.readUInt32LE(28), 32000);
		assert.equal(bytes.readUInt16LE(32), 2);
		assert.equal(bytes.readUInt16LE(34), 16);
		assert.equal(bytes.subarray(36, 40).toString("ascii"), "data");
		assert.equal(bytes.readUInt32LE(40), 6);
		assert.deepEqual(Array.from(bytes.subarray(44)), [0x01, 0xff, 0x80, 0x7f, 0x00, 0x10]);
	});
});

describe("local dictation batch mode", () => {
	it("uses the pcm-capture worklet and uploads one WAV instead of opening a WebSocket", async () => {
		const React = (await import("react")).default;
		const { act } = await import("react");
		const { parseHTML } = await import("linkedom");
		const dom = parseHTML("<html><body><div id='root'></div></body></html>");
		const { useDictation } = await import("../components/dictation.tsx");
		type Dictation = import("../components/dictation.tsx").Dictation;
		const appends: string[] = [];
		const uploads: Array<{ fileName: string; bytes: Buffer; language: string | null }> = [];
		let worklet: { port: { onmessage?: (event: { data: unknown }) => void } } | undefined;
		let latest!: Dictation;
		let sockets = 0;
		class AudioGraph {
			state = "running";
			destination = {};
			audioWorklet = { addModule: async () => {} };
			createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
		}
		class Worklet {
			port: { onmessage?: (event: { data: unknown }) => void } = {};
			connect() {} disconnect() {}
			constructor() { worklet = this as never; }
		}
		class NoSocket { constructor() { sockets++; throw new Error("local mode must not open a WebSocket"); } }
		const globals = globalThis as Record<string, unknown>;
		const previous = new Map<string, PropertyDescriptor | undefined>();
		for (const [key, value] of Object.entries({
			React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
			navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
			WebSocket: NoSocket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
			IS_REACT_ACT_ENVIRONMENT: true,
			fetch: async (url: string, init?: RequestInit) => {
				if (url === "/api/stt/token") return Response.json({ mode: "local" });
				if (url === "/api/stt/transcribe") {
					const form = init!.body as FormData;
					const file = form.get("file") as File;
					uploads.push({
						fileName: file.name,
						bytes: Buffer.from(await file.arrayBuffer()),
						language: form.get("language") as string | null,
					});
					return Response.json({ text: "  local words  " });
				}
				return Response.json({ settings: { version: 1, dictation: { language: "en" } } });
			},
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		try {
			const { createRoot } = await import("react-dom/client");
			const root = createRoot(dom.document.getElementById("root")!);
			function Harness() { latest = useDictation({ append: (text) => { appends.push(text); } }); return null; }
			await act(async () => { root.render(React.createElement(Harness)); });
			await act(async () => { latest.toggle(); });
			assert.equal(latest.phase, "recording", "no socket handshake — recording starts once the worklet is live");
			assert.equal(sockets, 0);
			const frame = Uint8Array.from([1, 2, 3, 4]);
			await act(async () => {
				worklet!.port.onmessage!({ data: { type: "level", rms: 0.5 } });
				worklet!.port.onmessage!({ data: { type: "audio", buffer: frame.buffer } });
			});
			await act(async () => { latest.stop(); });
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
			assert.equal(latest.phase, "idle");
			assert.deepEqual(appends, ["local words"]);
			assert.equal(uploads.length, 1);
			assert.equal(uploads[0]!.fileName, "dictation.wav");
			assert.equal(uploads[0]!.language, "en");
			assert.equal(uploads[0]!.bytes.subarray(0, 4).toString("ascii"), "RIFF");
			assert.deepEqual(Array.from(uploads[0]!.bytes.subarray(44)), [1, 2, 3, 4]);
			await act(async () => { root.unmount(); });
		} finally {
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete globals[key];
			}
		}
	});
});

describe("deployment artifacts", () => {
	const root = path.join(import.meta.dirname, "..");

	it("binds every published Docker port to 127.0.0.1", async () => {
		const compose = await readFile(path.join(root, "deploy/docker-compose.yml"), "utf8");
		const ports = [...compose.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)]
			.map((match) => match[1]!)
			.filter((entry) => /:\d+/.test(entry));
		assert.ok(ports.length >= 4, "expected published ports in the compose file");
		for (const port of ports) {
			assert.match(port, /^127\.0\.0\.1:\d+:\d+$/, `port must be loopback-only: ${port}`);
		}
		assert.match(compose, /POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?required\}/);
		assert.match(compose, /RUSTFS_ACCESS_KEY:\s*\$\{S3_ACCESS_KEY_ID:\?required\}/);
	});

	it("removes the Supabase /auth/v1 proxy from Caddy", async () => {
		const caddy = await readFile(path.join(root, "deploy/Caddyfile"), "utf8");
		assert.equal(caddy.includes("/auth/v1"), false);
		assert.match(caddy, /reverse_proxy\s+127\.0\.0\.1:8300/);
		assert.match(caddy, /flush_interval\s+-1/);
	});
});
