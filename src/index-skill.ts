import path from "node:path";

import {
  COLLECTIONS_DIR_NAME,
  GENERATED_MARKER,
  INDEX_DESCRIPTION,
  INDEX_SKILL_NAME,
  SKILL_FILE_NAME,
} from "./constants.js";

import type { SkillCollection, SkillRecord } from "./types.js";

function markdownTableCell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}

function relativeSkillPath(indexSkillPath: string, skill: SkillRecord): string {
  return path.relative(indexSkillPath, skill.skillFile).split(path.sep).join("/");
}

function relativeCollectionPath(indexSkillPath: string, collection: SkillCollection): string {
  return path
    .relative(indexSkillPath, path.join(indexSkillPath, COLLECTIONS_DIR_NAME, collection.id, SKILL_FILE_NAME))
    .split(path.sep)
    .join("/");
}

export function generateIndexSkill(
  skills: SkillRecord[],
  indexSkillPath: string,
  collections: SkillCollection[] = [],
): string {
  const collectedSkillIds = new Set(collections.flatMap((collection) => collection.skillIds));
  const sortedCollections = [...collections].sort((left, right) => left.id.localeCompare(right.id));
  const sortedSkills = skills
    .filter((skill) => !collectedSkillIds.has(skill.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const collectionRows = sortedCollections.map((collection) => {
    const collectionPath = relativeCollectionPath(indexSkillPath, collection);
    return `| ${markdownTableCell(collection.title)} | ${markdownTableCell(collection.description)} | \`${collectionPath}\` |`;
  });
  const skillRows = sortedSkills.map((skill) => {
    const skillPath = relativeSkillPath(indexSkillPath, skill);
    return `| \`${markdownTableCell(skill.id)}\` | ${markdownTableCell(skill.description)} | \`${skillPath}\` |`;
  });

  const collectionTableRows =
    collectionRows.length > 0
      ? collectionRows.join("\n")
      : "| _No collections_ | Create a collection to group related managed skills. | _None_ |";
  const skillTableRows =
    skillRows.length > 0 ? skillRows.join("\n") : "| _No uncollected skills_ | All managed skills are grouped above. | _None_ |";

  // This generated skill is intentionally small: it keeps only routing metadata
  // in context while the referenced skill stays unloaded until an agent needs it.
  return `---
name: ${INDEX_SKILL_NAME}
description: ${JSON.stringify(INDEX_DESCRIPTION)}
---

# Skill Index

${GENERATED_MARKER}

Use this skill to decide whether a specialized managed skill should be loaded for the user's request.

When a collection matches the user's request, read its full \`SKILL.md\` file. The collection is a routing manifest containing the descriptions and source paths for its managed skills. Read the full source \`SKILL.md\` for each relevant skill before applying it.

## Collections

| Collection | Description | Path |
| --- | --- | --- |
${collectionTableRows}

## Uncollected Managed Skills

| Skill | Description | Path |
| --- | --- | --- |
${skillTableRows}
`;
}
