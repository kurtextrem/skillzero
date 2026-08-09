import { access, constants, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { applyManagedSkillsPlan, buildManagedSkillsPlan } from "../src/managed-skills.js";
import { scanSkills } from "../src/scanner.js";
import { createTempRoot, writeSkill } from "./helpers.js";

interface CapturedRun {
	code: number;
	stdout: string;
	stderr: string;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function captureRun(args: string[]): Promise<CapturedRun> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;

	console.log = (...items: unknown[]) => {
		stdout.push(items.join(" "));
	};
	console.error = (...items: unknown[]) => {
		stderr.push(items.join(" "));
	};

	try {
		const code = await runCli(["node", "skillzero", ...args]);
		return {
			code,
			stdout: stdout.join("\n"),
			stderr: stderr.join("\n"),
		};
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}

async function captureRunFrom(cwd: string, args: string[]): Promise<CapturedRun> {
	const originalCwd = process.cwd();
	process.chdir(cwd);
	try {
		return await captureRun(args);
	} finally {
		process.chdir(originalCwd);
	}
}

async function configureManagedSkill(
	rootPath: string,
	name: string,
	content: string,
): Promise<void> {
	await writeSkill(rootPath, name, content);
	const inventory = await scanSkills(rootPath);
	await applyManagedSkillsPlan(await buildManagedSkillsPlan(inventory, [name], null));
}

describe("runCli", () => {
	it("returns cleanly for root help without entering the default flow", async () => {
		const result = await captureRun(["--help"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("previews an empty positional skills root without prompting", async () => {
		const rootPath = await createTempRoot();

		const result = await captureRun([rootPath, "--dry-run"]);

		expect(result.code).toBe(0);
	});

	it("syncs managed metadata from every discovered root", async () => {
		const projectPath = await createTempRoot();
		const agentsRoot = path.join(projectPath, ".agents", "skills");
		const codexRoot = path.join(projectPath, ".codex", "skills");
		await configureManagedSkill(
			agentsRoot,
			"shared-skill",
			"---\ndescription: Shared skill.\n---\n",
		);
		await configureManagedSkill(
			codexRoot,
			"codex-only",
			"---\ndescription: Codex-only skill.\n---\n",
		);

		const result = await captureRun([projectPath, "--yes"]);

		expect(result.code).toBe(0);
		await expect(
			exists(path.join(agentsRoot, "shared-skill", "agents", "openai.yaml")),
		).resolves.toBe(true);
		await expect(exists(path.join(codexRoot, "codex-only", "agents", "openai.yaml"))).resolves.toBe(
			true,
		);
	});

	it("refuses to mutate one SKILL.md linked into separate discovered roots", async () => {
		const projectPath = await createTempRoot();
		const sourceSkillPath = await writeSkill(
			path.join(projectPath, "shared-source"),
			"linked-skill",
			"---\ndescription: Linked into two roots.\n---\n",
		);
		const agentsRoot = path.join(projectPath, ".agents", "skills");
		const codexRoot = path.join(projectPath, ".codex", "skills");
		await mkdir(agentsRoot, { recursive: true });
		await mkdir(codexRoot, { recursive: true });
		await symlink(sourceSkillPath, path.join(agentsRoot, "linked-skill"), "dir");
		await symlink(sourceSkillPath, path.join(codexRoot, "linked-skill"), "dir");

		const result = await captureRun([projectPath, "--yes"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("same SKILL.md file is linked in multiple roots");
	});

	it("syncs an existing positional skills root", async () => {
		const rootPath = await createTempRoot();
		await configureManagedSkill(
			rootPath,
			"ui-polish",
			"---\ndescription: Improve UI quality.\n---\n",
		);

		const result = await captureRun([rootPath, "--yes"]);

		expect(result.code).toBe(0);
		await expect(exists(path.join(rootPath, "skillzero", "SKILL.md"))).resolves.toBe(false);
		await expect(exists(path.join(rootPath, "ui-polish", "agents", "openai.yaml"))).resolves.toBe(
			true,
		);
	});

	it("removes stale collection memberships during an approved sync", async () => {
		const rootPath = await createTempRoot();
		await configureManagedSkill(rootPath, "docs", "---\ndescription: Write docs.\n---\n");
		const state = (await scanSkills(rootPath)).state;
		if (state === null) {
			throw new Error("Expected configured skillzero state.");
		}
		const stateFile = path.join(rootPath, "skillzero", "state.json");
		await writeFile(
			stateFile,
			`${JSON.stringify(
				{
					...state,
					collections: [
						{
							id: "deslop",
							title: "Deslop",
							description: "Improve text.",
							skillIds: ["docs", "removed-skill"],
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await captureRun([rootPath, "--yes"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
			collections: [{ id: "deslop", skillIds: ["docs"] }],
		});
	});

	it("runs collections as an explicit command", async () => {
		const rootPath = await createTempRoot();
		await mkdir(path.join(rootPath, "skillzero"), { recursive: true });

		const result = await captureRunFrom(rootPath, ["collections", "--dry-run"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("No collection skills or collections found");
	});

	it("reports missing paths", async () => {
		const result = await captureRun(["/definitely/not/a/skills/path"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Scope path does not exist");
	});
});
