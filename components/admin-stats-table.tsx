"use client";

import { useMemo, useState } from "react";
import { formatCompactNumber, type AdminUserStatsRow } from "@/src/core";

type SortKey = "email" | "sessions" | "total" | "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "lastActiveAt";
type SortDir = "asc" | "desc";

const COLUMNS: readonly { key: SortKey; label: string; align: "left" | "right" }[] = [
	{ key: "email", label: "User", align: "left" },
	{ key: "sessions", label: "Sessions", align: "right" },
	{ key: "total", label: "Total", align: "right" },
	{ key: "input", label: "Input", align: "right" },
	{ key: "output", label: "Output", align: "right" },
	{ key: "cacheRead", label: "Cache read", align: "right" },
	{ key: "cacheWrite", label: "Cache write", align: "right" },
	{ key: "reasoning", label: "Reasoning", align: "right" },
	{ key: "lastActiveAt", label: "Last active", align: "right" },
];

function sortValue(row: AdminUserStatsRow, key: SortKey): number | string {
	switch (key) {
		case "email":
			return row.email;
		case "sessions":
			return row.sessions;
		case "total":
			return row.tokens.total;
		case "input":
			return row.tokens.input;
		case "output":
			return row.tokens.output;
		case "cacheRead":
			return row.tokens.cacheRead;
		case "cacheWrite":
			return row.tokens.cacheWrite;
		case "reasoning":
			return row.tokens.reasoning;
		case "lastActiveAt":
			return row.lastActiveAt ? Date.parse(row.lastActiveAt) : -1;
	}
}

function formatLastActive(iso: string | null): string {
	if (!iso) return "—";
	return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function AdminStatsTable({ users }: { users: AdminUserStatsRow[] }) {
	const [sortKey, setSortKey] = useState<SortKey>("total");
	const [sortDir, setSortDir] = useState<SortDir>("desc");

	const sorted = useMemo(() => {
		const copy = [...users];
		copy.sort((a, b) => {
			const av = sortValue(a, sortKey);
			const bv = sortValue(b, sortKey);
			let cmp: number;
			if (typeof av === "string" && typeof bv === "string") {
				cmp = av.localeCompare(bv);
			} else {
				cmp = (av as number) - (bv as number);
			}
			if (cmp === 0) cmp = a.email.localeCompare(b.email);
			return sortDir === "asc" ? cmp : -cmp;
		});
		return copy;
	}, [users, sortKey, sortDir]);

	const toggleSort = (key: SortKey) => {
		if (key === sortKey) {
			setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
		} else {
			setSortKey(key);
			setSortDir(key === "email" ? "asc" : "desc");
		}
	};

	if (users.length === 0) {
		return <p className="text-muted-foreground text-sm">No users found yet.</p>;
	}

	return (
		<div className="overflow-x-auto rounded-lg border border-border">
			<table className="w-full border-collapse text-sm">
				<thead>
					<tr className="border-b border-border bg-card/50 text-xs uppercase tracking-wide text-muted-foreground">
						{COLUMNS.map((col) => {
							const active = sortKey === col.key;
							return (
								<th
									key={col.key}
									className={`px-2.5 py-2 font-medium whitespace-nowrap ${col.align === "right" ? "text-right" : "text-left"}`}
									aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
								>
									<button
										type="button"
										onClick={() => toggleSort(col.key)}
										className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${active ? "text-foreground" : ""}`}
									>
										<span>{col.label}</span>
										{active ? <span aria-hidden="true">{sortDir === "asc" ? "↑" : "↓"}</span> : null}
									</button>
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody className="divide-y divide-border">
					{sorted.map((row) => (
						<tr key={row.userId ?? row.email} className="hover:bg-card/40 transition-colors">
							<td className="px-2.5 py-2 max-w-[220px] truncate" title={row.email}>
								<span>{row.email}</span>
							</td>
							<td className="px-2.5 py-2 text-right font-mono tabular-nums" title={row.sessions.toLocaleString("en-US")}>
								{row.sessions.toLocaleString("en-US")}
							</td>
							<td
								className="px-2.5 py-2 text-right font-mono font-medium tabular-nums"
								title={row.tokens.total.toLocaleString("en-US")}
							>
								{formatCompactNumber(row.tokens.total)}
							</td>
							<td className="px-2.5 py-2 text-right font-mono tabular-nums text-muted-foreground" title={row.tokens.input.toLocaleString("en-US")}>
								{formatCompactNumber(row.tokens.input)}
							</td>
							<td className="px-2.5 py-2 text-right font-mono tabular-nums text-muted-foreground" title={row.tokens.output.toLocaleString("en-US")}>
								{formatCompactNumber(row.tokens.output)}
							</td>
							<td className="px-2.5 py-2 text-right font-mono tabular-nums text-muted-foreground" title={row.tokens.cacheRead.toLocaleString("en-US")}>
								{formatCompactNumber(row.tokens.cacheRead)}
							</td>
							<td className="px-2.5 py-2 text-right font-mono tabular-nums text-muted-foreground" title={row.tokens.cacheWrite.toLocaleString("en-US")}>
								{formatCompactNumber(row.tokens.cacheWrite)}
							</td>
							<td className="px-2.5 py-2 text-right font-mono tabular-nums text-muted-foreground" title={row.tokens.reasoning.toLocaleString("en-US")}>
								{formatCompactNumber(row.tokens.reasoning)}
							</td>
							<td className="px-2.5 py-2 text-right font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground">
								{formatLastActive(row.lastActiveAt)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
