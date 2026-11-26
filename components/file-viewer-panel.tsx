"use client";

import { useEffect, useState } from "react";
import { ExternalLinkIcon, FileTextIcon, XIcon } from "lucide-react";
import type { UploadedAttachmentRef } from "@/src/core";

export interface FileViewerPanelProps {
	files: readonly UploadedAttachmentRef[];
	activePath: string;
	onSelect: (path: string) => void;
	onClose: () => void;
}

export function FileViewerPanel({ files, activePath, onSelect, onClose }: FileViewerPanelProps) {
	const active = files.find((f) => f.path === activePath) ?? files[0] ?? null;
	const [textState, setTextState] = useState<{ url: string; content: string | null; error: string | null }>({
		url: "",
		content: null,
		error: null,
	});

	useEffect(() => {
		if (!active || active.kind !== "text") return;
		const controller = new AbortController();
		setTextState({ url: active.url, content: null, error: null });
		fetch(active.url, { signal: controller.signal, cache: "no-store" })
			.then(async (res) => {
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					throw new Error(body.error ?? `Could not load file (${res.status})`);
				}
				return res.text();
			})
			.then((content) => {
				if (!controller.signal.aborted) {
					setTextState({ url: active.url, content, error: null });
				}
			})
			.catch((err) => {
				if (!controller.signal.aborted) {
					setTextState({
						url: active.url,
						content: null,
						error: err instanceof Error ? err.message : "Could not load file.",
					});
				}
			});
		return () => controller.abort();
	}, [active]);

	if (!active) return null;

	const loadingText = active.kind === "text" && (textState.url !== active.url || (textState.content === null && textState.error === null));

	return (
		<aside
			aria-label="Uploaded file viewer"
			data-testid="file-viewer-panel"
			className="flex w-[45%] min-w-[320px] max-w-[760px] shrink-0 flex-col border-l border-border bg-background"
		>
			<header className="flex shrink-0 items-center gap-2 border-b border-border bg-card/40 px-3 py-2">
				<FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
				{files.length > 1 ? (
					<select
						aria-label="Select uploaded file"
						data-testid="file-viewer-select"
						value={active.path}
						onChange={(e) => onSelect(e.target.value)}
						className="min-w-0 flex-1 truncate rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground outline-none focus:border-primary"
					>
						{files.map((file) => (
							<option key={file.path} value={file.path}>
								{file.filename}
							</option>
						))}
					</select>
				) : (
					<span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={active.filename}>
						{active.filename}
					</span>
				)}
				<a
					href={active.url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Open file in new tab"
					title="Open in new tab"
					className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
				</a>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close file viewer"
					data-testid="file-viewer-close"
					className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
			</header>

			<div className="flex min-h-0 flex-1 flex-col">
				{active.kind === "pdf" ? (
					<iframe
						key={active.url}
						src={active.url}
						title={active.filename}
						data-testid="file-viewer-pdf"
						className="h-full w-full flex-1 border-0 bg-muted/20"
					/>
				) : loadingText ? (
					<p className="p-4 text-xs text-muted-foreground">Loading {active.filename}…</p>
				) : textState.error ? (
					<p role="alert" className="p-4 text-xs text-destructive">
						{textState.error}
					</p>
				) : (
					<pre
						data-testid="file-viewer-text"
						className="h-full flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground"
					>
						{textState.content}
					</pre>
				)}
			</div>
		</aside>
	);
}
