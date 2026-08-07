import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyMoveOperations, applyMovePlan } from "./apply.js";
import { HANDOFF_STATE_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";

import type { MovePlan, SkillInventory } from "./types.js";

interface HandoffState {
  version: 1;
  managedIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHandoffState(value: unknown): value is HandoffState {
  if (!isRecord(value)) {
    return false;
  }

  const version = value["version"];
  const managedIds = value["managedIds"];
  return (
    version === 1 &&
    Array.isArray(managedIds) &&
    managedIds.every((id) => typeof id === "string" && id.length > 0)
  );
}

function statePath(inventory: SkillInventory): string {
  return path.join(inventory.indexSkillPath, HANDOFF_STATE_FILE_NAME);
}

function parseHandoffState(content: string, filePath: string): HandoffState {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new SkillzeroError(`Invalid skillzero handoff state: ${filePath}`);
  }

  if (!isHandoffState(value)) {
    throw new SkillzeroError(`Invalid skillzero handoff state: ${filePath}`);
  }

  return {
    version: 1,
    managedIds: [...new Set(value.managedIds)].sort((left, right) => left.localeCompare(right)),
  };
}

export async function readHandoffState(inventory: SkillInventory): Promise<HandoffState | null> {
  const filePath = statePath(inventory);
  const kind = await getPathKind(filePath);
  if (kind === "missing") {
    return null;
  }
  if (kind !== "file") {
    throw new SkillzeroError(`Handoff state must be a file: ${filePath}`);
  }

  return parseHandoffState(await readFile(filePath, "utf8"), filePath);
}

export async function clearHandoffState(inventory: SkillInventory): Promise<void> {
  // Selecting a different root-wide layout supersedes a temporary move handoff.
  // Removing only this snapshot leaves any user-managed skill folders untouched.
  await rm(statePath(inventory), { force: true });
}

export async function applyHandoff(plan: MovePlan, inventory: SkillInventory): Promise<void> {
  const filePath = statePath(inventory);
  const state: HandoffState = {
    version: 1,
    managedIds: inventory.managedSkills.map((skill) => skill.id).sort((left, right) => left.localeCompare(right)),
  };

  // Record the intended index before moving anything. If a later filesystem
  // operation is interrupted, `sync` still knows which placement to recover.
  await mkdir(inventory.indexSkillPath, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await applyMoveOperations(plan);

  // The upstream skills CLI must not see the generated router as another
  // installable skill while the library is temporarily released.
  await rm(inventory.indexSkillFile, { force: true });
}

export async function applySync(plan: MovePlan, inventory: SkillInventory): Promise<void> {
  await applyMovePlan(plan);

  // A completed sync has materialized the selected set into the index, so the
  // handoff snapshot is no longer authoritative and must not affect later work.
  await rm(statePath(inventory), { force: true });
}
