import { access, constants, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import {
	applyManagedSkillsPlan,
	buildManagedSkillsPlan,
} from "../src/managed-skills.js";
import { scanSkills } from "../src/scanner.js";
import { createTempRoot, writeSkill } from "./helpers.js";

import type { SkillCollection } from "../src/types.js";

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
	const originalWrite = process.stdout.write;

	console.log = (...items: unknown[]) => {
		stdout.push(items.join(" "));
	};
	console.error = (...items: unknown[]) => {
		stderr.push(items.join(" "));
	};
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof originalWrite;

	try {
		const code = await runCli(["node", "skillzero", ...args]);
		return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
	} finally {
		console.log = originalLog;
		console.error = originalError;
		process.stdout.write = originalWrite;
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

describe("skillzero undo and redo", () => {
	it("undoes and redoes metadata and generated collection artifacts", async () => {
		const rootPath = await createTempRoot();
		await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");
		await writeSkill(rootPath, "private-notes", "---\ndescription: Private notes.\n---\n");
		const collections: SkillCollection[] = [
			{
				id: "design",
				title: "Design",
				description: "design tasks.",
				skillIds: ["ui-polish"],
			},
		];
		const inventory = await scanSkills(rootPath);
		await applyManagedSkillsPlan(
			await buildManagedSkillsPlan(
				inventory,
				["ui-polish", "private-notes"],
				null,
				collections,
			),
		);

		const undoResult = await captureRunFrom(rootPath, ["undo", "--yes"]);

		expect(undoResult.code).toBe(0);
		expect(undoResult.stdout).toContain(
			"└  ↩  skillzero changes undone. Run skillzero redo to restore them.",
		);
		await expect(readFile(path.join(rootPath, "ui-polish", "SKILL.md"), "utf8")).resolves.not.toContain(
			"disable-model-invocation: true",
		);
		await expect(exists(path.join(rootPath, "ui-polish", "agents", "openai.yaml"))).resolves.toBe(
			false,
		);
		await expect(
			exists(path.join(rootPath, "private-notes", "agents", "openai.yaml")),
		).resolves.toBe(false);
		await expect(
			exists(path.join(rootPath, "skillzero", "design", "SKILL.md")),
		).resolves.toBe(false);
		await expect(exists(path.join(rootPath, "skillzero"))).resolves.toBe(false);
		await expect(exists(path.join(rootPath, ".skillzero-redo.json"))).resolves.toBe(true);

		const redoResult = await captureRunFrom(rootPath, ["redo", "--yes"]);

		expect(redoResult.code).toBe(0);
		await expect(readFile(path.join(rootPath, "ui-polish", "SKILL.md"), "utf8")).resolves.toContain(
			"disable-model-invocation: true",
		);
		await expect(
			readFile(path.join(rootPath, "ui-polish", "agents", "openai.yaml"), "utf8"),
		).resolves.toContain("allow_implicit_invocation: false");
		await expect(exists(path.join(rootPath, "skillzero", "SKILL.md"))).resolves.toBe(false);
		await expect(
			exists(path.join(rootPath, "skillzero", "design", "SKILL.md")),
		).resolves.toBe(true);
		await expect(exists(path.join(rootPath, "skillzero", "state.json"))).resolves.toBe(true);
		await expect(exists(path.join(rootPath, ".skillzero-redo.json"))).resolves.toBe(false);
		expect((await scanSkills(rootPath)).state).toMatchObject({
			version: 1,
			skills: [{ id: "private-notes" }, { id: "ui-polish" }],
			collections: [{ id: "design", skillIds: ["ui-polish"] }],
		});
		await expect(
			readFile(path.join(rootPath, "skillzero", "design", "SKILL.md"), "utf8"),
		).resolves.not.toContain("private-notes");
	});

	it("reports when redo has no pending undo", async () => {
		const rootPath = await createTempRoot();
		await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

		const result = await captureRunFrom(rootPath, ["redo", "--yes"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("No skillzero undo is waiting to redo");
	});
});
