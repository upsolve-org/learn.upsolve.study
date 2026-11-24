import type { PluginGraphFileData, PluginLearningData } from "../core/plugins.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { graphSnapshot } from "../core/graph.ts";

export interface PluginLearningDeps {
	/** Resolved on every access: the caller's registry, not one snapshot. */
	readonly directory: string;
	chatStore: ChatStore;
	graphStore: GraphStore;
	isBusy(id: string): boolean;
	isCompacting(id: string): boolean;
	readMetadata(name: "render-settings.json" | "format.json"): unknown;
}

/** A deliberately thin, read-only facade. Every read is fresh; this is not a
 * transaction spanning several files. Native transcript content is preserved.
 * Raw ledgers use the same version guards and validation as the core store. */
export function createPluginLearningData(deps: PluginLearningDeps): PluginLearningData {
	const readers: { [K in keyof PluginGraphFileData]: () => Promise<PluginGraphFileData[K]> } = {
		"nodes.jsonl": async () => await deps.graphStore.readNodes(),
		"chains.jsonl": async () => await deps.graphStore.readChains(),
		"sessions.jsonl": async () => await deps.graphStore.readCheckpoints(),
		"coverage.jsonl": async () => await deps.graphStore.readCoverage(),
		"sources.json": async () => await deps.graphStore.readSources(),
		"positions.json": async () => await deps.graphStore.readPositions(),
		"render-settings.json": async () => deps.readMetadata("render-settings.json"),
		"format.json": async () => deps.readMetadata("format.json"),
	};
	return {
		directory: deps.directory,
		listSessions: async () => (await deps.chatStore.listChats()).map((s) => ({ ...s, busy: deps.isBusy(s.id), compacting: deps.isCompacting(s.id) })),
		getSession: async (id) => {
			if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid learning session id");
			return await deps.chatStore.getChat(id);
		},
		graph: async () => await graphSnapshot({ chatStore: deps.chatStore, graphStore: deps.graphStore }),
		readGraphFile: async (name) => {
			if (!Object.hasOwn(readers, name)) throw new Error("Unknown learning-data file");
			return await readers[name]();
		},
	};
}
