import { access, constants, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyMovePlan } from "../src/apply.js";
import { buildInPlacePlan, applyInPlacePlan } from "../src/in-place.js";
import { runCli } from "../src/cli.js";
import { buildMovePlan } from "../src/plan.js";
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

  console.log = (...items: unknown[]) => {
    stdout.push(items.join(" "));
  };
  console.error = (...items: unknown[]) => {
    stderr.push(items.join(" "));
  };

  try {
    const code = await runCli(["node", "skillzero", ...args]);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
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

describe("skillzero undo and redo", () => {
  it("undoes and redoes a move-based layout", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const configuredInventory = await scanSkills(rootPath);
    const collections: SkillCollection[] = [
      {
        id: "design",
        title: "Design",
        description: "Read for design tasks.",
        skillIds: ["ui-polish"],
      },
    ];
    await applyMovePlan(
      await buildMovePlan(configuredInventory, ["ui-polish"], collections),
    );

    const undoResult = await captureRunFrom(rootPath, ["undo", "--yes"]);

    expect(undoResult.code).toBe(0);
    await expect(exists(path.join(rootPath, "ui-polish", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(rootPath, "skill-index", "SKILL.md"))).resolves.toBe(false);
    await expect(exists(path.join(rootPath, "skill-index", "collections", "design", "SKILL.md"))).resolves.toBe(false);
    await expect(exists(path.join(rootPath, "skill-index", "collections.json"))).resolves.toBe(false);
    await expect(exists(path.join(rootPath, ".skillzero-redo.json"))).resolves.toBe(true);

    const redoResult = await captureRunFrom(rootPath, ["redo", "--yes"]);

    expect(redoResult.code).toBe(0);
    await expect(exists(path.join(rootPath, "skill-index", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(rootPath, "skill-index", "skills", "ui-polish", "_SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(rootPath, "skill-index", "collections", "design", "SKILL.md"))).resolves.toBe(true);
    await expect(readFile(path.join(rootPath, "skill-index", "SKILL.md"), "utf8")).resolves.toContain(
      "collections/design/SKILL.md",
    );
    await expect(exists(path.join(rootPath, ".skillzero-redo.json"))).resolves.toBe(false);
  });

  it("undoes and redoes an in-place layout", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const configuredInventory = await scanSkills(rootPath);
    await applyInPlacePlan(
      await buildInPlacePlan(configuredInventory, ["ui-polish"], null),
      configuredInventory,
    );

    const undoResult = await captureRunFrom(rootPath, ["undo", "--yes"]);

    expect(undoResult.code).toBe(0);
    await expect(readFile(path.join(rootPath, "ui-polish", "SKILL.md"), "utf8")).resolves.not.toContain(
      "disable-model-invocation: true",
    );
    await expect(exists(path.join(rootPath, "skill-index", "SKILL.md"))).resolves.toBe(false);
    await expect(exists(path.join(rootPath, ".skillzero-in-place.json"))).resolves.toBe(false);

    const redoResult = await captureRunFrom(rootPath, ["redo", "--yes"]);

    expect(redoResult.code).toBe(0);
    await expect(readFile(path.join(rootPath, "ui-polish", "SKILL.md"), "utf8")).resolves.toContain(
      "disable-model-invocation: true",
    );
    await expect(exists(path.join(rootPath, "skill-index", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(rootPath, ".skillzero-in-place.json"))).resolves.toBe(true);
  });

  it("reports when redo has no pending undo", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const result = await captureRunFrom(rootPath, ["redo", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No skillzero undo is waiting to redo");
  });
});
