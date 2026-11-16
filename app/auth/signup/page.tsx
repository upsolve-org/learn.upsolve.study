import { redirect } from "next/navigation";
import { currentOwner } from "@/src/server";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";

/** Public: a signed-in visitor has no reason to request an account. */
export default async function SignupPage() {
	if (await currentOwner()) redirect("/");
	return (
		<main>
			<SignupForm />
		</main>
	);
}