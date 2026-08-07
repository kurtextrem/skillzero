import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { KNOWN_SKILLS_STATE_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";

export interface KnownSkillsState {
  version: 1;
  skillIds: string[];
}

function statePath(rootPath: string): string {
  return path.join(rootPath, KNOWN_SKILLS_STATE_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseKnownSkillsState(content: string, filePath: string): KnownSkillsState {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new SkillzeroError(`Invalid skillzero known-skills state: ${filePath}`);
  }

  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["skillIds"])) {
    throw new SkillzeroError(`Invalid skillzero known-skills state: ${filePath}`);
  }

  const skillIds: string[] = [];
  for (const skillId of value["skillIds"]) {
    if (typeof skillId !== "string" || skillId.length === 0 || skillIds.includes(skillId)) {
      throw new SkillzeroError(`Invalid skillzero known-skills state: ${filePath}`);
    }
    skillIds.push(skillId);
  }

  skillIds.sort((left, right) => left.localeCompare(right));
  return { version: 1, skillIds };
}

export async function readKnownSkillIds(rootPath: string): Promise<string[] | null> {
  const filePath = statePath(rootPath);
  const kind = await getPathKind(filePath);
  if (kind === "missing") {
    return null;
  }
  if (kind !== "file") {
    throw new SkillzeroError(`Known-skills state must be a file: ${filePath}`);
  }

  return parseKnownSkillsState(await readFile(filePath, "utf8"), filePath).skillIds;
}

export async function writeKnownSkillIds(
  rootPath: string,
  skillIds: Iterable<string>,
): Promise<void> {
  const normalized = [...new Set(skillIds)].sort((left, right) => left.localeCompare(right));
  const state: KnownSkillsState = { version: 1, skillIds: normalized };
  await writeFile(statePath(rootPath), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearKnownSkillIds(rootPath: string): Promise<void> {
  await rm(statePath(rootPath), { force: true });
}
