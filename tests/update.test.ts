import { mkdirSync, writeFileSync } from "node:fs";
import { access, constants, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const promptSelectMock = vi.hoisted(() => vi.fn());
const promptTextMock = vi.hoisted(() => vi.fn());
const promptConfirmMock = vi.hoisted(() => vi.fn());
const promptMultiselectMock = vi.hoisted(() => vi.fn());
const visibleMultiselectMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
vi.mock("@clack/prompts", async () => {
	const actual = await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts");
	return {
		...actual,
		select: promptSelectMock,
		text: promptTextMock,
		confirm: promptConfirmMock,
		multiselect: promptMultiselectMock,
	};
});
vi.mock("../src/multiselect.js", () => ({
	promptVisibleMultiselect: visibleMultiselectMock,
}));

import { runCli } from "../src/cli.js";
import { createTempRoot, writeManagedSkill } from "./helpers.js";

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

function writeSkillSynchronously(rootPath: string, name: string, content: string): void {
	const directory = path.join(rootPath, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "SKILL.md"), content, "utf8");
}

describe("skillzero update", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
		spawnSyncMock.mockReturnValue({ status: 0, error: undefined });
		promptSelectMock.mockReset();
		promptTextMock.mockReset();
		promptConfirmMock.mockReset();
		promptMultiselectMock.mockReset();
		visibleMultiselectMock.mockReset();
	});

	it("updates every discovered project root, forwards skills args, and rebuilds the indexes", async () => {
		const projectPath = await createTempRoot();
		const agentsRoot = path.join(projectPath, ".agents", "skills");
		const codexRoot = path.join(projectPath, ".codex", "skills");
		await writeManagedSkill(agentsRoot, "shared-skill", "---\ndescription: Shared skill.\n---\n");
		await writeManagedSkill(codexRoot, "codex-only", "---\ndescription: Codex-only skill.\n---\n");

		spawnSyncMock.mockImplementation(() => {
			writeSkillSynchronously(
				agentsRoot,
				"new-shared",
				"---\ndescription: |\n  New shared skill.\n  - Nested details should stay out of the notification row.\n---\n",
			);
			writeSkillSynchronously(codexRoot, "new-codex", "---\ndescription: New Codex skill.\n---\n");
			return { status: 0, error: undefined };
		});

		const result = await captureRunFrom(projectPath, [
			"update",
			"--codex",
			"--yes",
			"--",
			"-p",
			"-y",
		]);

		expect(result.code).toBe(0);
		expect(spawnSyncMock).toHaveBeenCalledWith("skills", ["update", "-p", "-y"], {
			stdio: "inherit",
		});
		expect(result.stdout).toContain("New skills found");
		expect(result.stdout).toContain("- new-shared — New shared skill.");
		expect(result.stdout).not.toContain("Nested details should stay out of the notification row.");
		await expect(exists(path.join(agentsRoot, "skill-index", "SKILL.md"))).resolves.toBe(true);
		await expect(exists(path.join(codexRoot, "skill-index", "SKILL.md"))).resolves.toBe(true);
		await expect(
			exists(path.join(agentsRoot, "skill-index", "skills", "shared-skill", "_SKILL.md")),
		).resolves.toBe(true);
		await expect(
			exists(path.join(codexRoot, "skill-index", "skills", "codex-only", "_SKILL.md")),
		).resolves.toBe(true);
		await expect(exists(path.join(agentsRoot, "new-shared", "SKILL.md"))).resolves.toBe(true);
		await expect(exists(path.join(codexRoot, "new-codex", "SKILL.md"))).resolves.toBe(true);

		const secondResult = await captureRunFrom(projectPath, [
			"update",
			"--codex",
			"--yes",
			"--",
			"-p",
			"-y",
		]);

		expect(secondResult.code).toBe(0);
		expect(secondResult.stdout).not.toContain("New skills found");
	});

	it("leaves the original layout released when skills update fails", async () => {
		const rootPath = await createTempRoot();
		await writeManagedSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");
		spawnSyncMock.mockReturnValue({ status: 1, error: undefined });

		const result = await captureRunFrom(rootPath, ["update", "--codex", "--yes"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("skills update exited with status 1");
		await expect(exists(path.join(rootPath, "ui-polish", "SKILL.md"))).resolves.toBe(true);
		await expect(exists(path.join(rootPath, "skill-index", "SKILL.md"))).resolves.toBe(false);
		await expect(
			exists(path.join(rootPath, "skill-index", ".skillzero-handoff.json")),
		).resolves.toBe(true);
	});

	it("offers collection setup during initial configuration", async () => {
		const rootPath = await createTempRoot();
		await writeSkillSynchronously(rootPath, "existing", "---\ndescription: Existing skill.\n---\n");

		promptConfirmMock.mockResolvedValue(true);
		promptSelectMock.mockResolvedValueOnce("add").mockResolvedValueOnce("done");
		promptTextMock.mockResolvedValueOnce("Design").mockResolvedValueOnce("Read for design tasks.");
		visibleMultiselectMock
			.mockResolvedValueOnce({ status: "ok", selectedIds: ["existing"] })
			.mockResolvedValueOnce({ status: "ok", selectedIds: ["existing"] });

		const result = await captureRunFrom(rootPath, ["--codex"]);

		expect(result.code).toBe(0);
		await expect(
			exists(path.join(rootPath, "skill-index", "collections", "design", "SKILL.md")),
		).resolves.toBe(true);
		expect(promptSelectMock).toHaveBeenCalledTimes(2);
	});

	it("shows managed and available paths before a bare run chooses roots", async () => {
		const projectPath = await createTempRoot();
		const resolvedProjectPath = await realpath(projectPath);
		const managedRoot = path.join(resolvedProjectPath, ".agents", "skills");
		const availableRoot = path.join(resolvedProjectPath, ".codex", "skills");
		const emptyRoot = path.join(resolvedProjectPath, ".cursor", "skills");
		mkdirSync(path.join(managedRoot, "skill-index"), { recursive: true });
		writeFileSync(
			path.join(managedRoot, "skill-index", "SKILL.md"),
			"<!-- Generated by skillzero. Do not edit manually. -->\n",
			"utf8",
		);
		await writeManagedSkill(managedRoot, "managed", "---\ndescription: Managed skill.\n---\n");
		writeSkillSynchronously(
			availableRoot,
			"available",
			"---\ndescription: Available skill.\n---\n",
		);
		mkdirSync(emptyRoot, { recursive: true });

		promptMultiselectMock.mockImplementation((options) => {
			const values = options.options.map((option: { value: string }) => option.value);
			expect(values).toEqual(expect.arrayContaining([managedRoot, availableRoot]));
			expect(values).not.toContain(emptyRoot);
			expect(options.initialValues).toContain(managedRoot);
			return Promise.resolve([availableRoot]);
		});
		promptSelectMock.mockResolvedValue("done");
		visibleMultiselectMock.mockResolvedValue({
			status: "ok",
			selectedIds: ["available"],
		});

		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		let result: CapturedRun;
		try {
			result = await captureRunFrom(projectPath, ["--yes"]);
		} finally {
			if (originalIsTTY === undefined) {
				Reflect.deleteProperty(process.stdin, "isTTY");
			} else {
				Object.defineProperty(process.stdin, "isTTY", {
					value: originalIsTTY,
					configurable: true,
				});
			}
		}

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Managed by skillzero");
		expect(result.stdout).toContain("Available skill paths");
		expect(result.stdout).toContain(".agents/skills");
		expect(result.stdout).toContain("saves:");
		expect(result.stdout).toContain(".codex/skills");
		await expect(
			exists(path.join(availableRoot, "skill-index", "skills", "available", "_SKILL.md")),
		).resolves.toBe(true);
	});

	it("skips apply confirmation when a sync preview has no changes", async () => {
		const rootPath = await createTempRoot();
		await writeSkillSynchronously(rootPath, "existing", "---\ndescription: Existing skill.\n---\n");

		promptConfirmMock.mockResolvedValue(true);
		promptSelectMock.mockResolvedValueOnce("add").mockResolvedValueOnce("done");
		promptTextMock.mockResolvedValueOnce("Design").mockResolvedValueOnce("Read for design tasks.");
		visibleMultiselectMock
			.mockResolvedValueOnce({ status: "ok", selectedIds: ["existing"] })
			.mockResolvedValueOnce({ status: "ok", selectedIds: ["existing"] });

		await expect(captureRunFrom(rootPath, ["--codex"])).resolves.toMatchObject({
			code: 0,
		});

		promptSelectMock.mockReset();
		promptTextMock.mockReset();
		visibleMultiselectMock.mockReset();
		promptConfirmMock.mockImplementation(() => {
			throw new Error("confirmation should not be requested for a no-op");
		});
		visibleMultiselectMock.mockResolvedValue({
			status: "ok",
			selectedIds: ["existing"],
		});

		const result = await captureRunFrom(rootPath, []);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("No changes needed.");
		expect(result.stdout).not.toContain("Apply these changes?");
	});

	it("offers collection setup when syncing an existing path without collections", async () => {
		const rootPath = await createTempRoot();
		await writeManagedSkill(rootPath, "existing", "---\ndescription: Existing skill.\n---\n");

		promptConfirmMock.mockResolvedValue(true);
		promptSelectMock.mockResolvedValueOnce("add").mockResolvedValueOnce("done");
		promptTextMock.mockResolvedValueOnce("Design").mockResolvedValueOnce("Read for design tasks.");
		visibleMultiselectMock
			.mockResolvedValueOnce({ status: "ok", selectedIds: ["existing"] })
			.mockResolvedValueOnce({ status: "ok", selectedIds: ["existing"] });

		const result = await captureRunFrom(rootPath, ["--codex"]);

		expect(result.code).toBe(0);
		await expect(
			exists(path.join(rootPath, "skill-index", "collections", "design", "SKILL.md")),
		).resolves.toBe(true);
		expect(promptSelectMock).toHaveBeenCalledTimes(2);
	});

	it("asks for collection assignments when a new skill is selected", async () => {
		const rootPath = await createTempRoot();
		await writeManagedSkill(rootPath, "existing", "---\ndescription: Existing skill.\n---\n");
		spawnSyncMock.mockImplementation(() => {
			writeSkillSynchronously(rootPath, "new-skill", "---\ndescription: New skill.\n---\n");
			return { status: 0, error: undefined };
		});

		promptConfirmMock.mockResolvedValue(true);
		promptSelectMock.mockResolvedValueOnce("add").mockResolvedValueOnce("done");
		promptTextMock.mockResolvedValueOnce("Design").mockResolvedValueOnce("Read for design tasks.");
		visibleMultiselectMock
			.mockResolvedValueOnce({
				status: "ok",
				selectedIds: ["existing", "new-skill"],
			})
			.mockResolvedValueOnce({
				status: "ok",
				selectedIds: ["existing", "new-skill"],
			});

		const result = await captureRunFrom(rootPath, ["update", "--codex"]);

		expect(result.code).toBe(0);
		await expect(
			exists(path.join(rootPath, "skill-index", "collections", "design", "SKILL.md")),
		).resolves.toBe(true);
		await expect(
			readFile(path.join(rootPath, "skill-index", "collections", "design", "SKILL.md"), "utf8"),
		).resolves.toContain("new-skill");
		expect(promptSelectMock).toHaveBeenCalledTimes(2);
	});
});
