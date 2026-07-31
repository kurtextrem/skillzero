import path from "node:path";

import { SKILL_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";

import type { MoveOperation, MovePlan, SkillInventory, SkillRecord } from "./types.js";

function mapById(skills: SkillRecord[]): Map<string, SkillRecord> {
  return new Map(skills.map((skill) => [skill.id, skill]));
}

function findDuplicateIds(inventory: SkillInventory): string[] {
  const managedIds = new Set(inventory.managedSkills.map((skill) => skill.id));
  return inventory.activeSkills
    .filter((skill) => managedIds.has(skill.id))
    .map((skill) => skill.id)
    .sort((left, right) => left.localeCompare(right));
}

function moveToManagedRecord(skill: SkillRecord, inventory: SkillInventory): SkillRecord {
  const directory = path.join(inventory.managedSkillsPath, skill.id);
  return {
    id: skill.id,
    title: skill.title,
    description: skill.description,
    directory,
    skillFile: path.join(directory, SKILL_FILE_NAME),
    origin: "managed",
  };
}

async function validateOperationPaths(operations: MoveOperation[]): Promise<void> {
  for (const operation of operations) {
    const sourceKind = await getPathKind(operation.from);
    if (sourceKind !== "directory") {
      throw new SkillzeroError(`Move source is missing or invalid: ${operation.from}`);
    }

    const destinationKind = await getPathKind(operation.to);
    if (destinationKind !== "missing") {
      throw new SkillzeroError(`Move destination already exists: ${operation.to}`);
    }
  }
}

export async function buildMovePlan(
  inventory: SkillInventory,
  selectedIds: Iterable<string>,
): Promise<MovePlan> {
  if (inventory.indexFileExists && !inventory.indexFileGenerated) {
    throw new SkillzeroError(`Refusing to overwrite non-generated index skill: ${inventory.indexSkillFile}`);
  }

  const duplicateIds = findDuplicateIds(inventory);
  if (duplicateIds.length > 0) {
    throw new SkillzeroError(`Duplicate active and managed skill names: ${duplicateIds.join(", ")}`);
  }

  const activeById = mapById(inventory.activeSkills);
  const managedById = mapById(inventory.managedSkills);
  const knownIds = new Set([...activeById.keys(), ...managedById.keys()]);
  const selectedIdSet = new Set(selectedIds);

  const unknownIds = [...selectedIdSet].filter((id) => !knownIds.has(id)).sort((left, right) => left.localeCompare(right));
  if (unknownIds.length > 0) {
    throw new SkillzeroError(`Unknown selected skill names: ${unknownIds.join(", ")}`);
  }

  const operations: MoveOperation[] = [];
  const finalManagedSkills: SkillRecord[] = [];

  // Selected active skills are hidden under the generated index skill so agents
  // only see the compact table until a nested skill is explicitly needed.
  for (const skill of inventory.activeSkills) {
    if (!selectedIdSet.has(skill.id)) {
      continue;
    }

    const managedSkill = moveToManagedRecord(skill, inventory);
    operations.push({
      id: skill.id,
      kind: "move-to-index",
      from: skill.directory,
      to: managedSkill.directory,
      skill,
    });
    finalManagedSkills.push(managedSkill);
  }

  for (const skill of inventory.managedSkills) {
    if (selectedIdSet.has(skill.id)) {
      finalManagedSkills.push(skill);
      continue;
    }

    operations.push({
      id: skill.id,
      kind: "restore-to-root",
      from: skill.directory,
      to: path.join(inventory.rootPath, skill.id),
      skill,
    });
  }

  await validateOperationPaths(operations);

  finalManagedSkills.sort((left, right) => left.id.localeCompare(right.id));

  return {
    rootPath: inventory.rootPath,
    indexSkillPath: inventory.indexSkillPath,
    indexSkillFile: inventory.indexSkillFile,
    managedSkillsPath: inventory.managedSkillsPath,
    operations,
    finalManagedSkills,
  };
}

export function formatMovePlan(plan: MovePlan): string {
  const lines = ["Planned changes:"];

  if (plan.operations.length === 0) {
    lines.push("- No skill folders will move.");
  }

  for (const operation of plan.operations) {
    const verb = operation.kind === "move-to-index" ? "Move into index" : "Restore to root";
    lines.push(`- ${verb}: ${operation.id}`);
  }

  lines.push(`- Update skill-index/SKILL.md with ${plan.finalManagedSkills.length} managed skill(s).`);
  return lines.join("\n");
}
