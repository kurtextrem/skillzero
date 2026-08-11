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
	// Collection skills remain visible, so their routing metadata still consumes
	// context even though every source skill is explicit-only.
	return Math.max(0, sumTokens(skills) - sumTokens(collections));
}

function sumTokens(items: readonly SkillMetadataForTokenEstimate[]): number {
	return items.reduce(
		(total, item) => total + estimateSkillMetadataTokens(item.id, item.description),
		0,
	);
}
