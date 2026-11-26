import React, { createContext, Fragment, useContext } from "react";
import {
	File,
	FileArchive,
	FileAudio,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
	Folder,
} from "lucide-react";
import { filePathLabel, isDirectoryReference, parseComposerTokens, parseUploadedAttachmentPath } from "@/src/core";
import { CitationChip } from "./citation-chip";

export const FileViewerContext = createContext<{ openFile: (path: string) => void } | null>(null);

function fileIcon(label: string) {
	const extension = label.split(".").at(-1)?.toLowerCase();
	if (/^(png|jpe?g|gif|webp|svg|bmp|tiff?|avif|heic)$/.test(extension ?? "")) return FileImage;
	if (/^(mp3|wav|ogg|flac|m4a|aac)$/.test(extension ?? "")) return FileAudio;
	if (/^(mp4|mov|webm|mkv|avi)$/.test(extension ?? "")) return FileVideo;
	if (/^(zip|gz|tar|bz2|xz|7z|rar)$/.test(extension ?? "")) return FileArchive;
	if (/^(csv|tsv|xlsx?|ods)$/.test(extension ?? "")) return FileSpreadsheet;
	if (/^(js|jsx|ts|tsx|py|rb|rs|go|c|cpp|h|java|json|html|css|sh|yaml|yml)$/.test(extension ?? "")) return FileCode;
	if (/^(pdf|txt|md|mdx|rtf|docx?|odt|tex|epub)$/.test(extension ?? "")) return FileText;
	return File;
}

export interface FilePathChipProps {
	path: string;
	/** Editors can make the chip atomic; transcript renderers can omit this. */
	contentEditable?: false;
	className?: string;
}

/** Pure presentation by default; when rendered inside a transcript with
 *  FileViewerContext, owner-scoped `/uploads/...` chips open the side viewer. */
export function FilePathChip({ path, contentEditable, className }: FilePathChipProps) {
	const fileViewer = useContext(FileViewerContext);
	const label = filePathLabel(path);
	const Icon = isDirectoryReference(path) ? Folder : fileIcon(label);
	const uploaded = contentEditable === undefined && fileViewer ? parseUploadedAttachmentPath(path) : null;
	if (uploaded && fileViewer) {
		return (
			<button
				type="button"
				aria-label={`View ${label}`}
				title={`View ${label} in side panel`}
				onClick={() => fileViewer.openFile(uploaded.path)}
				className={`inline-flex max-w-full cursor-pointer items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 align-middle text-sm transition-colors hover:border-primary/50 hover:bg-accent/70${className ? ` ${className}` : ""}`}
			>
				<Icon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
				<span className="min-w-0 truncate">{label}</span>
			</button>
		);
	}
	return (
		<span
			role="img"
			aria-label={path}
			title={path}
			contentEditable={contentEditable}
			className={`inline-flex max-w-full items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 align-middle text-sm${className ? ` ${className}` : ""}`}
		>
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="min-w-0 truncate">{label}</span>
		</span>
	);
}

/** Ordinary learner text stays ordinary text; only quoted paths and tutor
 *  citations become chips. */
export function PathText({ text }: { text: string }) {
	return (
		<>
			{parseComposerTokens(text).map((part) => (
				<Fragment key={part.start}>
					{part.kind === "path" ? <FilePathChip path={part.path} />
						: part.kind === "citation" ? <CitationChip citation={part.citation} variant="transcript" />
						: part.text}
				</Fragment>
			))}
		</>
	);
}
