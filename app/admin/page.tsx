import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { admittedEmails, pendingSignups } from "@/src/server";
import { isOperator } from "@/src/core";
import { currentAccountEmail } from "@/src/server";
import { approveAction, denyAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Operator console: review account requests.
 *
 * Gated by ADMIN_EMAIL, not by admission — the operator is admitted too, but
 * admission alone must not grant this page. A non-operator gets a 404 rather
 * than a redirect, so the surface is not advertised.
 *
 * Approving only edits the allowlist. The account itself is still created in
 * GoTrue by the operator, and the credentials mailed by hand — that is what
 * the copy tells them to do next.
 */
export default async function AdminPage() {
	const email = await currentAccountEmail();
	if (!isOperator(email)) notFound();

	const pending = pendingSignups();
	const admitted = admittedEmails();

	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-8 px-6 py-12">
			<header className="flex flex-col gap-1">
				<Link href="/" className="text-muted-foreground text-xs underline underline-offset-2">
					← Back to the app
				</Link>
				<h1 className="text-lg font-semibold tracking-tight">Account requests</h1>
				<p className="text-muted-foreground text-sm">
					Approving adds the address to the allowlist. Then create the account in Supabase and email the
					credentials.
				</p>
			</header>

			<section className="flex flex-col gap-3">
				<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Pending ({pending.length})
				</h2>
				{pending.length === 0 ? (
					<p className="text-muted-foreground text-sm">Nothing waiting.</p>
				) : (
					<ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
						{pending.map((request) => (
							<li key={request.email} className="flex items-center justify-between gap-3 px-3 py-2.5">
								<div className="flex min-w-0 flex-col">
									<span className="truncate text-sm">{request.email}</span>
									<span className="text-muted-foreground text-xs">
										{new Date(request.requestedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
									</span>
								</div>
								<div className="flex shrink-0 gap-2">
									<form action={approveAction}>
										<input type="hidden" name="email" value={request.email} />
										<Button type="submit" size="sm">
											Approve
										</Button>
									</form>
									<form action={denyAction}>
										<input type="hidden" name="email" value={request.email} />
										<Button type="submit" size="sm" variant="outline">
											Deny
										</Button>
									</form>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Admitted ({admitted.length})
				</h2>
				{admitted.length === 0 ? (
					<p className="text-muted-foreground text-sm">Nobody yet.</p>
				) : (
					<ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
						{admitted.map((address) => (
							<li key={address} className="px-3 py-2.5 text-sm">
								{address}
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	);
}