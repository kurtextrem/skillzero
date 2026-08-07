import { access, constants, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { createTempRoot, writeManagedSkill, writeSkill } from "./helpers.js";

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

  it("rejects selecting more than one harness target", async () => {
    const rootPath = await createTempRoot();

    const result = await captureRun([rootPath, "--claude", "--codex"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Choose exactly one target");
  });

  it("syncs moved skills from every discovered Codex root", async () => {
    const projectPath = await createTempRoot();
    const agentsRoot = path.join(projectPath, ".agents", "skills");
    const codexRoot = path.join(projectPath, ".codex", "skills");
    await writeManagedSkill(agentsRoot, "shared-skill", "---\ndescription: Shared skill.\n---\n");
    await writeManagedSkill(codexRoot, "codex-only", "---\ndescription: Codex-only skill.\n---\n");

    const result = await captureRun([projectPath, "--codex", "--yes"]);

    expect(result.code).toBe(0);
    await expect(
      exists(path.join(agentsRoot, "skill-index", "skills", "shared-skill", "_SKILL.md")),
    ).resolves.toBe(true);
    await expect(
      exists(path.join(codexRoot, "skill-index", "skills", "codex-only", "_SKILL.md")),
    ).resolves.toBe(true);
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

    const result = await captureRun([projectPath, "--codex", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("same SKILL.md file is linked in multiple roots");
  });

  it("syncs an existing positional skills root without a handoff file", async () => {
    const rootPath = await createTempRoot();
    await writeManagedSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const result = await captureRun([rootPath, "--yes"]);

    expect(result.code).toBe(0);
    await expect(exists(path.join(rootPath, "skill-index", "SKILL.md"))).resolves.toBe(true);
    await expect(
      exists(path.join(rootPath, "skill-index", "skills", "ui-polish", "_SKILL.md")),
    ).resolves.toBe(true);
  });

  it("runs collections as an explicit command", async () => {
    const rootPath = await createTempRoot();
    await mkdir(path.join(rootPath, "skill-index"), { recursive: true });

    const result = await captureRunFrom(rootPath, ["collections", "--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No non-top-level skills or collections found");
  });

  it("reports missing paths", async () => {
    const result = await captureRun(["/definitely/not/a/skills/path"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Scope path does not exist");
  });
});
