import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
