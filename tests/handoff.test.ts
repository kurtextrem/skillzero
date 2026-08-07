import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyHandoff, applySync, readHandoffState } from "../src/handoff.js";
import { applyInPlacePlan, buildInPlacePlan, readInPlaceState } from "../src/in-place.js";
import { buildMovePlan } from "../src/plan.js";
import { scanSkills } from "../src/scanner.js";
import { createTempRoot, writeManagedSkill, writeSkill } from "./helpers.js";

describe("temporary skills handoff", () => {
  it("releases managed skills, records the intended set, and restores it after upstream changes", async () => {
    const rootPath = await createTempRoot();
    await writeManagedSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");
    await mkdir(path.join(rootPath, "skill-index"), { recursive: true });

    const beforeHandoff = await scanSkills(rootPath);
    await applyHandoff(await buildMovePlan(beforeHandoff, []), beforeHandoff);

    const released = await scanSkills(rootPath);
    expect(released.activeSkills.map((skill) => skill.id)).toEqual(["ui-polish"]);
    await expect(readHandoffState(released)).resolves.toEqual({
      version: 1,
      managedIds: ["ui-polish"],
    });

    await writeSkill(rootPath, "new-skill", "---\ndescription: Added by skills update.\n---\n");
    const afterUpstreamChange = await scanSkills(rootPath);
    const syncPlan = await buildMovePlan(afterUpstreamChange, ["ui-polish"]);
    await applySync(syncPlan, afterUpstreamChange);

    const restored = await scanSkills(rootPath);
    expect(restored.activeSkills.map((skill) => skill.id)).toEqual(["new-skill"]);
    expect(restored.managedSkills.map((skill) => skill.id)).toEqual(["ui-polish"]);
    await expect(readHandoffState(restored)).resolves.toBeNull();
  });

  it("keeps manual-only skills in place and writes index paths back to their ordinary folders", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const beforeConfigure = await scanSkills(rootPath);
    const plan = await buildInPlacePlan(beforeConfigure, ["ui-polish"], null);
    await applyInPlacePlan(plan, beforeConfigure);

    const skillContent = await readFile(path.join(rootPath, "ui-polish", "SKILL.md"), "utf8");
    expect(skillContent).toContain("disable-model-invocation: true");

    const configured = await scanSkills(rootPath);
    expect(configured.activeSkills.map((skill) => skill.id)).toEqual(["ui-polish"]);
    expect(configured.managedSkills).toEqual([]);
    await expect(
      readFile(path.join(rootPath, "skill-index", "SKILL.md"), "utf8"),
    ).resolves.toContain("../ui-polish/SKILL.md");
    await expect(readInPlaceState(configured)).resolves.toMatchObject({
      version: 1,
      skills: [
        {
          id: "ui-polish",
          owner: "skillzero",
          originalDisableModelInvocation: null,
        },
      ],
    });
  });

  it("does not remove a manual-only policy that an upstream update added itself", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(rootPath, "ui-polish", "---\ndescription: Improve UI quality.\n---\n");

    const initialInventory = await scanSkills(rootPath);
    await applyInPlacePlan(
      await buildInPlacePlan(initialInventory, ["ui-polish"], null),
      initialInventory,
    );

    // Simulate skills update replacing the whole skill directory with a version
    // that independently opts into manual-only invocation.
    await writeSkill(
      rootPath,
      "ui-polish",
      "---\ndisable-model-invocation: true\ndescription: Updated upstream.\n---\n",
    );

    const afterUpdate = await scanSkills(rootPath);
    const stateAfterUpdate = await readInPlaceState(afterUpdate);
    const syncPlan = await buildInPlacePlan(afterUpdate, ["ui-polish"], stateAfterUpdate);
    expect(syncPlan.operations).toEqual([]);
    await applyInPlacePlan(syncPlan, afterUpdate);

    const beforeDeselect = await scanSkills(rootPath);
    const deselectPlan = await buildInPlacePlan(
      beforeDeselect,
      [],
      await readInPlaceState(beforeDeselect),
    );
    expect(deselectPlan.operations).toEqual([]);
    await applyInPlacePlan(deselectPlan, beforeDeselect);

    await expect(readFile(path.join(rootPath, "ui-polish", "SKILL.md"), "utf8")).resolves.toContain(
      "disable-model-invocation: true",
    );
    await expect(readInPlaceState(await scanSkills(rootPath))).resolves.toBeNull();
  });

  it("restores a skillzero-owned false policy when a skill is deselected", async () => {
    const rootPath = await createTempRoot();
    await writeSkill(
      rootPath,
      "ui-polish",
      "---\ndisable-model-invocation: false\ndescription: Improve UI quality.\n---\n",
    );

    const beforeConfigure = await scanSkills(rootPath);
    await applyInPlacePlan(
      await buildInPlacePlan(beforeConfigure, ["ui-polish"], null),
      beforeConfigure,
    );

    const beforeDeselect = await scanSkills(rootPath);
    await applyInPlacePlan(
      await buildInPlacePlan(beforeDeselect, [], await readInPlaceState(beforeDeselect)),
      beforeDeselect,
    );

    await expect(readFile(path.join(rootPath, "ui-polish", "SKILL.md"), "utf8")).resolves.toContain(
      "disable-model-invocation: false",
    );
  });
});
