import Link from "next/link";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/app/auth/actions";
import { currentAccountEmail } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * A verified account that is not on the allowlist lands here instead of being
 * bounced back to sign-in (which would loop: the session is valid, so the
 * login page redirects away). Signing out is offered because a shared browser
 * may be signed into the wrong account.
 */
export default async function DeniedPage() {
	const email = await currentAccountEmail();
	return (
		<div className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
			<div className="panel-enter flex w-full max-w-md flex-col gap-4 border border-border border-t-2 border-t-destructive bg-well p-8 shadow-[var(--shadow-lift)]">
				<div className="flex items-center gap-2.5">
					<GlyphMark kind="check" className="size-7 text-destructive" />
					<span className="font-ui text-xs font-semibold uppercase tracking-[0.12em] text-destructive">
						UPsolve // Access Required
					</span>
				</div>
				<h1 className="font-title text-3xl uppercase tracking-tight text-foreground">Not on the list yet</h1>
				<p className="font-prose text-sm text-muted-foreground">
					{email ? (
						<>
							You are signed in as <span className="font-ui text-foreground">{email}</span>, but that address has not been
							approved for UPsolve Learn.
						</>
					) : (
						"That account has not been approved for UPsolve Learn."
					)}
				</p>
				<p className="font-prose text-sm text-muted-foreground">
					Request access and we will email your sign-in details once it is approved.
				</p>
				<Button asChild size="lg" className="mt-1 w-full">
					<Link href="/auth/signup">Request access</Link>
				</Button>
				<form action={signOutAction}>
					<Button type="submit" variant="outline" size="lg" className="w-full">
						Sign out
					</Button>
				</form>
			</div>
		</div>
	);
}