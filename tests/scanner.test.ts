import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverSkillsRoots, discoverSkillsRootsAtPath } from "../src/discovery.js";
import { scanSkills } from "../src/scanner.js";
import { createTempRoot, writeSkill } from "./helpers.js";

describe("scanSkills", () => {
	it("finds immediate skills while ignoring plural SKILLS.md", async () => {
		const rootPath = await createTempRoot();
		await writeSkill(
			rootPath,
			"api-builder",
			`---
description: Build APIs.
disable-model-invocation: true
---
`,
		);
		const pluralOnly = path.join(rootPath, "plural-only");
		await mkdir(pluralOnly, { recursive: true });
		await writeFile(path.join(pluralOnly, "SKILLS.md"), "ignored", "utf8");

		const inventory = await scanSkills(rootPath);

		expect(inventory.skills).toMatchObject([
			{
				id: "api-builder",
				description: "Build APIs.",
				disableModelInvocation: true,
			},
		]);
	});

	it("uses the first useful body line when frontmatter has no description", async () => {
		const rootPath = await createTempRoot();
		await writeSkill(
			rootPath,
			"test-placement",
			`# Testing Skill

Use this skill for focused test placement.
`,
		);

		const inventory = await scanSkills(rootPath);

		expect(inventory.skills[0]?.description).toBe(
			"Use this skill for focused test placement.",
		);
	});

	it("finds a skill whose directory is a symbolic link", async () => {
		const rootPath = await createTempRoot();
		const sourceRoot = await createTempRoot();
		const sourceSkillPath = await writeSkill(
			sourceRoot,
			"shared-skill",
			"---\ndescription: Shared through a link.\n---\n",
		);
		await symlink(sourceSkillPath, path.join(rootPath, "linked-skill"), "dir");

		const inventory = await scanSkills(rootPath);

		expect(inventory.skills.map((skill) => skill.id)).toEqual(["linked-skill"]);
		expect(inventory.skills[0]?.skillFile).toBe(
			path.join(rootPath, "linked-skill", "SKILL.md"),
		);
	});

	it("deduplicates aliases of one skill within a skills root", async () => {
		const rootPath = await createTempRoot();
		const sourceSkillPath = await writeSkill(
			rootPath,
			"actual-skill",
			"---\ndescription: One physical skill.\n---\n",
		);
		await symlink(sourceSkillPath, path.join(rootPath, "linked-skill"), "dir");

		const inventory = await scanSkills(rootPath);

		expect(inventory.skills.map((skill) => skill.id)).toEqual(["actual-skill"]);
	});

	it("deduplicates linked project skill roots by their physical directory", async () => {
		const projectPath = await createTempRoot();
		const agentsRoot = path.join(projectPath, ".agents", "skills");
		const codexRoot = path.join(projectPath, ".codex", "skills");
		await writeSkill(agentsRoot, "shared-skill", "---\ndescription: Shared root.\n---\n");
		await mkdir(path.dirname(codexRoot), { recursive: true });
		await symlink(agentsRoot, codexRoot, "dir");

		const roots = await discoverSkillsRoots(projectPath);

		expect(roots).toEqual([
			{
				path: agentsRoot,
				realPath: await realpath(agentsRoot),
				aliases: [agentsRoot, codexRoot],
			},
		]);
	});

	it("finds the direct skills root when scoped from its parent directory", async () => {
		const projectPath = await createTempRoot();
		const agentsRoot = path.join(projectPath, ".agents", "skills");
		await writeSkill(agentsRoot, "shared-skill", "---\ndescription: Shared skill.\n---\n");

		await expect(discoverSkillsRootsAtPath(path.join(projectPath, ".agents"))).resolves.toEqual([
			{
				path: agentsRoot,
				realPath: await realpath(agentsRoot),
				aliases: [agentsRoot],
			},
		]);
	});
});
