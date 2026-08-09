import { estimateTokenCount } from "tokenx";

interface SkillMetadataForTokenEstimate {
	id: string;
	description: string;
}

export function estimateSkillMetadataTokens(name: string, description: string): number {
	return estimateTokenCount(`${name}: ${description}`);
}

export function estimateSavedTokens(
	skills: readonly SkillMetadataForTokenEstimate[],
	collections: readonly SkillMetadataForTokenEstimate[] = [],
): number {
	const managedTokens = skills.reduce(
		(total, skill) => total + estimateSkillMetadataTokens(skill.id, skill.description),
		0,
	);
	const collectionTokens = collections.reduce(
		(total, collection) =>
			total + estimateSkillMetadataTokens(collection.id, collection.description),
		0,
	);

	// Collection skills remain visible, so their routing metadata still consumes
	// context even though every source skill is explicit-only.
	return Math.max(0, managedTokens - collectionTokens);
}
