import { estimateTokenCount } from "tokenx";
import { describe, expect, it } from "vitest";

import { INDEX_DESCRIPTION, INDEX_SKILL_NAME } from "../src/constants.js";
import { estimateSavedTokens, estimateSkillMetadataTokens } from "../src/tokens.js";

describe("token estimates", () => {
	it("counts each name-and-description pair and subtracts the index metadata", () => {
		const skills = [
			{ id: "api-builder", description: "Build APIs." },
			{ id: "ui-polish", description: "Improve UI quality." },
		];
		const expected = Math.max(
			0,
			estimateTokenCount("api-builder: Build APIs.") +
				estimateTokenCount("ui-polish: Improve UI quality.") -
				estimateTokenCount(`${INDEX_SKILL_NAME}: ${INDEX_DESCRIPTION}`),
		);

		expect(estimateSkillMetadataTokens("api-builder", "Build APIs.")).toBe(
			estimateTokenCount("api-builder: Build APIs."),
		);
		expect(estimateSavedTokens(skills)).toBe(expected);
	});

	it("does not report negative savings for a metadata set smaller than the index", () => {
		expect(estimateSavedTokens([{ id: "a", description: "b" }])).toBe(0);
	});
});
