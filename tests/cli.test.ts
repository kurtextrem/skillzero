import { access, constants } from "node:fs/promises";
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

describe("runCli", () => {
  it("prints a scan summary", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "api-builder", "---\ndescription: Build APIs.\n---\n");

    const result = await captureRun(["scan", "--path", rootPath]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Active skills (1)");
    expect(result.stdout).toContain("api-builder — Build APIs.");
  });

  it("previews a skills-management handoff without prompting", async () => {
    const rootPath = await createTempRoot();

    const result = await captureRun(["manage", "--path", rootPath, "--dry-run"]);

    expect(result.code).toBe(0);
  });

  it("releases managed skills with --yes", async () => {
    const rootPath = await createTempRoot();
    await writeManagedSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const result = await captureRun(["manage", "--path", rootPath, "--yes"]);

    expect(result.code).toBe(0);
    await expect(exists(path.join(rootPath, "ui-polish", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(rootPath, "skill-index", "SKILL.md"))).resolves.toBe(false);
  });

  it("keeps skills added during the handoff visible when sync runs non-interactively", async () => {
    const rootPath = await createTempRoot();
    await writeManagedSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    await captureRun(["manage", "--path", rootPath, "--yes"]);
    await writeSkill(rootPath, "new-skill", "---\ndescription: Added by skills update.\n---\n");

    const result = await captureRun(["sync", "--path", rootPath, "--yes"]);

    expect(result.code).toBe(0);
    await expect(exists(path.join(rootPath, "skill-index", "skills", "ui-polish", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(rootPath, "new-skill", "SKILL.md"))).resolves.toBe(true);
  });

  it("reports missing paths", async () => {
    const result = await captureRun(["scan", "--path", "/definitely/not/a/skills/path"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Skills path does not exist");
  });
});
