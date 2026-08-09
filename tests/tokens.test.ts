import { estimateTokenCount } from "tokenx";
import { describe, expect, it } from "vitest";

import { estimateSavedTokens, estimateSkillMetadataTokens } from "../src/tokens.js";

describe("token estimates", () => {
	it("counts hidden metadata and subtracts visible collection metadata", () => {
		const skills = [
			{ id: "api-builder", description: "Build APIs." },
			{ id: "ui-polish", description: "Improve UI quality." },
		];
		const collections = [{ id: "design", description: "Use when designing interfaces." }];
		const expected =
			estimateTokenCount("api-builder: Build APIs.") +
			estimateTokenCount("ui-polish: Improve UI quality.") -
			estimateTokenCount("design: Use when designing interfaces.");

		expect(estimateSkillMetadataTokens("api-builder", "Build APIs.")).toBe(
			estimateTokenCount("api-builder: Build APIs."),
		);
		expect(estimateSavedTokens(skills, collections)).toBe(expected);
	});

	it("does not report negative savings when collection metadata is larger", () => {
		expect(
			estimateSavedTokens(
				[{ id: "a", description: "b" }],
				[{ id: "long-collection", description: "A much longer collection description." }],
			),
		).toBe(0);
	});
});
