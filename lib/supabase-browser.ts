"use client";

/**
 * The browser-side Supabase client: one instance per tab, cookies only (the
 * server reads the same cookies). Null when hosted mode is off, and in the
 * desktop shell where there is no account.
 */
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

export function browserSupabase(): SupabaseClient | null {
	if (client !== undefined) return client;
	// Inlined at build time, so the check is safe in the browser.
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
	client = url && key ? createBrowserClient(url, key) : null;
	return client;
}