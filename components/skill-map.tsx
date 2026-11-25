interface Skill {
	label: string;
	level: number;
	focus: boolean;
	note: string;
}

export interface SkillMapData {
	topic: string;
	overall: number;
	skills: Skill[];
}

export function parseSkillMap(language: string, source: string): SkillMapData | null {
	const legacy = language !== "skill-map";
	if (legacy && (!["", "text", "plaintext", "txt", "ascii"].includes(language) || !/^\s*Topic:/i.test(source))) return null;
	const [heading, ...rows] = source.trim().split(/\r?\n/);
	const header = /^Topic:\s*(.+?)\s+overall:\s*(?:\[?[█▓▒░▏▎▍▌▋▊▉ ]+\]?\s*)?(\d+(?:\.\d+)?)\s*%$/i.exec(heading?.trim() ?? "");
	if (!header || Number(header[2]) > 100) return null;
	const skills: Skill[] = [];
	for (const line of rows) {
		const row = line.trim();
		if (!row || /^[-─━=]+$/.test(row)) continue;
		const match = legacy
			? /^(.+?)\s+\[[█▓▒░▏▎▍▌▋▊▉ #=.\-]+\]\s*([0-5])\s*\/\s*5\b(.*)$/.exec(row)
			: /^(.+?)\s+([0-5])\/5\b(.*)$/.exec(row);
		if (!match) return null;
		const focusMarker = /(?:<-|←|\*)?\s*current focus\b/i;
		skills.push({
			label: match[1]!.trim(),
			level: Number(match[2]),
			focus: focusMarker.test(match[3]!),
			note: match[3]!.replace(focusMarker, "").trim().replace(/^\*\s*/, ""),
		});
	}
	return skills.length ? { topic: header[1]!, overall: Number(header[2]), skills } : null;
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
	return <div role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}
		className="h-1.5 overflow-hidden rounded-full bg-muted">
		<div className="h-full rounded-full bg-(--lh-success)" style={{ width: `${100 * value / max}%` }} />
	</div>;
}

export function SkillMap({ map }: { map: SkillMapData }) {
	return <section aria-label={map.topic} className="my-4 max-w-2xl space-y-4 border-y border-border py-4">
		<div className="space-y-2">
			<div className="flex items-baseline justify-between gap-3">
				<strong className="min-w-0 break-words">{map.topic}</strong>
				<span className="shrink-0 text-sm tabular-nums">{map.overall}% overall</span>
			</div>
			<Bar label={`${map.topic} overall`} value={map.overall} max={100} />
		</div>
		<div className="grid gap-3">
			{map.skills.map((skill, i) => <div key={i} className="space-y-1">
				<div className="flex items-baseline justify-between gap-3 text-sm">
					<span className="min-w-0 break-words">{skill.label}
						{skill.focus && <span className="ml-2 font-medium text-(--lh-success)">Current focus</span>}
						{skill.note && <span className="ml-2 text-muted-foreground">{skill.note}</span>}
					</span>
					<span className="shrink-0 tabular-nums">{skill.level}/5</span>
				</div>
				<Bar label={skill.label} value={skill.level} max={5} />
			</div>)}
		</div>
	</section>;
}
