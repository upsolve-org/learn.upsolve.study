import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { slotsConfigured } from "@/src/core";
import { asRequestOwner, compactionInFlight, getChat, isTurnRunning, readSettingsRecord, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	// Tenancy: the record, liveness and settings are all read inside the
	// owner scope — another learner's chat id must not resolve here.
	const view = await asRequestOwner(async () => {
		const chat = await getChat(id);
		if (!chat) return null;
		// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
		// over the settings record, server-read — the same gate home/new read. The
		// server's 503 stays the truth; this only decides whether the pill rides.
		const record = readSettingsRecord();
		return {
			chat,
			configured: slotsConfigured(record?.models),
			initialError: turnFailure(chat.id),
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			inFlight: isTurnRunning(chat.id),
			compacting: compactionInFlight(chat.id),
		};
	});
	if (!view) notFound();
	const { chat } = view;
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// Wave D: the record IS native agent history — the client view is
				// derived app-side (core/view.ts projectView; GET serves the same
				// native messages).
				initialMessages={chat.messages}
			initialError={view.initialError}
			initialConfigured={view.configured}
			initialPrompt={prompt}
			initiallyInFlight={view.inFlight}
			initiallyCompacting={view.compacting}
		/>
	);
}
