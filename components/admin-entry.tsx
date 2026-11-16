"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UserPlusIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";

/**
 * Operator-only sidebar entry to /admin.
 *
 * The sidebar is a client component with no server props, so the operator check
 * is one fetch. It renders nothing until confirmed, which keeps the row out of
 * every learner's sidebar without a hydration mismatch.
 */
export function AdminEntry() {
	const [operator, setOperator] = useState(false);
	useEffect(() => {
		let live = true;
		void fetch("/api/admin/status", { cache: "no-store" })
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { operator?: boolean } | null) => { if (live) setOperator(body?.operator === true); })
			.catch(() => { if (live) setOperator(false); });
		return () => { live = false; };
	}, []);
	if (!operator) return null;
	return (
		<Hint label="Account requests" side="right">
			<Link
				href="/admin"
				data-testid="admin-entry"
				className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<UserPlusIcon className="size-3" />
				Requests
			</Link>
		</Hint>
	);
}