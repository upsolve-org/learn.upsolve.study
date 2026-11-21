"use client";

import { useActionState } from "react";
import Link from "next/link";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInAction, type LoginState } from "./actions";

/**
 * Email + password sign-in. Shown in place of the app shell: no owner, no
 * sidebar, no session-scoped provider.
 *
 * The Google button is server-rendered from GoTrue's own settings (the page
 * passes `google`), so it appears the moment credentials are configured and
 * never as a dead control.
 */
export function LoginForm({ next, error, google }: { next: string; error?: string; google: boolean }) {
	const [state, action, pending] = useActionState<LoginState, FormData>(signInAction, { error });

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
						<h1 className="font-title text-3xl uppercase tracking-tight text-foreground">Sign in</h1>
						<p className="mt-1 font-prose text-sm text-muted-foreground">UPsolve Learn is invitation-only.</p>
					</div>
				</div>

				<form action={action} className="flex flex-col gap-4">
					<input type="hidden" name="next" value={next} />
					<label className="flex flex-col gap-1.5">
						<span className="font-ui text-xs uppercase tracking-[0.09em] text-muted-foreground">Email</span>
						<Input
							name="email"
							type="email"
							autoComplete="username"
							required
							autoFocus
							aria-invalid={state.error ? true : undefined}
							className="h-10"
						/>
					</label>
					<label className="flex flex-col gap-1.5">
						<span className="font-ui text-xs uppercase tracking-[0.09em] text-muted-foreground">Password</span>
						<Input
							name="password"
							type="password"
							autoComplete="current-password"
							required
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
						{pending ? "Signing in..." : "Sign in"}
					</Button>
				</form>

				{google ? (
					<>
						<div className="flex items-center gap-3 font-ui text-xs uppercase tracking-[0.1em] text-muted-foreground">
							<span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
						</div>
						<form action="/auth/login" method="post" className="contents">
							<input type="hidden" name="next" value={next} />
							<input type="hidden" name="intent" value="google" />
							<Button type="submit" variant="outline" size="lg" className="w-full">
								Continue with Google
							</Button>
						</form>
					</>
				) : null}

				<p className="border-t border-border pt-4 font-prose text-sm text-muted-foreground">
					No account yet?{" "}
					<Link href="/auth/signup" className="font-ui text-xs uppercase tracking-[0.08em] text-[var(--lh-accent)] underline underline-offset-4 hover:text-foreground">
						Request one
					</Link>
				</p>
			</div>
		</div>
	);
}