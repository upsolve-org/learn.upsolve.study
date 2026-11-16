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
			<div className="flex w-full max-w-sm flex-col gap-4">
				<GlyphMark kind="check" className="size-8" />
				<h1 className="text-lg font-semibold tracking-tight">Not on the list yet</h1>
				<p className="text-muted-foreground text-sm">
					{email ? (
						<>
							You are signed in as <span className="text-foreground">{email}</span>, but that address has not been
							approved for UPsolve Learn.
						</>
					) : (
						"That account has not been approved for UPsolve Learn."
					)}
				</p>
				<p className="text-muted-foreground text-sm">
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