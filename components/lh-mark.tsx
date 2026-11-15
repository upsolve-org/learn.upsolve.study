/**
 * LhMark — UPsolve Learn brand emblem (/logo-mark.png).
 * Replaces the upstream LH spiral mark in the sidebar header and home view.
 */
export function LhMark({ className = "" }: { className?: string }) {
	return (
		<img
			src="/logo-mark.png"
			alt="UPsolve Learn"
			className={`object-contain rounded-[4px] ${className}`}
			aria-hidden="true"
		/>
	);
}
