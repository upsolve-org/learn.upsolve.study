"use client";

import { useActionState } from "react";
import Link from "next/link";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestAccountAction, type SignupState } from "./actions";

/**
 * Request-an-account form. No password field: the account does not exist yet.
 * The operator mails credentials after review, so the copy has to set that
 * expectation plainly rather than imply immediate access.
 */
export function SignupForm() {
	const [state, action, pending] = useActionState<SignupState, FormData>(requestAccountAction, {});

	if (state.outcome) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
				<div className="panel-enter flex w-full max-w-md flex-col gap-4 border border-border border-t-2 border-t-[var(--lh-accent)] bg-well p-8 shadow-[var(--shadow-lift)]">
					<div className="flex items-center gap-2.5">
						<GlyphMark kind="check" className="size-7 text-[var(--lh-accent)]" />
						<span className="font-ui text-xs font-semibold uppercase tracking-[0.12em] text-[var(--lh-accent)]">
							UPsolve // Learn
						</span>
					</div>
					<h1 className="font-title text-3xl uppercase tracking-tight text-foreground">Request received</h1>
					<p className="font-prose text-sm text-muted-foreground">
						{state.outcome === "already-admitted"
							? "That address already has access. Sign in and you are in."
							: state.outcome === "already-pending"
								? "That address is already waiting for review. Nothing more to do."
								: "We will review it and email your sign-in details once it is approved."}
					</p>
					<Button asChild size="lg" className="mt-1 w-full">
						<Link href="/auth/login">Go to sign in</Link>
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
			<div className="panel-enter flex w-full max-w-md flex-col gap-6 border border-border border-t-2 border-t-[var(--lh-accent)] bg-well p-8 shadow-[var(--shadow-lift)]">
				<div className="flex flex-col items-start gap-3">
					<div className="flex items-center gap-2.5">
						<GlyphMark kind="check" className="size-7 text-[var(--lh-accent)]" />
						<span className="font-ui text-xs font-semibold uppercase tracking-[0.12em] text-[var(--lh-accent)]">
							UPsolve // Learn
						</span>
					</div>
					<div>
						<h1 className="font-title text-3xl uppercase tracking-tight text-foreground">Request an account</h1>
						<p className="mt-1 font-prose text-sm text-muted-foreground">
							UPsolve Learn is invitation-only. Leave your email and we will send your sign-in details.
						</p>
					</div>
				</div>

				<form action={action} className="flex flex-col gap-4">
					<label className="flex flex-col gap-1.5">
						<span className="font-ui text-xs uppercase tracking-[0.09em] text-muted-foreground">Email</span>
						<Input
							name="email"
							type="email"
							autoComplete="email"
							required
							autoFocus
							aria-invalid={state.error ? true : undefined}
							className="h-10"
						/>
					</label>
					{state.error ? (
						<p role="alert" className="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
							{state.error}
						</p>
					) : null}
					<Button type="submit" size="lg" disabled={pending} className="mt-1 w-full">
						{pending ? "Sending..." : "Request access"}
					</Button>
				</form>

				<p className="border-t border-border pt-4 font-prose text-sm text-muted-foreground">
					Already have an account?{" "}
					<Link href="/auth/login" className="font-ui text-xs uppercase tracking-[0.08em] text-[var(--lh-accent)] underline underline-offset-4 hover:text-foreground">
						Sign in
					</Link>
				</p>
			</div>
		</div>
	);
}