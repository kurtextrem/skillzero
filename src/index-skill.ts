import path from "node:path";

import { GENERATED_MARKER, INDEX_DESCRIPTION, INDEX_SKILL_NAME } from "./constants.js";

import type { SkillRecord } from "./types.js";

function markdownTableCell(value: string): string {
	return value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}

function relativeSkillPath(indexSkillPath: string, skill: SkillRecord): string {
	return path.relative(indexSkillPath, skill.skillFile).split(path.sep).join("/");
}

export function generateIndexSkill(
	skills: readonly SkillRecord[],
	indexSkillPath: string,
): string {
	// Rendering must not reorder the caller's domain records. Plans own their
	// ordering, while this module only owns the emitted representation.
	const sortedSkills = [...skills].sort((left, right) => left.id.localeCompare(right.id));
	const skillRows = sortedSkills.map((skill) => {
		const skillPath = relativeSkillPath(indexSkillPath, skill);
		return `| \`${markdownTableCell(skill.id)}\` | ${markdownTableCell(skill.description)} | \`${skillPath}\` |`;
	});

	const skillTableRows = skillRows.join("\n");

	return `---
name: ${INDEX_SKILL_NAME}
description: ${JSON.stringify(INDEX_DESCRIPTION)}
---
# Skill Index

${GENERATED_MARKER}

When a user request matches any of the skill(s), read the source.

| Skill | Description | Path |
| --- | --- | --- |
${skillTableRows}
`;
}
