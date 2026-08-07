import { readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { applyMoveOperations, applyMovePlan } from "./apply.js";
import { collectionConfigPath, collectionDirectoryPath, collectionsPath } from "./collections.js";
import { GENERATED_MARKER, SKILL_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { clearRedoState, readRedoState, writeRedoState } from "./history.js";
import {
  applyInPlacePlan,
  buildInPlacePlan,
  formatInPlacePlan,
  readInPlaceState,
} from "./in-place.js";
import { clearHandoffState, readHandoffState } from "./handoff.js";
import { getPathKind } from "./fs-utils.js";
import { clearKnownSkillIds, readKnownSkillIds, writeKnownSkillIds } from "./known-skills.js";
import { buildMovePlan, formatMovePlan } from "./plan.js";
import { EMOJI } from "./ui.js";

import type { InPlacePlan } from "./in-place.js";
import type { RedoState } from "./history.js";
import type { MovePlan, SkillCollection, SkillInventory } from "./types.js";

export type UndoPlan =
  | {
      strategy: "move";
      redoState: RedoState;
      movePlan: MovePlan;
    }
  | {
      strategy: "in-place";
      redoState: RedoState;
      inPlacePlan: InPlacePlan;
    };

export type RedoPlan =
  | {
      strategy: "move";
      state: RedoState;
      movePlan: MovePlan;
    }
  | {
      strategy: "in-place";
      state: RedoState;
      inPlacePlan: InPlacePlan;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const code = error["code"];
  return typeof code === "string" ? code : undefined;
}

function skillIds(inventory: SkillInventory): string[] {
  return [...inventory.activeSkills, ...inventory.managedSkills]
    .map((skill) => skill.id)
    .sort((left, right) => left.localeCompare(right));
}

function filterCollections(
  collections: SkillCollection[],
  availableIds: Set<string>,
): SkillCollection[] {
  // A skill deleted while the layout was undone should stay deleted instead
  // of preventing every other remembered skill from being restored.
  return collections.map((collection) => ({
    ...collection,
    skillIds: collection.skillIds.filter((skillId) => availableIds.has(skillId)),
  }));
}

function hasSkillzeroLayout(
  inventory: SkillInventory,
  inPlaceStateExists: boolean,
  handoffStateExists: boolean,
): boolean {
  return (
    inventory.indexFileExists ||
    inventory.managedSkills.length > 0 ||
    inventory.collections.length > 0 ||
    inventory.generatedCollectionIds.length > 0 ||
    inPlaceStateExists ||
    handoffStateExists
  );
}

export async function buildUndoPlan(inventory: SkillInventory): Promise<UndoPlan> {
  const inPlaceState = await readInPlaceState(inventory);
  const handoffState = await readHandoffState(inventory);
  if (!hasSkillzeroLayout(inventory, inPlaceState !== null, handoffState !== null)) {
    throw new SkillzeroError("No skillzero changes found in " + inventory.rootPath + ".");
  }

  const knownSkillIds = (await readKnownSkillIds(inventory.rootPath)) ?? skillIds(inventory);

  if (inPlaceState !== null) {
    const redoState: RedoState = {
      version: 1,
      strategy: "in-place",
      managedIds: inPlaceState.skills.map((skill) => skill.id),
      knownSkillIds,
      collections: inventory.collections,
    };
    const inPlacePlan = await buildInPlacePlan(inventory, [], inPlaceState, []);
    return { strategy: "in-place", redoState, inPlacePlan };
  }

  const redoState: RedoState = {
    version: 1,
    strategy: "move",
    managedIds: handoffState?.managedIds ?? inventory.managedSkills.map((skill) => skill.id),
    knownSkillIds,
    collections: inventory.collections,
  };
  const movePlan = await buildMovePlan(inventory, []);
  return { strategy: "move", redoState, movePlan };
}

export async function buildRedoPlan(inventory: SkillInventory): Promise<RedoPlan> {
  const state = await readRedoState(inventory.rootPath);
  if (state === null) {
    throw new SkillzeroError("No skillzero undo is waiting to redo in " + inventory.rootPath + ".");
  }

  const availableIds = new Set(skillIds(inventory));
  const managedIds = state.managedIds.filter((id) => availableIds.has(id));
  const collections = filterCollections(state.collections, availableIds);

  if (state.strategy === "move") {
    if (await readInPlaceState(inventory)) {
      throw new SkillzeroError(
        "Cannot redo moved skills while in-place state exists in " + inventory.rootPath + ".",
      );
    }

    const movePlan = await buildMovePlan(inventory, managedIds, collections);
    return { strategy: "move", state, movePlan };
  }

  if (inventory.managedSkills.length > 0) {
    throw new SkillzeroError(
      "Cannot redo in-place skills while moved skills exist in " + inventory.rootPath + ".",
    );
  }
  if (await readInPlaceState(inventory)) {
    throw new SkillzeroError(
      "In-place skills are already configured in " + inventory.rootPath + ".",
    );
  }

  const inPlacePlan = await buildInPlacePlan(inventory, managedIds, null, collections);
  return { strategy: "in-place", state, inPlacePlan };
}

async function removeGeneratedFile(filePath: string, label: string): Promise<void> {
  const kind = await getPathKind(filePath);
  if (kind === "missing") {
    return;
  }
  if (kind !== "file") {
    throw new SkillzeroError("Path conflict: generated " + label + " must be a file: " + filePath);
  }

  const content = await readFile(filePath, "utf8");
  if (!content.includes(GENERATED_MARKER)) {
    throw new SkillzeroError("Refusing to remove non-generated " + label + ": " + filePath);
  }
  await rm(filePath);
}

async function removeGeneratedArtifacts(inventory: SkillInventory): Promise<void> {
  // Only files recognized as generated are removed. Extra user files under the
  // reserved index directory make the directory remain in place.
  for (const collectionId of inventory.generatedCollectionIds) {
    const skillFile = path.join(
      collectionDirectoryPath(inventory.indexSkillPath, collectionId),
      SKILL_FILE_NAME,
    );
    await removeGeneratedFile(skillFile, "collection skill");
  }

  const configFile = collectionConfigPath(inventory.indexSkillPath);
  const configKind = await getPathKind(configFile);
  if (configKind === "file") {
    await rm(configFile);
  } else if (configKind !== "missing") {
    throw new SkillzeroError("Path conflict: collection config must be a file: " + configFile);
  }

  await removeGeneratedFile(inventory.indexSkillFile, "index skill");
  await removeEmptyDirectory(inventory.managedSkillsPath);
  for (const collectionId of inventory.generatedCollectionIds) {
    await removeEmptyDirectory(collectionDirectoryPath(inventory.indexSkillPath, collectionId));
  }
  await removeEmptyDirectory(collectionsPath(inventory.indexSkillPath));
  await removeEmptyDirectory(inventory.indexSkillPath);
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  if ((await getPathKind(directory)) !== "directory") {
    return;
  }

  try {
    await rmdir(directory);
  } catch (error) {
    if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
}

export async function applyUndoPlan(plan: UndoPlan, inventory: SkillInventory): Promise<void> {
  // Write redo metadata before changing the layout so an interrupted undo can
  // still be completed without guessing which skills used to be managed.
  await writeRedoState(inventory.rootPath, plan.redoState);

  if (plan.strategy === "move") {
    await applyMoveOperations(plan.movePlan);
  } else {
    await applyInPlacePlan(plan.inPlacePlan, inventory);
  }

  await clearHandoffState(inventory);
  await removeGeneratedArtifacts(inventory);
  await clearKnownSkillIds(inventory.rootPath);
}

export async function applyRedoPlan(plan: RedoPlan, inventory: SkillInventory): Promise<void> {
  if (plan.strategy === "move") {
    await applyMovePlan(plan.movePlan);
  } else {
    await applyInPlacePlan(plan.inPlacePlan, inventory);
  }

  await clearHandoffState(inventory);
  await writeKnownSkillIds(inventory.rootPath, plan.state.knownSkillIds);
  await clearRedoState(inventory.rootPath);
}

function formatUndoOperations(plan: UndoPlan): string[] {
  const lines: string[] = [];
  if (plan.strategy === "move") {
    for (const operation of plan.movePlan.operations) {
      lines.push(`- ${EMOJI.restore}  Restore to root: ${operation.id}`);
    }
  } else {
    for (const operation of plan.inPlacePlan.operations) {
      lines.push(
        `- ${EMOJI.unlock}  Restore the previous disable-model-invocation value: ${operation.id}`,
      );
    }
  }

  if (lines.length === 0) {
    lines.push(`- ${EMOJI.info}  No skill folders or metadata need to be restored.`);
  }
  lines.push(`- ${EMOJI.remove}  Remove generated skill-index files.`);
  lines.push(`- ${EMOJI.redo}  Keep a redo record so the layout can be restored.`);
  return lines;
}

export function formatUndoPlan(plan: UndoPlan): string {
  return [`${EMOJI.restore}  Undo changes:`, ...formatUndoOperations(plan)].join("\n");
}

export function formatRedoPlan(plan: RedoPlan): string {
  const lines = [`${EMOJI.redo}  Redo changes:`];
  if (plan.strategy === "move") {
    lines.push(...formatMovePlan(plan.movePlan).split("\n").slice(1));
  } else {
    lines.push(...formatInPlacePlan(plan.inPlacePlan).split("\n").slice(1));
  }
  return lines.join("\n");
}
