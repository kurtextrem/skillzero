import { realpath } from "node:fs/promises";
import path from "node:path";

import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";

import type { DiscoveredSkillsRoot, InvocationTarget } from "./types.js";

const ALL_PROJECT_SKILL_ROOTS = [
  [".agents", "skills"],
  [".claude", "skills"],
  [".codex", "skills"],
  [".cursor", "skills"],
  [".gemini", "skills"],
  [".github", "skills"],
];

// Keep discovery limited to locations the requested harness can read. Scanning
// every folder for every target would apply a layout where that target cannot
// use the resulting index, especially in a project with separate harnesses.
const PROJECT_SKILL_ROOTS_BY_TARGET: Record<InvocationTarget, string[][]> = {
  claude: [
    [".agents", "skills"],
    [".claude", "skills"],
  ],
  cursor: [
    [".agents", "skills"],
    [".cursor", "skills"],
  ],
  codex: [
    [".agents", "skills"],
    [".codex", "skills"],
  ],
  copilot: [
    [".agents", "skills"],
    [".claude", "skills"],
    [".github", "skills"],
  ],
  gemini: [
    [".agents", "skills"],
    [".gemini", "skills"],
  ],
};

function candidateSegments(target: InvocationTarget | null): readonly string[][] {
  return target === null ? ALL_PROJECT_SKILL_ROOTS : PROJECT_SKILL_ROOTS_BY_TARGET[target];
}

export async function discoverSkillsRoots(
  projectPath: string,
  target: InvocationTarget | null,
): Promise<DiscoveredSkillsRoot[]> {
  const resolvedProjectPath = path.resolve(projectPath);
  const projectKind = await getPathKind(resolvedProjectPath);
  if (projectKind === "missing") {
    throw new SkillzeroError(`Project path does not exist: ${resolvedProjectPath}`);
  }
  if (projectKind !== "directory") {
    throw new SkillzeroError(`Project path must be a directory: ${resolvedProjectPath}`);
  }

  const rootsByRealPath = new Map<string, DiscoveredSkillsRoot>();
  for (const segments of candidateSegments(target)) {
    const candidatePath = path.join(resolvedProjectPath, ...segments);
    const candidateKind = await getPathKind(candidatePath);
    if (candidateKind === "missing") {
      continue;
    }
    if (candidateKind !== "directory") {
      throw new SkillzeroError(`Discovered skills path must be a directory: ${candidatePath}`);
    }

    // A skills root is often linked into .agents from a harness-specific
    // directory. Use the real directory as its identity so we never manage the
    // same generated index twice through two aliases.
    const realPath = await realpath(candidatePath);
    const existingRoot = rootsByRealPath.get(realPath);
    if (existingRoot) {
      existingRoot.aliases.push(candidatePath);
      continue;
    }

    rootsByRealPath.set(realPath, {
      path: candidatePath,
      realPath,
      aliases: [candidatePath],
    });
  }

  return [...rootsByRealPath.values()];
}
