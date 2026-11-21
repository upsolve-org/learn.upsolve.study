import type { Metadata } from "next";
import { Barlow_Condensed, JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { PluginsProvider } from "@/components/plugins";
import { asRequestOwner, currentOwner, readThemeBoot } from "@/src/server";
import { hostedMode } from "@/src/core";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = Barlow
// Condensed (matching www.upsolve.study & comprog.upsolve.study).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });
const display = Barlow_Condensed({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-barlow" });

export const metadata: Metadata = {
	title: "UPsolve Learn — Socratic AI Tutor & Flashcards",
	description: "UPsolve Socratic tutoring, PDF flashcards, spaced practice, and persistent knowledge graph.",
	icons: {
		icon: "/logo-mark.png",
	},
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	// Tenancy: the boot theme is the OWNER's appearance record and theme
	// files, so it is read inside the request's owner scope.
	const { appearance, theme, vars } = await asRequestOwner(() => readThemeBoot());
	const showApp = !hostedMode() || Boolean(await currentOwner());
	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable} ${display.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			{showApp ? <>
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
						<SidebarProvider>
							<ActivityProvider>
								<AppShell>{children}</AppShell>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			</> : children}
		</body>
		</html>
	);
}
