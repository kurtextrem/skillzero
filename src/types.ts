export type SkillOrigin = "active" | "managed";

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
