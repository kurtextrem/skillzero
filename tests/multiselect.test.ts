import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
	formatSourceLink,
	formatVisibleOptions,
	promptVisibleMultiselect,
} from "../src/multiselect.js";

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

	it("hides transient hints while keeping collection and metadata annotations", () => {
		const options = [
			{
				value: "hidden",
				label: "hidden",
				hint: "transient state",
				hideHintWhenSelected: true,
				annotation: "[H]",
			},
			{
				value: "design",
				label: "design",
				hint: "📚 Other collection",
				annotation: "[!] lacks OpenAI policy",
			},
		];

		expect(formatVisibleOptions(options, 0, ["hidden", "design"], 2)).toEqual([
			"  > [x] hidden [H]",
			"    [x] design (📚 Other collection) [!] lacks OpenAI policy",
		]);
	});

	it("renders skill sources as clickable terminal links", () => {
		expect(formatSourceLink("/tmp/skills/ui polish/SKILL.md")).toBe(
			"\u001B]8;;file:///tmp/skills/ui%20polish/SKILL.md\u0007/tmp/skills/ui polish/SKILL.md\u001B]8;;\u0007",
		);
	});

	it("starts on the first option while preserving checked skills", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let rendered = "";
		output.on("data", (chunk: Buffer) => {
			rendered += chunk.toString("utf8");
		});

		const resultPromise = promptVisibleMultiselect({
			message: "Choose skills",
			options: [
				{ value: "alpha", label: "alpha" },
				{ value: "beta", label: "beta" },
				{ value: "omega", label: "omega" },
			],
			initialValues: ["alpha", "beta", "omega"],
			input,
			output,
		});
		input.write("\r");

		await expect(resultPromise).resolves.toEqual({
			status: "ok",
			selectedIds: ["alpha", "beta", "omega"],
		});
		expect(rendered).toContain("> [x] alpha");
		expect(rendered).not.toContain("> [x] omega");
	});
});
