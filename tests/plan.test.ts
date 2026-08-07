import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyMovePlan } from "../src/apply.js";
import { buildMovePlan } from "../src/plan.js";
import { scanSkills } from "../src/scanner.js";
import { createTempRoot, writeManagedSkill, writeSkill } from "./helpers.js";

describe("buildMovePlan", () => {
  it("plans active skills selected for the index", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "api-builder", "---\ndescription: Build APIs.\n---\n");

    const inventory = await scanSkills(rootPath);
    const plan = await buildMovePlan(inventory, ["api-builder"]);

    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]?.kind).toBe("move-to-index");
    expect(plan.finalManagedSkills.map((skill) => skill.id)).toEqual(["api-builder"]);
    expect(plan.finalManagedSkills[0]?.skillFile).toBe(
      path.join(rootPath, "skill-index", "skills", "api-builder", "_SKILL.md"),
    );
  });

  it("plans managed skills deselected for restore", async () => {
    const rootPath = await createTempRoot();
    await writeManagedSkill(rootPath, "ui-polish", "---\ndescription: Improve UI.\n---\n");

    const inventory = await scanSkills(rootPath);
    const plan = await buildMovePlan(inventory, []);

    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]?.kind).toBe("restore-to-root");
    expect(plan.operations[0]?.to).toBe(path.join(rootPath, "ui-polish"));
    expect(plan.finalManagedSkills).toEqual([]);
  });

  it("keeps managed skills selected with no folder moves", async () => {
    const rootPath = await createTempRoot();
    await writeManagedSkill(rootPath, "docs", "---\ndescription: Write docs.\n---\n");

    const inventory = await scanSkills(rootPath);
    const plan = await buildMovePlan(inventory, ["docs"]);

    expect(plan.operations).toEqual([]);
    expect(plan.finalManagedSkills.map((skill) => skill.id)).toEqual(["docs"]);
  });

  it("rejects duplicate active and managed skill folder names", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "docs", "---\ndescription: Active docs.\n---\n");
    await writeManagedSkill(rootPath, "docs", "---\ndescription: Managed docs.\n---\n");

    const inventory = await scanSkills(rootPath);

    await expect(buildMovePlan(inventory, ["docs"])).rejects.toThrow("Duplicate active and managed skill names");
  });

  it("rejects restore destinations that already exist", async () => {
    const rootPath = await createTempRoot();
    await writeManagedSkill(rootPath, "docs", "---\ndescription: Managed docs.\n---\n");
    await mkdir(path.join(rootPath, "docs"), { recursive: true });

    const inventory = await scanSkills(rootPath);

    await expect(buildMovePlan(inventory, [])).rejects.toThrow("Move destination already exists");
  });

  it("always hides moved skills even when they disable model invocation", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(
      rootPath,
      "manual-only",
      "---\ndescription: Manual-only skill.\ndisable-model-invocation: true\n---\n",
    );

    const inventory = await scanSkills(rootPath);
    const plan = await buildMovePlan(inventory, ["manual-only"]);

    expect(plan.operations[0]?.kind).toBe("move-to-index");
    expect(plan.finalManagedSkills[0]?.skillFile).toBe(
      path.join(rootPath, "skill-index", "skills", "manual-only", "_SKILL.md"),
    );
    await applyMovePlan(plan);

    await expect(
      access(path.join(rootPath, "skill-index", "skills", "manual-only", "SKILL.md"), constants.F_OK),
    ).rejects.toThrow();
    await expect(
      access(path.join(rootPath, "skill-index", "skills", "manual-only", "_SKILL.md"), constants.F_OK),
    ).resolves.toBeUndefined();
    await expect(scanSkills(rootPath)).resolves.toMatchObject({
      managedSkills: [
        {
          id: "manual-only",
          skillFile: path.join(rootPath, "skill-index", "skills", "manual-only", "_SKILL.md"),
        },
      ],
    });
  });
});
