import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { admittedEmails, isOperator, pendingSignups } from "@/src/server";
import { issuedCredentials, provisioningAvailable } from "@/src/server";
import { currentAccountEmail } from "@/src/server";
import { approveAction, denyAction, forgetCredentialAction, reprovisionAction, retryEmailAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Operator console: review account requests and track credential emails.
 *
 * Gated by ADMIN_EMAIL, not by admission — the operator is admitted too, but
 * admission alone must not grant this page. A non-operator gets a 404 rather
 * than a redirect, so the surface is not advertised.
 *
 * Approving creates the account with a generated password and emails it.
 * Supabase keeps only a hash, so this page is the only place a password can be
 * read; "Done" drops it once it has been sent.
 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const email = await currentAccountEmail();
	if (!isOperator(email)) notFound();
	const params = await searchParams;

	const pending = pendingSignups();
	const admitted = admittedEmails();
	const issued = issuedCredentials();
	const canProvision = provisioningAvailable();
	const issuedEmails = new Set(issued.map((c) => c.email));

	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-8 px-6 py-12">
			<header className="flex flex-col gap-1">
				<Link href="/" className="text-muted-foreground text-xs underline underline-offset-2">
					← Back to the app
				</Link>
				<h1 className="text-lg font-semibold tracking-tight">Account requests</h1>
				<p className="text-muted-foreground text-sm">
					{canProvision
						? "Approving creates the account and emails its sign-in details. Check the email status below, then press Done to clear the saved password."
						: "Approving admits the address only — SUPABASE_SECRET_KEY is unset, so create the account by hand."}
				</p>
			</header>
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
		</main>
	);
}
