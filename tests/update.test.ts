import { mkdirSync, writeFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

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
  });

  it("updates every discovered project root, forwards skills args, and rebuilds the indexes", async () => {
    const projectPath = await createTempRoot();
    const agentsRoot = path.join(projectPath, ".agents", "skills");
    const codexRoot = path.join(projectPath, ".codex", "skills");
    await writeManagedSkill(agentsRoot, "shared-skill", "---\ndescription: Shared skill.\n---\n");
    await writeManagedSkill(codexRoot, "codex-only", "---\ndescription: Codex-only skill.\n---\n");

    spawnSyncMock.mockImplementation(() => {
      writeSkillSynchronously(agentsRoot, "new-shared", "---\ndescription: New shared skill.\n---\n");
      writeSkillSynchronously(codexRoot, "new-codex", "---\ndescription: New Codex skill.\n---\n");
      return { status: 0, error: undefined };
    });

    const result = await captureRunFrom(projectPath, ["update", "--codex", "--yes", "--", "-p", "-y"]);

    expect(result.code).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "skills",
      ["update", "-p", "-y"],
      { stdio: "inherit" },
    );
    expect(result.stdout).toContain("New skills available");
    await expect(exists(path.join(agentsRoot, "skill-index", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(codexRoot, "skill-index", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(agentsRoot, "skill-index", "skills", "shared-skill", "_SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(codexRoot, "skill-index", "skills", "codex-only", "_SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(agentsRoot, "new-shared", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(codexRoot, "new-codex", "SKILL.md"))).resolves.toBe(true);
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
    await expect(exists(path.join(rootPath, "skill-index", ".skillzero-handoff.json"))).resolves.toBe(true);
  });
});
