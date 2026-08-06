import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverSkillsRoots } from "../src/discovery.js";
import { scanSkills } from "../src/scanner.js";
import { createTempRoot, writeManagedSkill, writeSkill } from "./helpers.js";

describe("scanSkills", () => {
  it("finds active and managed skills while ignoring plural SKILLS.md", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(
      rootPath,
      "api-builder",
      `---
description: Build APIs.
---
`,
    );
    await writeManagedSkill(
      rootPath,
      "ui-polish",
      `---
description: Improve UI quality.
---
`,
    );

    const pluralOnly = path.join(rootPath, "plural-only");
    await mkdir(pluralOnly, { recursive: true });
    await writeFile(path.join(pluralOnly, "SKILLS.md"), "ignored", "utf8");

    const inventory = await scanSkills(rootPath);

    expect(inventory.activeSkills.map((skill) => skill.id)).toEqual(["api-builder"]);
    expect(inventory.managedSkills.map((skill) => skill.id)).toEqual(["ui-polish"]);
  });

  it("refuses to overwrite a non-generated skill-index skill", async () => {
    const rootPath = await createTempRoot();
    const indexPath = path.join(rootPath, "skill-index");
    await mkdir(indexPath, { recursive: true });
    await writeFile(path.join(indexPath, "SKILL.md"), "# Manual Index\n", "utf8");

    await expect(scanSkills(rootPath)).rejects.toThrow("Refusing to overwrite non-generated index skill");
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

    expect(inventory.activeSkills.map((skill) => skill.id)).toEqual(["linked-skill"]);
    expect(inventory.activeSkills[0]?.skillFile).toBe(path.join(rootPath, "linked-skill", "SKILL.md"));
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

    expect(inventory.activeSkills.map((skill) => skill.id)).toEqual(["actual-skill"]);
  });

  it("deduplicates linked project skill roots by their physical directory", async () => {
    const projectPath = await createTempRoot();
    const agentsRoot = path.join(projectPath, ".agents", "skills");
    const codexRoot = path.join(projectPath, ".codex", "skills");
    await writeSkill(agentsRoot, "shared-skill", "---\ndescription: Shared root.\n---\n");
    await mkdir(path.dirname(codexRoot), { recursive: true });
    await symlink(agentsRoot, codexRoot, "dir");

    const roots = await discoverSkillsRoots(projectPath, "codex");

    expect(roots).toEqual([
      {
        path: agentsRoot,
        realPath: await realpath(agentsRoot),
        aliases: [agentsRoot, codexRoot],
      },
    ]);
  });
});
