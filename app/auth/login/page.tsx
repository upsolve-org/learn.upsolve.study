import { redirect } from "next/navigation";
import { currentOwner } from "@/src/server";
import { loginErrorMessage, safeReturnPath } from "@/src/core";
import { loginProviders } from "./actions";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/** The sign-in page. A signed-in visitor goes straight on to `next`. */
export default async function LoginPage({ searchParams }: { searchParams: Search }) {
	const params = await searchParams;
	const next = safeReturnPath(one(params.next));
	if (await currentOwner()) redirect(next);

	return (
		<main>
			<LoginForm next={next} error={loginErrorMessage(one(params.error))} google={await loginProviders()} />
		</main>
	);
}
