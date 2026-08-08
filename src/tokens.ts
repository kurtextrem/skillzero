import { estimateTokenCount } from "tokenx";

import { INDEX_DESCRIPTION, INDEX_SKILL_NAME } from "./constants.js";

interface SkillMetadataForTokenEstimate {
	id: string;
	description: string;
}

export function estimateSkillMetadataTokens(name: string, description: string): number {
	return estimateTokenCount(`${name}: ${description}`);
}

export function estimateSavedTokens(skills: readonly SkillMetadataForTokenEstimate[]): number {
	const managedTokens = skills.reduce(
		(total, skill) => total + estimateSkillMetadataTokens(skill.id, skill.description),
		0,
	);
	const indexTokens = estimateSkillMetadataTokens(INDEX_SKILL_NAME, INDEX_DESCRIPTION);

	// The generated index is still visible to the agent, so only the metadata
	// replaced by it counts as saved context.
	return Math.max(0, managedTokens - indexTokens);
}
