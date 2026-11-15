"use client";

import { useActionState } from "react";
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
			<div className="flex w-full max-w-sm flex-col gap-6">
				<div className="flex flex-col items-start gap-3">
					<GlyphMark kind="check" className="size-8" />
					<div>
						<h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
						<p className="text-muted-foreground text-sm">UPsolve Learn is invitation-only.</p>
					</div>
				</div>

				<form action={action} className="flex flex-col gap-3">
					<input type="hidden" name="next" value={next} />
					<label className="flex flex-col gap-1.5">
						<span className="text-sm font-medium">Email</span>
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
						<span className="text-sm font-medium">Password</span>
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
						<p role="alert" className="text-destructive text-sm">
							{state.error}
						</p>
					) : null}
					<Button type="submit" size="lg" disabled={pending} className="mt-1 w-full">
						{pending ? "Signing in..." : "Sign in"}
					</Button>
				</form>

				{google ? (
					<>
						<div className="text-muted-foreground flex items-center gap-3 text-xs">
							<span className="bg-border h-px flex-1" /> or <span className="bg-border h-px flex-1" />
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
			</div>
		</div>
	);
}