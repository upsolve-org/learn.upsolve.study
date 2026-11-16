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
				<div className="flex w-full max-w-sm flex-col gap-4">
					<GlyphMark kind="check" className="size-8" />
					<h1 className="text-lg font-semibold tracking-tight">Request received</h1>
					<p className="text-muted-foreground text-sm">
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
			<div className="flex w-full max-w-sm flex-col gap-6">
				<div className="flex flex-col items-start gap-3">
					<GlyphMark kind="check" className="size-8" />
					<div>
						<h1 className="text-lg font-semibold tracking-tight">Request an account</h1>
						<p className="text-muted-foreground text-sm">
							UPsolve Learn is invitation-only. Leave your email and we will send your sign-in details.
						</p>
					</div>
				</div>

				<form action={action} className="flex flex-col gap-3">
					<label className="flex flex-col gap-1.5">
						<span className="text-sm font-medium">Email</span>
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
						<p role="alert" className="text-destructive text-sm">
							{state.error}
						</p>
					) : null}
					<Button type="submit" size="lg" disabled={pending} className="mt-1 w-full">
						{pending ? "Sending..." : "Request access"}
					</Button>
				</form>

				<p className="text-muted-foreground text-sm">
					Already have an account?{" "}
					<Link href="/auth/login" className="text-foreground underline underline-offset-2">
						Sign in
					</Link>
				</p>
			</div>
		</div>
	);
}