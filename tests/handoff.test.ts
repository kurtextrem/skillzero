import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyHandoff, applySync, readHandoffState } from "../src/handoff.js";
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
    await expect(readHandoffState(released)).resolves.toEqual({ version: 1, managedIds: ["ui-polish"] });

    await writeSkill(rootPath, "new-skill", "---\ndescription: Added by skills update.\n---\n");
    const afterUpstreamChange = await scanSkills(rootPath);
    const syncPlan = await buildMovePlan(afterUpstreamChange, ["ui-polish"]);
    await applySync(syncPlan, afterUpstreamChange);

    const restored = await scanSkills(rootPath);
    expect(restored.activeSkills.map((skill) => skill.id)).toEqual(["new-skill"]);
    expect(restored.managedSkills.map((skill) => skill.id)).toEqual(["ui-polish"]);
    await expect(readHandoffState(restored)).resolves.toBeNull();
  });
});
