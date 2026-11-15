import "./support/async-local-storage.ts";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

process.env.HOSTED_MODE = "on";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:8000";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";

const [, password] = readFileSync(process.env.PW_FILE!, "utf8").trim().split("\n");
if (!password) throw new Error("PW_FILE must contain a password on line two");
const request = new NextRequest(new URL("/", "http://localhost"), { headers: { cookie: "x=1" } });
const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
	cookies: { getAll: () => request.cookies.getAll(), setAll: (l) => console.log("setAll", l.length) },
});
const out = await client.auth.signInWithPassword({ email: "narch@upsolve.study", password });
console.log("error:", out.error?.status, out.error?.message);
