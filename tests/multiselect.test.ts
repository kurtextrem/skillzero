import { describe, expect, it } from "vitest";

import { formatSourceLink, formatVisibleOptions } from "../src/multiselect.js";

describe("formatVisibleOptions", () => {
	it("shows explicit counts for skills outside the compact viewport", () => {
		const options = Array.from({ length: 6 }, (_, index) => ({
			value: `skill-${index + 1}`,
			label: `skill-${index + 1}`,
		}));

		expect(formatVisibleOptions(options, 3, ["skill-4"], 3)).toEqual([
			"  ↑ 2 more skills",
			"    [ ] skill-3",
			"  > [x] skill-4",
			"    [ ] skill-5",
			"  ↓ 1 more skills",
		]);
	});

	it("hides generic state hints for selected skills but keeps collection hints", () => {
		const options = [
			{ value: "managed", label: "managed", hint: "managed" },
			{ value: "design", label: "design", hint: "📚 Design" },
		];

		expect(formatVisibleOptions(options, 0, ["managed", "design"], 2)).toEqual([
			"  > [x] managed",
			"    [x] design (📚 Design)",
		]);
	});

	it("renders skill sources as clickable terminal links", () => {
		expect(formatSourceLink("/tmp/skills/ui polish/SKILL.md")).toBe(
			"\u001B]8;;file:///tmp/skills/ui%20polish/SKILL.md\u0007/tmp/skills/ui polish/SKILL.md\u001B]8;;\u0007",
		);
	});
});
