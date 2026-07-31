import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateIndexSkill } from "./index-skill.js";

import type { MovePlan } from "./types.js";

export async function applyMoveOperations(plan: MovePlan): Promise<void> {
  // Plans validate every source and destination before this point. Keeping the
  // move loop separate lets the temporary handoff reuse the same safe moves
  // without recreating a public skill-index during an upstream `skills` run.
  for (const operation of plan.operations) {
    await mkdir(path.dirname(operation.to), { recursive: true });
    await rename(operation.from, operation.to);
  }
}

export async function applyMovePlan(plan: MovePlan): Promise<void> {
  await mkdir(plan.managedSkillsPath, { recursive: true });
  await applyMoveOperations(plan);

  await mkdir(plan.indexSkillPath, { recursive: true });
  await writeFile(plan.indexSkillFile, generateIndexSkill(plan.finalManagedSkills, plan.indexSkillPath), "utf8");
}
