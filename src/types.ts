export type SkillOrigin = "active" | "managed";

export type InvocationTarget = "claude" | "cursor" | "codex" | "copilot" | "gemini";

export interface DiscoveredSkillsRoot {
  // `path` preserves the first usable user-facing path, while `realPath` lets
  // discovery collapse aliases such as .agents/skills -> .claude/skills.
  path: string;
  realPath: string;
  aliases: string[];
}

export interface SkillRecord {
  id: string;
  title: string;
  description: string;
  directory: string;
  skillFile: string;
  origin: SkillOrigin;
}

export interface SkillInventory {
  rootPath: string;
  indexSkillPath: string;
  indexSkillFile: string;
  managedSkillsPath: string;
  activeSkills: SkillRecord[];
  managedSkills: SkillRecord[];
  indexFileGenerated: boolean;
  indexFileExists: boolean;
}

export type MoveOperationKind = "move-to-index" | "restore-to-root";

export interface MoveOperation {
  id: string;
  kind: MoveOperationKind;
  from: string;
  to: string;
  skill: SkillRecord;
}

export interface MovePlan {
  rootPath: string;
  indexSkillPath: string;
  indexSkillFile: string;
  managedSkillsPath: string;
  operations: MoveOperation[];
  finalManagedSkills: SkillRecord[];
}
