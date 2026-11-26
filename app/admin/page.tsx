import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminStatsTable } from "@/components/admin-stats-table";
import { Button } from "@/components/ui/button";
import { ADMIN_STATS_RANGES, formatCompactNumber, parseAdminStatsRange } from "@/src/core";
import {
	admittedEmails,
	currentAccountEmail,
	getAdminStats,
	isOperator,
	issuedCredentials,
	pendingSignups,
	provisioningAvailable,
} from "@/src/server";
import { approveAction, denyAction, forgetCredentialAction, reprovisionAction, retryEmailAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Operator console: usage stats dashboard and account request management.
 *
 * Gated by ADMIN_EMAIL, not by admission — the operator is admitted too, but
 * admission alone must not grant this page. A non-operator gets a 404 rather
 * than a redirect, so the surface is not advertised.
 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const email = await currentAccountEmail();
	if (!isOperator(email)) notFound();
	const params = await searchParams;

	const tabParam = Array.isArray(params.tab) ? params.tab[0] : params.tab;
	const activeTab = tabParam === "requests" ? "requests" : "stats";
	const range = parseAdminStatsRange(params.range);

	const pending = pendingSignups();
	const stats = activeTab === "stats" ? await getAdminStats(range) : null;
	const admitted = activeTab === "requests" ? admittedEmails() : [];
	const issued = activeTab === "requests" ? issuedCredentials() : [];
	const canProvision = activeTab === "requests" ? provisioningAvailable() : false;
	const issuedEmails = new Set(issued.map((c) => c.email));

	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-6 px-6 py-10">
			<header className="flex flex-col gap-3">
				<Link href="/" className="text-muted-foreground text-xs underline underline-offset-2">
					← Back to the app
				</Link>
				<div className="flex flex-wrap items-end justify-between gap-4">
					<div className="flex flex-col gap-1">
						<h1 className="text-lg font-semibold tracking-tight">Admin console</h1>
						<p className="text-muted-foreground text-sm">
							{activeTab === "stats"
								? "Session counts and token usage across all accounts (chat turns, extractions, and jobs)."
								: canProvision
									? "Approving creates the account and emails its sign-in details. Check the email status below, then press Done to clear the saved password."
									: "Approving admits the address only — DATABASE_URL is unset, so create the account by hand."}
						</p>
					</div>
					<nav aria-label="Admin sections" className="inline-flex rounded-lg border border-border bg-card p-1 text-sm">
						<Link
							href={`/admin?tab=stats&range=${range}`}
							className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
								activeTab === "stats"
									? "bg-foreground text-background"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							Stats
						</Link>
						<Link
							href="/admin?tab=requests"
							className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors ${
								activeTab === "requests"
									? "bg-foreground text-background"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							<span>Account requests</span>
							{pending.length > 0 ? (
								<span
									className={`rounded-full px-1.5 py-0.5 text-[11px] leading-none font-mono tabular-nums ${
										activeTab === "requests"
											? "bg-background/20 text-background"
											: "bg-foreground/10 text-foreground"
									}`}
								>
									{pending.length}
								</span>
							) : null}
						</Link>
					</nav>
				</div>
			</header>

			{activeTab === "stats" && stats ? (
				<div className="flex flex-col gap-6">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1 text-xs">
							{ADMIN_STATS_RANGES.map((option) => (
								<Link
									key={option.id}
									href={`/admin?tab=stats&range=${option.id}`}
									className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
										range === option.id
											? "bg-foreground text-background"
											: "text-muted-foreground hover:text-foreground"
									}`}
								>
									{option.label}
								</Link>
							))}
						</div>
						<span className="text-muted-foreground text-xs">
							Snapshot: {stats.generatedAt.slice(0, 16).replace("T", " ")} UTC
						</span>
					</div>

					{!stats.available ? (
						<p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
							Usage stats require PostgreSQL (<code className="font-mono text-xs">DATABASE_URL</code> is not configured in this environment).
						</p>
					) : (
						<>
							<section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
								<div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
									<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Users</span>
									<span className="font-mono text-2xl font-semibold tabular-nums">
										{stats.totals.activeUsers.toLocaleString("en-US")}
										<span className="text-muted-foreground text-sm font-normal">
											{" "}
											/ {stats.totals.users.toLocaleString("en-US")}
										</span>
									</span>
									<span className="text-muted-foreground text-xs">Active in range / total accounts</span>
								</div>
								<div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
									<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sessions</span>
									<span className="font-mono text-2xl font-semibold tabular-nums">
										{stats.totals.sessions.toLocaleString("en-US")}
									</span>
									<span className="text-muted-foreground text-xs">Chats created or updated in range</span>
								</div>
								<div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
									<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Total tokens</span>
									<span
										className="font-mono text-2xl font-semibold tabular-nums"
										title={stats.totals.tokens.total.toLocaleString("en-US")}
									>
										{formatCompactNumber(stats.totals.tokens.total)}
									</span>
									<span className="text-muted-foreground text-xs">
										In {formatCompactNumber(stats.totals.tokens.input)} · Out {formatCompactNumber(stats.totals.tokens.output)}
									</span>
								</div>
								<div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
									<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Cache &amp; reasoning</span>
									<span
										className="font-mono text-2xl font-semibold tabular-nums"
										title={`Cache read: ${stats.totals.tokens.cacheRead.toLocaleString("en-US")}, Cache write: ${stats.totals.tokens.cacheWrite.toLocaleString("en-US")}`}
									>
										{formatCompactNumber(stats.totals.tokens.cacheRead)}
									</span>
									<span className="text-muted-foreground text-xs">
										Write {formatCompactNumber(stats.totals.tokens.cacheWrite)} · Reasoning {formatCompactNumber(stats.totals.tokens.reasoning)}
									</span>
								</div>
							</section>

							<section className="flex flex-col gap-3">
								<div className="flex items-center justify-between gap-2">
									<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
										Per-user usage ({stats.users.length})
									</h2>
									<span className="text-muted-foreground text-xs">
										Click any column header to sort · hover counts for exact totals
									</span>
								</div>
								<AdminStatsTable users={stats.users} />
							</section>
						</>
					)}
				</div>
			) : (
				<div className="flex max-w-2xl flex-col gap-8">
					{params.error === "provisioning" && (
						<p role="alert" className="text-sm text-destructive">
							The account could not be created. Check account provisioning, then use New password for the admitted address to retry.
						</p>
					)}

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
							Credential emails ({issued.length})
						</h2>
						{issued.length === 0 ? (
							<p className="text-muted-foreground text-sm">No saved credentials.</p>
						) : (
							<ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
								{issued.map((credential) => (
									<li key={credential.email} className="flex flex-col gap-2 px-3 py-2.5">
										<div className="flex items-center justify-between gap-3">
											<span className="truncate text-sm">{credential.email}</span>
											<span className="text-muted-foreground shrink-0 text-xs">
												{new Date(credential.issuedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
											</span>
										</div>
										<p className="text-muted-foreground text-xs" role="status">
											{credential.emailDelivery?.status === "accepted"
												? "Email accepted by Resend. Inbox delivery is not confirmed here."
												: credential.emailDelivery?.status === "failed"
													? credential.emailDelivery.error
													: "Email not sent yet."}
										</p>
										<div className="flex flex-wrap items-center gap-2">
											<code className="min-w-0 flex-1 break-all rounded-md border border-border bg-card px-2 py-1 font-mono text-xs select-all">
												{credential.password}
											</code>
											{credential.emailDelivery?.status !== "accepted" && (
												<form action={retryEmailAction}>
													<input type="hidden" name="email" value={credential.email} />
													<Button type="submit" size="sm" variant="outline">
														{credential.emailDelivery?.status === "failed" ? "Retry email" : "Send email"}
													</Button>
												</form>
											)}
											<form action={forgetCredentialAction}>
												<input type="hidden" name="email" value={credential.email} />
												<Button type="submit" size="sm" variant="outline">
													Done
												</Button>
											</form>
											<form action={reprovisionAction}>
												<input type="hidden" name="email" value={credential.email} />
												<Button type="submit" size="sm" variant="outline">
													Reset
												</Button>
											</form>
										</div>
									</li>
								))}
							</ul>
						)}
						<p className="text-muted-foreground text-xs">
							Retry email reuses the saved password. Reset creates a new password; use Send email to send it.
							Done removes the saved password from this page.
						</p>
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
									<li key={address} className="flex items-center justify-between gap-3 px-3 py-2.5">
										<span className="truncate text-sm">{address}</span>
										{!issuedEmails.has(address) ? (
											<form action={reprovisionAction} className="shrink-0">
												<input type="hidden" name="email" value={address} />
												<Button type="submit" size="sm" variant="ghost">
													New password
												</Button>
											</form>
										) : null}
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			)}
		</main>
	);
}
