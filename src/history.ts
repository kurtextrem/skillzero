import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { REDO_STATE_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";

import type { SkillCollection } from "./types.js";

export type RedoStrategy = "move" | "in-place";

// The index directory is removed by undo, so this small root-level snapshot is
// the durable source for the one redo operation we support.
export interface RedoState {
  version: 1;
  strategy: RedoStrategy;
  managedIds: string[];
  knownSkillIds: string[];
  collections: SkillCollection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCollection(value: unknown, filePath: string, index: number): SkillCollection {
  if (!isRecord(value)) {
    throw new SkillzeroError(`Invalid redo collection ${index + 1} in ${filePath}`);
  }

  const id = readNonEmptyString(value["id"]);
  const title = readNonEmptyString(value["title"]);
  const description = readNonEmptyString(value["description"]);
  const storedSkillIds = value["skillIds"];
  if (id === null || title === null || description === null || !Array.isArray(storedSkillIds)) {
    throw new SkillzeroError(`Invalid redo collection ${index + 1} in ${filePath}`);
  }

  const skillIds: string[] = [];
  for (const storedSkillId of storedSkillIds) {
    const skillId = readNonEmptyString(storedSkillId);
    if (skillId === null || skillIds.includes(skillId)) {
      throw new SkillzeroError(`Invalid redo collection ${index + 1} in ${filePath}`);
    }
    skillIds.push(skillId);
  }

  return { id, title, description, skillIds };
}

function parseRedoState(content: string, filePath: string): RedoState {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new SkillzeroError(`Invalid skillzero redo state: ${filePath}`);
  }

  if (!isRecord(value) || value["version"] !== 1) {
    throw new SkillzeroError(`Invalid skillzero redo state: ${filePath}`);
  }

  const strategy = value["strategy"];
  const storedManagedIds = value["managedIds"];
  const storedKnownSkillIds = value["knownSkillIds"];
  const storedCollections = value["collections"];
  if (
    (strategy !== "move" && strategy !== "in-place") ||
    !Array.isArray(storedManagedIds) ||
    !Array.isArray(storedKnownSkillIds) ||
    !Array.isArray(storedCollections)
  ) {
    throw new SkillzeroError(`Invalid skillzero redo state: ${filePath}`);
  }

  const knownSkillIds: string[] = [];
  for (const storedKnownSkillId of storedKnownSkillIds) {
    const knownSkillId = readNonEmptyString(storedKnownSkillId);
    if (knownSkillId === null || knownSkillIds.includes(knownSkillId)) {
      throw new SkillzeroError(`Invalid redo state: ${filePath}`);
    }
    knownSkillIds.push(knownSkillId);
  }

  const managedIds: string[] = [];
  for (const storedManagedId of storedManagedIds) {
    const managedId = readNonEmptyString(storedManagedId);
    if (managedId === null || managedIds.includes(managedId)) {
      throw new SkillzeroError(`Invalid skillzero redo state: ${filePath}`);
    }
    managedIds.push(managedId);
  }

  const collectionIds = new Set<string>();
  const collections: SkillCollection[] = [];
  for (const [index, storedCollection] of storedCollections.entries()) {
    const collection = parseCollection(storedCollection, filePath, index);
    if (collectionIds.has(collection.id)) {
      throw new SkillzeroError(`Duplicate redo collection in ${filePath}: ${collection.id}`);
    }
    collectionIds.add(collection.id);
    collections.push(collection);
  }

  managedIds.sort((left, right) => left.localeCompare(right));
  knownSkillIds.sort((left, right) => left.localeCompare(right));
  collections.sort((left, right) => left.id.localeCompare(right.id));
  return { version: 1, strategy, managedIds, knownSkillIds, collections };
}

export function redoStatePath(rootPath: string): string {
  return path.join(rootPath, REDO_STATE_FILE_NAME);
}

export async function readRedoState(rootPath: string): Promise<RedoState | null> {
  const filePath = redoStatePath(rootPath);
  const kind = await getPathKind(filePath);
  if (kind === "missing") {
    return null;
  }
  if (kind !== "file") {
    throw new SkillzeroError(`Redo state must be a file: ${filePath}`);
  }

  return parseRedoState(await readFile(filePath, "utf8"), filePath);
}

export async function writeRedoState(rootPath: string, state: RedoState): Promise<void> {
  const normalized: RedoState = {
    version: 1,
    strategy: state.strategy,
    managedIds: [...new Set(state.managedIds)].sort((left, right) => left.localeCompare(right)),
    knownSkillIds: [...new Set(state.knownSkillIds)].sort((left, right) =>
      left.localeCompare(right),
    ),
    collections: state.collections
      .map((collection) => ({
        id: collection.id,
        title: collection.title,
        description: collection.description,
        skillIds: [...new Set(collection.skillIds)].sort((left, right) =>
          left.localeCompare(right),
        ),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };

  await writeFile(redoStatePath(rootPath), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function clearRedoState(rootPath: string): Promise<void> {
  await rm(redoStatePath(rootPath), { force: true });
}
