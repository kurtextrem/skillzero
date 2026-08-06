import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  GENERATED_MARKER,
  INDEX_SKILL_NAME,
  MANAGED_SKILLS_DIR_NAME,
  SKILL_FILE_NAME,
} from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";
import { readSkillRecord } from "./metadata.js";

import type { SkillInventory, SkillOrigin, SkillRecord } from "./types.js";

async function readSkillFromDirectory(
  directory: string,
  id: string,
  origin: SkillOrigin,
): Promise<SkillRecord | null> {
  const skillFile = path.join(directory, SKILL_FILE_NAME);
  const skillFileKind = await getPathKind(skillFile);
  if (skillFileKind !== "file") {
    return null;
  }

  return readSkillRecord(id, directory, skillFile, origin);
}

async function scanImmediateSkillChildren(rootPath: string, origin: SkillOrigin): Promise<SkillRecord[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const skills: SkillRecord[] = [];
  const seenSkillFiles = new Set<string>();
  for (const entry of entries) {
    const directory = path.join(rootPath, entry.name);
    // Dirent reports a symbolic link as neither a file nor a directory. Stat
    // follows the link, letting a linked skill directory participate normally
    // while broken links remain safely ignored.
    if ((await getPathKind(directory)) !== "directory") {
      continue;
    }

    const skill = await readSkillFromDirectory(directory, entry.name, origin);
    if (skill !== null) {
      // A directory can be linked twice under one skills root. Keep the first
      // stable name so one physical SKILL.md cannot receive conflicting state
      // entries or be moved twice during the same operation.
      const physicalSkillFile = await realpath(skill.skillFile);
      if (seenSkillFiles.has(physicalSkillFile)) {
        continue;
      }

      seenSkillFiles.add(physicalSkillFile);
      skills.push(skill);
    }
  }

  return skills;
}

export async function scanSkills(rootPath: string): Promise<SkillInventory> {
  const resolvedRoot = path.resolve(rootPath);
  const rootKind = await getPathKind(resolvedRoot);

  if (rootKind === "missing") {
    throw new SkillzeroError(`Skills path does not exist: ${resolvedRoot}`);
  }

  if (rootKind !== "directory") {
    throw new SkillzeroError(`Skills path must be a directory: ${resolvedRoot}`);
  }

  const indexSkillPath = path.join(resolvedRoot, INDEX_SKILL_NAME);
  const indexSkillFile = path.join(indexSkillPath, SKILL_FILE_NAME);
  const managedSkillsPath = path.join(indexSkillPath, MANAGED_SKILLS_DIR_NAME);

  const indexPathKind = await getPathKind(indexSkillPath);
  if (indexPathKind !== "missing" && indexPathKind !== "directory") {
    throw new SkillzeroError(`Path conflict: ${indexSkillPath} must be a directory.`);
  }

  const indexFileKind = await getPathKind(indexSkillFile);
  if (indexFileKind !== "missing" && indexFileKind !== "file") {
    throw new SkillzeroError(`Path conflict: ${indexSkillFile} must be a file.`);
  }

  let indexFileGenerated = false;
  if (indexFileKind === "file") {
    const content = await readFile(indexSkillFile, "utf8");
    indexFileGenerated = content.includes(GENERATED_MARKER);
    if (!indexFileGenerated) {
      throw new SkillzeroError(`Refusing to overwrite non-generated index skill: ${indexSkillFile}`);
    }
  }

  const activeSkills = (await scanImmediateSkillChildren(resolvedRoot, "active")).filter(
    (skill) => skill.id !== INDEX_SKILL_NAME,
  );

  const managedSkillsPathKind = await getPathKind(managedSkillsPath);
  if (managedSkillsPathKind !== "missing" && managedSkillsPathKind !== "directory") {
    throw new SkillzeroError(`Path conflict: ${managedSkillsPath} must be a directory.`);
  }

  // Managed skills are scanned shallowly so a nested skill can carry assets or
  // helper folders without accidentally becoming another managed entry.
  const managedSkills =
    managedSkillsPathKind === "directory"
      ? await scanImmediateSkillChildren(managedSkillsPath, "managed")
      : [];

  return {
    rootPath: resolvedRoot,
    indexSkillPath,
    indexSkillFile,
    managedSkillsPath,
    activeSkills,
    managedSkills,
    indexFileGenerated,
    indexFileExists: indexFileKind === "file",
  };
}
