import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyManagedSkillsPlan,
	buildManagedSkillsPlan,
	formatManagedSkillsPlan,
} from "../src/managed-skills.js";
import { scanSkills } from "../src/scanner.js";
import { createTempRoot, writeSkill } from "./helpers.js";

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

describe("managed skill metadata", () => {
	it("applies explicit-only metadata to every skill and only exposes collection members", async () => {
		const rootPath = await createTempRoot();
		await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");
		await writeSkill(rootPath, "private-notes", "---\ndescription: Read private notes.\n---\n");

		const inventory = await scanSkills(rootPath);
		const plan = await buildManagedSkillsPlan(inventory, ["ui-polish", "private-notes"], null, [
			{
				id: "design",
				title: "Design",
				description: "Use when polishing interfaces.",
				skillIds: ["ui-polish"],
			},
		]);
		expect(plan.finalManagedSkills.map((skill) => skill.id)).toEqual([
			"private-notes",
			"ui-polish",
		]);
		expect(plan.finalHiddenSkills.map((skill) => skill.id)).toEqual(["private-notes"]);
		expect(plan.operations.map((operation) => operation.label)).toEqual([
			"disable-model-invocation",
			"OpenAI policy",
			"disable-model-invocation",
			"OpenAI policy",
		]);
		const formattedPlan = formatManagedSkillsPlan(plan);
		expect(formattedPlan).toContain("- 🔒 Update disable-model-invocation: private-notes");
		expect(formattedPlan).toContain("- 🔒 Add OpenAI policy: private-notes");
		await applyManagedSkillsPlan(plan);

		await expect(exists(path.join(rootPath, "ui-polish", "SKILL.md"))).resolves.toBe(true);
		await expect(readFile(path.join(rootPath, "ui-polish", "SKILL.md"), "utf8")).resolves.toContain(
			"disable-model-invocation: true",
		);
		await expect(
			readFile(path.join(rootPath, "ui-polish", "agents", "openai.yaml"), "utf8"),
		).resolves.toContain("allow_implicit_invocation: false");
		await expect(exists(path.join(rootPath, "skillzero", "SKILL.md"))).resolves.toBe(false);
		await expect(
			readFile(path.join(rootPath, "skillzero", "design", "SKILL.md"), "utf8"),
		).resolves.toContain("ui-polish");
		await expect(
			readFile(path.join(rootPath, "skillzero", "design", "SKILL.md"), "utf8"),
		).resolves.not.toContain("private-notes");
		await expect(
			readFile(path.join(rootPath, "private-notes", "SKILL.md"), "utf8"),
		).resolves.toContain("disable-model-invocation: true");
		const configuredInventory = await scanSkills(rootPath);
		expect(configuredInventory.state).toMatchObject({
			version: 1,
			skills: [{ id: "private-notes" }, { id: "ui-polish" }],
			collections: [{ id: "design", skillIds: ["ui-polish"] }],
		});
		await expect(exists(path.join(rootPath, ".skillzero-state.json"))).resolves.toBe(false);
		await expect(exists(path.join(rootPath, "skillzero", "collections.json"))).resolves.toBe(false);
		await expect(exists(path.join(rootPath, "skillzero", "state.json"))).resolves.toBe(true);

		const refreshedInventory = configuredInventory;
		const noOpPlan = await buildManagedSkillsPlan(
			refreshedInventory,
			["ui-polish", "private-notes"],
			refreshedInventory.state,
		);
		expect(noOpPlan.operations).toEqual([]);
		expect(noOpPlan.collectionPlan.collectionsChanged).toBe(false);
		expect(formatManagedSkillsPlan(noOpPlan)).toContain("Keep 1 skill(s) hidden.");
	});

	it("preserves unrelated Codex metadata and restores the exact original file", async () => {
		const rootPath = await createTempRoot();
		const skillDirectory = await writeSkill(
			rootPath,
			"ui-polish",
			"---\ndescription: Improve UI quality.\n---\n",
		);
		const codexDirectory = path.join(skillDirectory, "agents");
		const codexFile = path.join(codexDirectory, "openai.yaml");
		const originalCodexMetadata = [
			"interface:",
			"  display_name: UI Polish",
			"# Keep this comment.",
			"policy:",
			"  products: [codex]",
			"  allow_implicit_invocation: true # Keep this too.",
			"",
		].join("\n");
		await mkdir(codexDirectory, { recursive: true });
		await writeFile(codexFile, originalCodexMetadata, "utf8");

		const inventory = await scanSkills(rootPath);
		await applyManagedSkillsPlan(await buildManagedSkillsPlan(inventory, ["ui-polish"], null));
		const managedMetadata = await readFile(codexFile, "utf8");
		expect(managedMetadata).toContain("display_name: UI Polish");
		expect(managedMetadata).toContain("# Keep this comment.");
		expect(managedMetadata).toContain("allow_implicit_invocation: false # Keep this too.");

		const managedInventory = await scanSkills(rootPath);
		await applyManagedSkillsPlan(
			await buildManagedSkillsPlan(managedInventory, [], managedInventory.state),
		);
		await expect(readFile(codexFile, "utf8")).resolves.toBe(originalCodexMetadata);
	});

	it("does not remove explicit-only policies owned by the skill author", async () => {
		const rootPath = await createTempRoot();
		const skillDirectory = await writeSkill(
			rootPath,
			"manual-only",
			"---\ndescription: Manual only.\ndisable-model-invocation: true\n---\n",
		);
		await mkdir(path.join(skillDirectory, "agents"), { recursive: true });
		await writeFile(
			path.join(skillDirectory, "agents", "openai.yaml"),
			"policy:\n  allow_implicit_invocation: false\n",
			"utf8",
		);

		const inventory = await scanSkills(rootPath);
		await applyManagedSkillsPlan(await buildManagedSkillsPlan(inventory, ["manual-only"], null));
		const configured = await scanSkills(rootPath);
		const deselectPlan = await buildManagedSkillsPlan(configured, [], configured.state);
		expect(deselectPlan.operations).toEqual([]);
		expect(configured.state).toEqual({
			version: 1,
			knownIds: ["manual-only"],
			skills: [{ id: "manual-only" }],
			collections: [],
		});
		await applyManagedSkillsPlan(deselectPlan);

		await expect(readFile(path.join(skillDirectory, "SKILL.md"), "utf8")).resolves.toContain(
			"disable-model-invocation: true",
		);
		await expect(
			readFile(path.join(skillDirectory, "agents", "openai.yaml"), "utf8"),
		).resolves.toContain("allow_implicit_invocation: false");
	});

	it("restores prior false and true policy values when a skill is deselected", async () => {
		const rootPath = await createTempRoot();
		const skillDirectory = await writeSkill(
			rootPath,
			"ui-polish",
			"---\ndisable-model-invocation: false\ndescription: Improve UI quality.\n---\n",
		);
		await mkdir(path.join(skillDirectory, "agents"), { recursive: true });
		await writeFile(
			path.join(skillDirectory, "agents", "openai.yaml"),
			"policy:\n  allow_implicit_invocation: true\n",
			"utf8",
		);

		const inventory = await scanSkills(rootPath);
		await applyManagedSkillsPlan(await buildManagedSkillsPlan(inventory, ["ui-polish"], null));
		const configured = await scanSkills(rootPath);
		await applyManagedSkillsPlan(await buildManagedSkillsPlan(configured, [], configured.state));

		await expect(readFile(path.join(skillDirectory, "SKILL.md"), "utf8")).resolves.toContain(
			"disable-model-invocation: false",
		);
		await expect(
			readFile(path.join(skillDirectory, "agents", "openai.yaml"), "utf8"),
		).resolves.toContain("allow_implicit_invocation: true");
	});
});
