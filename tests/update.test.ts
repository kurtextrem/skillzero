import { mkdirSync, writeFileSync } from "node:fs";
import { access, constants, readFile, realpath, writeFile } from "node:fs/promises";
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
import { applyManagedSkillsPlan, buildManagedSkillsPlan } from "../src/managed-skills.js";
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

function writeSkillSynchronously(rootPath: string, name: string, content: string): void {
	const directory = path.join(rootPath, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "SKILL.md"), content, "utf8");
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

async function replaceCollections(
	rootPath: string,
	collections: SkillCollection[],
): Promise<string> {
	// Tests that simulate an externally stale collection must preserve the
	// restoration hashes stored beside it in the unified state file.
	const state = (await scanSkills(rootPath)).state;
	if (state === null) {
		throw new Error("Expected configured skillzero state.");
	}

	const stateFile = path.join(rootPath, "skillzero", "state.json");
	await writeFile(stateFile, `${JSON.stringify({ ...state, collections }, null, 2)}\n`, "utf8");
	return stateFile;
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

	it("updates every discovered project root without managing newly installed skills", async () => {
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

		spawnSyncMock.mockImplementation(() => {
			writeSkillSynchronously(
				agentsRoot,
				"new-shared",
				"---\ndescription: |\n  New shared skill.\n  - Nested details should stay out of the notification row.\n---\n",
			);
			writeSkillSynchronously(codexRoot, "new-codex", "---\ndescription: New Codex skill.\n---\n");
			return { status: 0, error: undefined };
		});

		const result = await captureRunFrom(projectPath, ["update", "--yes", "--", "-p", "-y"]);

		expect(result.code).toBe(0);
		expect(spawnSyncMock).toHaveBeenCalledWith("skills", ["update", "-p", "-y"], {
			stdio: "inherit",
		});
		expect(result.stdout).toContain("New skills found");
		expect(result.stdout).toContain("- new-shared — New shared skill.");
		expect(result.stdout).not.toContain("Nested details should stay out of the notification row.");
		await expect(exists(path.join(agentsRoot, "skillzero", "SKILL.md"))).resolves.toBe(false);
		await expect(exists(path.join(codexRoot, "skillzero", "SKILL.md"))).resolves.toBe(false);
		await expect(
			exists(path.join(agentsRoot, "shared-skill", "agents", "openai.yaml")),
		).resolves.toBe(true);
		await expect(exists(path.join(codexRoot, "codex-only", "agents", "openai.yaml"))).resolves.toBe(
			true,
		);
		await expect(exists(path.join(agentsRoot, "new-shared", "SKILL.md"))).resolves.toBe(true);
		await expect(exists(path.join(codexRoot, "new-codex", "SKILL.md"))).resolves.toBe(true);
		await expect(
			exists(path.join(agentsRoot, "new-shared", "agents", "openai.yaml")),
		).resolves.toBe(false);
		await expect(exists(path.join(codexRoot, "new-codex", "agents", "openai.yaml"))).resolves.toBe(
			false,
		);
		expect((await scanSkills(agentsRoot)).state).toMatchObject({
			knownIds: ["new-shared", "shared-skill"],
			skills: [{ id: "shared-skill" }],
		});
		expect((await scanSkills(codexRoot)).state).toMatchObject({
			knownIds: ["codex-only", "new-codex"],
			skills: [{ id: "codex-only" }],
		});

		const secondResult = await captureRunFrom(projectPath, ["update", "--yes", "--", "-p", "-y"]);

		expect(secondResult.code).toBe(0);
		expect(secondResult.stdout).not.toContain("New skills found");
	});

	it("leaves managed metadata intact when skills update fails", async () => {
		const rootPath = await createTempRoot();
		await configureManagedSkill(
			rootPath,
			"ui-polish",
			"---\ndescription: Improve UI quality.\n---\n",
		);
		spawnSyncMock.mockReturnValue({ status: 1, error: undefined });

		const result = await captureRunFrom(rootPath, ["update", "--yes"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("skills update exited with status 1");
		await expect(exists(path.join(rootPath, "ui-polish", "SKILL.md"))).resolves.toBe(true);
		await expect(exists(path.join(rootPath, "ui-polish", "agents", "openai.yaml"))).resolves.toBe(
			true,
		);
	});

	it("manages selected skills and exposes only assigned collection skills", async () => {
		const rootPath = await createTempRoot();
		await writeSkill(rootPath, "collection-skill", "---\ndescription: Collection skill.\n---\n");
		await writeSkill(rootPath, "private", "---\ndescription: Private skill.\n---\n");
		promptConfirmMock.mockResolvedValue(true);
		promptSelectMock
			.mockImplementationOnce((options: { initialValue?: string }) => {
				expect(options.initialValue).toBe("add");
				return Promise.resolve("add");
			})
			.mockImplementationOnce((options: { initialValue?: string }) => {
				expect(options.initialValue).toBe("done");
				return Promise.resolve("done");
			});
		promptTextMock.mockResolvedValueOnce("Design").mockResolvedValueOnce("design tasks.");
		visibleMultiselectMock.mockImplementationOnce(
			(options: { message: string }) => {
				expect(options.message).toContain("Select skills for skillzero to manage");
				return Promise.resolve({
					status: "ok",
					selectedIds: ["collection-skill", "private"],
				});
			},
		);
		visibleMultiselectMock.mockResolvedValueOnce({
			status: "ok",
			selectedIds: ["collection-skill"],
		});

		const configureResult = await captureRunFrom(rootPath, []);

		expect(configureResult.code, configureResult.stderr).toBe(0);
		expect((await scanSkills(rootPath)).state).toMatchObject({
			version: 1,
			skills: [{ id: "collection-skill" }, { id: "private" }],
		});
		await expect(exists(path.join(rootPath, "skillzero", "SKILL.md"))).resolves.toBe(false);
		await expect(
			readFile(path.join(rootPath, "skillzero-design", "SKILL.md"), "utf8"),
		).resolves.toContain("collection-skill");
		visibleMultiselectMock.mockImplementationOnce(
			(options: {
				initialValues: string[];
				message: string;
				options: { value: string; hint?: string }[];
			}) => {
				expect(options.initialValues).toEqual(["collection-skill", "private"]);
				expect(options.message).toContain("Select skills for skillzero to manage");
				expect(options.options.find((option) => option.value === "private")?.hint).toBeUndefined();
				expect(options.options.find((option) => option.value === "collection-skill")?.hint).toBe(
					"📚 Design",
				);
				return Promise.resolve({
					status: "ok",
					selectedIds: ["collection-skill", "private"],
				});
			},
		);
		const previewResult = await captureRunFrom(rootPath, ["--dry-run"]);
		expect(previewResult.code, previewResult.stderr).toBe(0);

		const updateResult = await captureRunFrom(rootPath, ["update", "--yes"]);

		expect(updateResult.code, updateResult.stderr).toBe(0);
		expect(visibleMultiselectMock).toHaveBeenCalledTimes(3);
		expect((await scanSkills(rootPath)).state).toMatchObject({
			skills: [{ id: "collection-skill" }, { id: "private" }],
		});
	});

	it("does not preselect skills for a new explicit root while --yes manages all skills", async () => {
		const explicitRoot = await createTempRoot();
		await writeSkill(explicitRoot, "first", "---\ndescription: First skill.\n---\n");
		await writeSkill(explicitRoot, "second", "---\ndescription: Second skill.\n---\n");
		visibleMultiselectMock.mockImplementationOnce(
			(options: { initialValues: string[]; message: string }) => {
				// An explicit root with no state is a new scope, not proof that every skill is owned.
				expect(options.initialValues).toEqual([]);
				expect(options.message).toContain("Select skills for skillzero to manage");
				return Promise.resolve({ status: "ok", selectedIds: [] });
			},
		);

		const interactiveResult = await captureRun([explicitRoot, "--dry-run"]);

		expect(interactiveResult.code, interactiveResult.stderr).toBe(0);
		expect(visibleMultiselectMock).toHaveBeenCalledTimes(1);

		const yesRoot = await createTempRoot();
		await writeSkill(yesRoot, "first", "---\ndescription: First skill.\n---\n");
		await writeSkill(yesRoot, "second", "---\ndescription: Second skill.\n---\n");

		const yesResult = await captureRun([yesRoot, "--yes"]);

		expect(yesResult.code, yesResult.stderr).toBe(0);
		expect(visibleMultiselectMock).toHaveBeenCalledTimes(1);
		expect((await scanSkills(yesRoot)).state).toMatchObject({
			skills: [{ id: "first" }, { id: "second" }],
		});
	});

	it("selects collection-visible managed skills without removing their memberships", async () => {
		const rootPath = await createTempRoot();
		await writeSkill(rootPath, "collection-skill", "---\ndescription: Collection skill.\n---\n");
		await writeSkill(rootPath, "private", "---\ndescription: Private skill.\n---\n");
		const inventory = await scanSkills(rootPath);
		await applyManagedSkillsPlan(
			await buildManagedSkillsPlan(inventory, ["private"], null, [
				{
					id: "design",
					title: "Design",
					description: "Design tasks.",
					skillIds: ["collection-skill"],
				},
			]),
		);
		promptConfirmMock.mockResolvedValue(true);
		visibleMultiselectMock.mockImplementationOnce(
			(options: { initialValues: string[] }) => {
				expect(options.initialValues).toEqual(["collection-skill", "private"]);
				return Promise.resolve({
					status: "ok",
					selectedIds: ["collection-skill", "private"],
				});
			},
		);

		const result = await captureRunFrom(rootPath, []);

		expect(result.code, result.stderr).toBe(0);
		expect((await scanSkills(rootPath)).state?.collections).toMatchObject([
			{ id: "design", skillIds: ["collection-skill"] },
		]);
	});

	it("asks before removing unknown skills from a collection and preserves them when declined", async () => {
		const rootPath = await createTempRoot();
		await configureManagedSkill(rootPath, "docs", "---\ndescription: Write docs.\n---\n");
		const stateFile = await replaceCollections(rootPath, [
			{
				id: "deslop",
				title: "Deslop",
				description: "Improve text.",
				skillIds: ["docs", "removed-skill"],
			},
		]);
		promptConfirmMock.mockResolvedValue(false);

		const result = await captureRunFrom(rootPath, []);

		expect(result.code).toBe(0);
		expect(promptConfirmMock).toHaveBeenCalledWith({
			message: "Remove from collection?",
			initialValue: true,
		});
		expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
			collections: [{ skillIds: ["docs", "removed-skill"] }],
		});
	});

	it("sorts picker metadata states after ordinary skills", async () => {
		const rootPath = await createTempRoot();
		writeSkillSynchronously(
			rootPath,
			"a-both",
			"---\ndescription: Both markers.\ndisable-model-invocation: true\n---\n",
		);
		writeSkillSynchronously(rootPath, "b-policy", "---\ndescription: Policy only.\n---\n");
		writeSkillSynchronously(
			rootPath,
			"c-frontmatter",
			"---\ndescription: Frontmatter only.\ndisable-model-invocation: true\n---\n",
		);
		writeSkillSynchronously(rootPath, "d-ordinary", "---\ndescription: Ordinary.\n---\n");
		for (const skillId of ["a-both", "b-policy"]) {
			const agentsDirectory = path.join(rootPath, skillId, "agents");
			mkdirSync(agentsDirectory, { recursive: true });
			writeFileSync(
				path.join(agentsDirectory, "openai.yaml"),
				"policy:\n  allow_implicit_invocation: false\n",
				"utf8",
			);
		}
		visibleMultiselectMock.mockImplementationOnce(
			(options: { options: { value: string; annotation?: string }[] }) => {
				expect(options.options.map((option) => [option.value, option.annotation])).toEqual([
					["d-ordinary", undefined],
					["c-frontmatter", "[!] lacks OpenAI policy"],
					["b-policy", "[!] lacks disable-model-invocation"],
					["a-both", "[H]"],
				]);
				return Promise.resolve({
					status: "ok",
					selectedIds: options.options.map((option) => option.value),
				});
			},
		);
		promptSelectMock.mockResolvedValueOnce("done");

		const result = await captureRunFrom(rootPath, ["--dry-run"]);

		expect(result.code, result.stderr).toBe(0);
	});

	it("edits the collection use condition without managing unrelated skills", async () => {
		const rootPath = await createTempRoot();
		await configureManagedSkill(rootPath, "existing", "---\ndescription: Existing skill.\n---\n");
		writeSkillSynchronously(rootPath, "unmanaged", "---\ndescription: Unmanaged skill.\n---\n");
		const stateFile = await replaceCollections(rootPath, [
			{
				id: "design",
				title: "Design",
				description: "Use when design tasks.",
				skillIds: ["existing"],
			},
		]);

		promptSelectMock
			.mockResolvedValueOnce("edit")
			.mockResolvedValueOnce("design")
			.mockResolvedValueOnce("done");
		promptTextMock.mockResolvedValueOnce("Design").mockResolvedValueOnce("visual design work.");
		visibleMultiselectMock.mockImplementationOnce(
			(options: { options: { annotation?: string }[] }) => {
				expect(options.options[0]?.annotation).toBeUndefined();
				return Promise.resolve({ status: "ok", selectedIds: ["existing"] });
			},
		);

		const result = await captureRunFrom(rootPath, ["collections", "--yes"]);

		expect(result.code, result.stderr).toBe(0);
		expect(promptTextMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ message: "Model should use when:", initialValue: "design tasks." }),
		);
		expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
			collections: [{ description: "Use when visual design work." }],
		});
		expect((await scanSkills(rootPath)).state).toMatchObject({
			knownIds: ["existing", "unmanaged"],
			skills: [{ id: "existing" }],
		});
		await expect(exists(path.join(rootPath, "unmanaged", "agents", "openai.yaml"))).resolves.toBe(
			false,
		);
	});

	it("shows managed and available paths before a bare run chooses roots", async () => {
		const projectPath = await createTempRoot();
		const resolvedProjectPath = await realpath(projectPath);
		const managedRoot = path.join(resolvedProjectPath, ".agents", "skills");
		const availableRoot = path.join(resolvedProjectPath, ".codex", "skills");
		const emptyRoot = path.join(resolvedProjectPath, ".cursor", "skills");
		await configureManagedSkill(managedRoot, "managed", "---\ndescription: Managed skill.\n---\n");
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

		const originalHome = process.env["HOME"];
		const originalIsTTY = process.stdin.isTTY;
		process.env["HOME"] = resolvedProjectPath;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		let result: CapturedRun;
		try {
			result = await captureRunFrom(projectPath, ["--yes"]);
		} finally {
			if (originalHome === undefined) {
				Reflect.deleteProperty(process.env, "HOME");
			} else {
				process.env["HOME"] = originalHome;
			}
			if (originalIsTTY === undefined) {
				Reflect.deleteProperty(process.stdin, "isTTY");
			} else {
				Object.defineProperty(process.stdin, "isTTY", {
					value: originalIsTTY,
					configurable: true,
				});
			}
		}

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("Managed by skillzero");
		expect(result.stdout).toContain("Available skill paths");
		expect(result.stdout).toContain(".agents/skills");
		expect(result.stdout).toContain("saves:");
		expect(result.stdout).toContain(".codex/skills");
		await expect(
			exists(path.join(availableRoot, "available", "agents", "openai.yaml")),
		).resolves.toBe(true);
	});

	it("offers collection assignment for a newly selected skill", async () => {
		const rootPath = await createTempRoot();
		await configureManagedSkill(rootPath, "existing", "---\ndescription: Existing skill.\n---\n");
		spawnSyncMock.mockImplementation(() => {
			writeSkillSynchronously(rootPath, "new-skill", "---\ndescription: New skill.\n---\n");
			return { status: 0, error: undefined };
		});

		promptConfirmMock.mockResolvedValue(true);
		promptSelectMock
			.mockImplementationOnce((options: { initialValue?: string }) => {
				expect(options.initialValue).toBe("done");
				return Promise.resolve("add");
			})
			.mockImplementationOnce((options: { initialValue?: string }) => {
				expect(options.initialValue).toBe("done");
				return Promise.resolve("done");
			});
		promptTextMock.mockResolvedValueOnce("Design").mockResolvedValueOnce("design tasks.");
		visibleMultiselectMock
			.mockImplementationOnce((options: { initialValues: string[] }) => {
				expect(options.initialValues).toEqual(["existing"]);
				return Promise.resolve({
					status: "ok",
					selectedIds: ["existing", "new-skill"],
				});
			})
			.mockResolvedValueOnce({
				status: "ok",
				selectedIds: ["new-skill"],
			});

		const result = await captureRunFrom(rootPath, ["update"]);

		expect(result.code).toBe(0);
		await expect(exists(path.join(rootPath, "skillzero-design", "SKILL.md"))).resolves.toBe(
			true,
		);
		await expect(
			readFile(path.join(rootPath, "skillzero-design", "SKILL.md"), "utf8"),
		).resolves.toContain("new-skill");
		expect(promptSelectMock).toHaveBeenCalledTimes(2);
	});
});
