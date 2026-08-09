import { describe, expect, it } from "vitest";

import { EMOJI } from "../src/ui.js";

describe("EMOJI", () => {
	it("uses variation-selector-free glyphs for terminal alignment", () => {
		const unstableGlyphs = Object.entries(EMOJI)
			.filter(([, glyph]) => glyph.includes("\uFE0F"))
			.map(([name]) => name);

		expect(unstableGlyphs).toEqual([]);
	});
});
