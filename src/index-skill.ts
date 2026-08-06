import path from "node:path";

import { GENERATED_MARKER, INDEX_DESCRIPTION, INDEX_SKILL_NAME } from "./constants.js";

import type { SkillRecord } from "./types.js";

function markdownTableCell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}

function relativeSkillPath(indexSkillPath: string, skill: SkillRecord): string {
  return path.relative(indexSkillPath, skill.skillFile).split(path.sep).join("/");
}

export function generateIndexSkill(skills: SkillRecord[], indexSkillPath: string): string {
  const sortedSkills = [...skills].sort((left, right) => left.id.localeCompare(right.id));
  const rows = sortedSkills.map((skill) => {
    const skillPath = relativeSkillPath(indexSkillPath, skill);
    return `| \`${markdownTableCell(skill.id)}\` | ${markdownTableCell(skill.description)} | \`${skillPath}\` |`;
  });

  const tableRows =
    rows.length > 0 ? rows.join("\n") : "| _No managed skills_ | No managed skills yet. | _None_ |";

  // This generated skill is intentionally small: it keeps only routing metadata
  // in context while the referenced skill stays unloaded until an agent needs it.
  return `---
name: ${INDEX_SKILL_NAME}
description: ${JSON.stringify(INDEX_DESCRIPTION)}
---

# Skill Index

${GENERATED_MARKER}

Use this skill to decide whether a specialized managed skill should be loaded for the user's request.

Before applying any managed skill, read the full \`SKILL.md\` file listed in the table. Do not rely on this index alone when executing a task.

## Managed Skills

| Skill | Description | Path |
| --- | --- | --- |
${tableRows}
`;
}
