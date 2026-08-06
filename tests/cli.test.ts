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

describe("runCli", () => {
  it("prints a scan summary", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "api-builder", "---\ndescription: Build APIs.\n---\n");

    const result = await captureRun(["scan", "--path", rootPath]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Active skills (1)");
    expect(result.stdout).toContain("api-builder — Build APIs.");
  });

  it("finds skills that are installed in different project harness roots", async () => {
    const projectPath = await createTempRoot();
    const agentsRoot = path.join(projectPath, ".agents", "skills");
    const codexRoot = path.join(projectPath, ".codex", "skills");
    const geminiRoot = path.join(projectPath, ".gemini", "skills");
    await writeSkill(agentsRoot, "shared-skill", "---\ndescription: Shared skill.\n---\n");
    await writeSkill(codexRoot, "codex-only", "---\ndescription: Codex-only skill.\n---\n");
    await writeSkill(geminiRoot, "gemini-only", "---\ndescription: Gemini-only skill.\n---\n");

    const result = await captureRun(["scan", "--project", projectPath]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(agentsRoot);
    expect(result.stdout).toContain(codexRoot);
    expect(result.stdout).toContain(geminiRoot);
    expect(result.stdout).toContain("shared-skill — Shared skill.");
    expect(result.stdout).toContain("codex-only — Codex-only skill.");
    expect(result.stdout).toContain("gemini-only — Gemini-only skill.");
  });

  it("previews a skills-management handoff without prompting", async () => {
    const rootPath = await createTempRoot();

    const result = await captureRun(["manage", "--path", rootPath, "--dry-run"]);

    expect(result.code).toBe(0);
  });

  it.each(["--codex", "--copilot", "--gemini"])("releases managed skills with %s", async (target) => {
    const rootPath = await createTempRoot();
    await writeManagedSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const result = await captureRun(["manage", "--path", rootPath, target, "--yes"]);

    expect(result.code).toBe(0);
    await expect(exists(path.join(rootPath, "ui-polish", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(rootPath, "skill-index", "SKILL.md"))).resolves.toBe(false);
  });

  it.each(["--claude", "--cursor"])("leaves ordinary skill folders available to the skills CLI with %s", async (target) => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const result = await captureRun(["manage", "--path", rootPath, target, "--yes"]);

    expect(result.code).toBe(0);
    await expect(exists(path.join(rootPath, "ui-polish", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(rootPath, "skill-index", ".skillzero-handoff.json"))).resolves.toBe(false);
  });

  it("rejects selecting more than one harness target", async () => {
    const rootPath = await createTempRoot();

    const result = await captureRun(["manage", "--path", rootPath, "--claude", "--codex"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Choose exactly one target");
  });

  it("releases moved skills from every discovered Codex root", async () => {
    const projectPath = await createTempRoot();
    const agentsRoot = path.join(projectPath, ".agents", "skills");
    const codexRoot = path.join(projectPath, ".codex", "skills");
    await writeManagedSkill(agentsRoot, "shared-skill", "---\ndescription: Shared skill.\n---\n");
    await writeManagedSkill(codexRoot, "codex-only", "---\ndescription: Codex-only skill.\n---\n");

    const result = await captureRun(["manage", "--project", projectPath, "--codex", "--yes"]);

    expect(result.code).toBe(0);
    await expect(exists(path.join(agentsRoot, "shared-skill", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(codexRoot, "codex-only", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(agentsRoot, "skill-index", "SKILL.md"))).resolves.toBe(false);
    await expect(exists(path.join(codexRoot, "skill-index", "SKILL.md"))).resolves.toBe(false);
  });

  it("syncs every released Codex root", async () => {
    const projectPath = await createTempRoot();
    const agentsRoot = path.join(projectPath, ".agents", "skills");
    const codexRoot = path.join(projectPath, ".codex", "skills");
    await writeManagedSkill(agentsRoot, "shared-skill", "---\ndescription: Shared skill.\n---\n");
    await writeManagedSkill(codexRoot, "codex-only", "---\ndescription: Codex-only skill.\n---\n");

    await captureRun(["manage", "--project", projectPath, "--codex", "--yes"]);
    const result = await captureRun(["sync", "--project", projectPath, "--codex", "--yes"]);

    expect(result.code).toBe(0);
    await expect(exists(path.join(agentsRoot, "skill-index", "skills", "shared-skill", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(codexRoot, "skill-index", "skills", "codex-only", "SKILL.md"))).resolves.toBe(true);
  });

  it("releases skills from every discovered Gemini root", async () => {
    const projectPath = await createTempRoot();
    const agentsRoot = path.join(projectPath, ".agents", "skills");
    const geminiRoot = path.join(projectPath, ".gemini", "skills");
    await writeManagedSkill(agentsRoot, "shared-skill", "---\ndescription: Shared skill.\n---\n");
    await writeManagedSkill(geminiRoot, "gemini-only", "---\ndescription: Gemini-only skill.\n---\n");

    const result = await captureRun(["manage", "--project", projectPath, "--gemini", "--yes"]);

    expect(result.code).toBe(0);
    await expect(exists(path.join(agentsRoot, "shared-skill", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(geminiRoot, "gemini-only", "SKILL.md"))).resolves.toBe(true);
    await expect(exists(path.join(agentsRoot, "skill-index", "SKILL.md"))).resolves.toBe(false);
    await expect(exists(path.join(geminiRoot, "skill-index", "SKILL.md"))).resolves.toBe(false);
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

    const result = await captureRun(["manage", "--project", projectPath, "--codex", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("same SKILL.md is linked into multiple roots");
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
