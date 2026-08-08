import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "@11ty/gray-matter";

import { DISABLE_MODEL_INVOCATION_FIELD, IN_PLACE_STATE_FILE_NAME } from "./constants.js";
import { applyCollectionPlan, buildCollectionPlan, formatCollectionPlan } from "./collections.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind, hasDifferentFileContent } from "./fs-utils.js";
import { generateIndexSkill } from "./index-skill.js";
import { estimateSavedTokens } from "./tokens.js";
import { EMOJI } from "./ui.js";

import type { CollectionPlan, SkillInventory, SkillRecord } from "./types.js";

type OriginalModelInvocation = boolean | null;
type InPlaceStateOwner = "skillzero" | "external";

interface InPlaceSkillState {
  id: string;
  owner: InPlaceStateOwner;
  originalDisableModelInvocation: OriginalModelInvocation;
  appliedContentHash: string | null;
}

export interface InPlaceState {
  version: 1;
  skills: InPlaceSkillState[];
}

export type InPlaceOperationKind = "disable-model-invocation" | "restore-model-invocation";

export interface InPlaceOperation {
  id: string;
  kind: InPlaceOperationKind;
  skill: SkillRecord;
  expectedContentHash: string;
  content: string;
}

export interface InPlacePlan {
  indexSkillPath: string;
  indexSkillFile: string;
  finalManagedSkills: SkillRecord[];
  operations: InPlaceOperation[];
  nextState: InPlaceState | null;
  stateChanged: boolean;
  collectionPlan: CollectionPlan;
  indexChanged: boolean;
}

function statePath(inventory: SkillInventory): string {
  return path.join(inventory.rootPath, IN_PLACE_STATE_FILE_NAME);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInPlaceSkillState(value: unknown): value is InPlaceSkillState {
  if (!isRecord(value)) {
    return false;
  }

  const id = value["id"];
  const owner = value["owner"];
  const originalDisableModelInvocation = value["originalDisableModelInvocation"];
  const appliedContentHash = value["appliedContentHash"];

  return (
    typeof id === "string" &&
    id.length > 0 &&
    (owner === "skillzero" || owner === "external") &&
    (typeof originalDisableModelInvocation === "boolean" ||
      originalDisableModelInvocation === null) &&
    (typeof appliedContentHash === "string" || appliedContentHash === null)
  );
}

function parseInPlaceState(content: string, filePath: string): InPlaceState {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new SkillzeroError(`Invalid skillzero in-place state: ${filePath}`);
  }

  if (!isRecord(value) || value["version"] !== 1) {
    throw new SkillzeroError(`Invalid skillzero in-place state: ${filePath}`);
  }

  const storedSkills = value["skills"];
  if (!Array.isArray(storedSkills)) {
    throw new SkillzeroError(`Invalid skillzero in-place state: ${filePath}`);
  }

  const skills: InPlaceSkillState[] = [];
  const ids = new Set<string>();
  for (const storedSkill of storedSkills) {
    if (!isInPlaceSkillState(storedSkill) || ids.has(storedSkill.id)) {
      throw new SkillzeroError(`Invalid skillzero in-place state: ${filePath}`);
    }

    ids.add(storedSkill.id);
    skills.push({ ...storedSkill });
  }

  skills.sort((left, right) => left.id.localeCompare(right.id));
  return { version: 1, skills };
}

export async function readInPlaceState(inventory: SkillInventory): Promise<InPlaceState | null> {
  const filePath = statePath(inventory);
  const kind = await getPathKind(filePath);
  if (kind === "missing") {
    return null;
  }
  if (kind !== "file") {
    throw new SkillzeroError(`In-place state must be a file: ${filePath}`);
  }

  return parseInPlaceState(await readFile(filePath, "utf8"), filePath);
}

function readDisableModelInvocation(content: string, skillFile: string): OriginalModelInvocation {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch {
    throw new SkillzeroError(`Invalid SKILL.md frontmatter: ${skillFile}`);
  }

  const value = parsed.data[DISABLE_MODEL_INVOCATION_FIELD];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new SkillzeroError(
      `${DISABLE_MODEL_INVOCATION_FIELD} must be true or false: ${skillFile}`,
    );
  }

  return value;
}

interface FrontmatterBounds {
  openingEnd: number;
  closingStart: number;
  lineEnding: string;
}

function frontmatterBounds(content: string): FrontmatterBounds | null {
  const firstNewline = content.indexOf("\n");
  const firstLineEnd = firstNewline === -1 ? content.length : firstNewline;
  const firstLine = content.slice(0, firstLineEnd).replace(/\r$/, "");
  if (!/^\uFEFF?---[ \t]*$/.test(firstLine)) {
    return null;
  }

  const openingEnd = firstNewline === -1 ? content.length : firstNewline + 1;
  const lineEnding = content.slice(0, openingEnd).endsWith("\r\n") ? "\r\n" : "\n";
  let lineStart = openingEnd;

  while (lineStart < content.length) {
    const nextNewline = content.indexOf("\n", lineStart);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const line = content.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) {
      return { openingEnd, closingStart: lineStart, lineEnding };
    }

    if (nextNewline === -1) {
      break;
    }
    lineStart = nextNewline + 1;
  }

  throw new SkillzeroError("SKILL.md frontmatter is missing its closing delimiter.");
}

const DISABLE_MODEL_INVOCATION_LINE =
  /^(?:"disable-model-invocation"|'disable-model-invocation'|disable-model-invocation):[^\r\n]*(?:\r?\n|$)/m;

// Rewrite only the one policy line. Skills are user-authored documents, so a
// YAML serializer would create noisy unrelated formatting changes on every sync.
function withDisableModelInvocation(content: string, value: OriginalModelInvocation): string {
  const bounds = frontmatterBounds(content);
  if (bounds === null) {
    if (value === null) {
      return content;
    }

    const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
    return `---${lineEnding}${DISABLE_MODEL_INVOCATION_FIELD}: ${value}${lineEnding}---${lineEnding}${content}`;
  }

  const frontmatter = content.slice(bounds.openingEnd, bounds.closingStart);
  const beforeFrontmatter = content.slice(0, bounds.openingEnd);
  const afterFrontmatter = content.slice(bounds.closingStart);
  const replacement =
    value === null ? "" : `${DISABLE_MODEL_INVOCATION_FIELD}: ${value}${bounds.lineEnding}`;

  if (DISABLE_MODEL_INVOCATION_LINE.test(frontmatter)) {
    return `${beforeFrontmatter}${frontmatter.replace(DISABLE_MODEL_INVOCATION_LINE, replacement)}${afterFrontmatter}`;
  }

  if (value === null) {
    return content;
  }

  return `${beforeFrontmatter}${frontmatter}${replacement}${afterFrontmatter}`;
}

function stateById(state: InPlaceState | null): Map<string, InPlaceSkillState> {
  return new Map(state?.skills.map((skill) => [skill.id, skill]));
}

function sortedState(skills: InPlaceSkillState[]): InPlaceState | null {
  if (skills.length === 0) {
    return null;
  }

  return {
    version: 1,
    skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function statesDiffer(previousState: InPlaceState | null, nextState: InPlaceState | null): boolean {
  // The state file is part of the applied layout. Compare its normalized JSON
  // shape so a no-op sync does not ask for confirmation or rewrite metadata.
  return JSON.stringify(previousState) !== JSON.stringify(nextState);
}

export async function buildInPlacePlan(
  inventory: SkillInventory,
  selectedIds: Iterable<string>,
  previousState: InPlaceState | null,
  collections = inventory.collections,
): Promise<InPlacePlan> {
  if (inventory.managedSkills.length > 0) {
    throw new SkillzeroError(
      "This skills directory currently uses moved mode. Release and sync it before switching to --claude or --cursor.",
    );
  }

  const selectedIdSet = new Set(selectedIds);
  const activeById = new Map(inventory.activeSkills.map((skill) => [skill.id, skill]));
  const unknownIds = [...selectedIdSet]
    .filter((id) => !activeById.has(id))
    .sort((left, right) => left.localeCompare(right));
  if (unknownIds.length > 0) {
    throw new SkillzeroError(`Unknown selected skill names: ${unknownIds.join(", ")}`);
  }

  const previousById = stateById(previousState);
  const operations: InPlaceOperation[] = [];
  const nextSkills: InPlaceSkillState[] = [];
  const finalManagedSkills = inventory.activeSkills.filter((skill) => selectedIdSet.has(skill.id));

  for (const skill of inventory.activeSkills) {
    if (!selectedIdSet.has(skill.id)) {
      continue;
    }

    const content = await readFile(skill.skillFile, "utf8");
    const currentValue = readDisableModelInvocation(content, skill.skillFile);
    const currentHash = contentHash(content);
    const previous = previousById.get(skill.id);

    if (currentValue === true) {
      // A changed file that now declares the field may have gained it upstream.
      // Mark it external so deselecting never removes another author's policy.
      if (previous?.owner === "skillzero" && previous.appliedContentHash === currentHash) {
        nextSkills.push(previous);
      } else {
        nextSkills.push({
          id: skill.id,
          owner: "external",
          originalDisableModelInvocation: null,
          appliedContentHash: null,
        });
      }
      continue;
    }

    const updatedContent = withDisableModelInvocation(content, true);
    operations.push({
      id: skill.id,
      kind: "disable-model-invocation",
      skill,
      expectedContentHash: currentHash,
      content: updatedContent,
    });
    nextSkills.push({
      id: skill.id,
      owner: "skillzero",
      originalDisableModelInvocation: currentValue,
      appliedContentHash: contentHash(updatedContent),
    });
  }

  for (const previous of previousById.values()) {
    if (selectedIdSet.has(previous.id)) {
      continue;
    }

    const skill = activeById.get(previous.id);
    if (!skill || previous.owner !== "skillzero" || previous.appliedContentHash === null) {
      continue;
    }

    const content = await readFile(skill.skillFile, "utf8");
    if (contentHash(content) !== previous.appliedContentHash) {
      continue;
    }

    operations.push({
      id: skill.id,
      kind: "restore-model-invocation",
      skill,
      expectedContentHash: previous.appliedContentHash,
      content: withDisableModelInvocation(content, previous.originalDisableModelInvocation),
    });
  }

  finalManagedSkills.sort((left, right) => left.id.localeCompare(right.id));
  const collectionPlan = await buildCollectionPlan(inventory, finalManagedSkills, collections);
  const indexContent = generateIndexSkill(
    finalManagedSkills,
    inventory.indexSkillPath,
    collectionPlan.finalCollections,
  );
  const nextState = sortedState(nextSkills);
  return {
    indexSkillPath: inventory.indexSkillPath,
    indexSkillFile: inventory.indexSkillFile,
    finalManagedSkills,
    operations,
    nextState,
    stateChanged: statesDiffer(previousState, nextState),
    collectionPlan,
    indexChanged: await hasDifferentFileContent(inventory.indexSkillFile, indexContent),
  };
}

export function formatInPlacePlan(plan: InPlacePlan): string {
  const lines = [
    `${EMOJI.plan} Planned changes:`,
    `- ${EMOJI.keep}  Keep selected skill folders in place.`,
  ];

  for (const operation of plan.operations) {
    const verb =
      operation.kind === "disable-model-invocation"
        ? "Set disable-model-invocation: true"
        : "Restore the previous disable-model-invocation value";
    const marker = operation.kind === "disable-model-invocation" ? EMOJI.lock : EMOJI.unlock;
    lines.push(`- ${marker}  ${verb}: ${operation.id}`);
  }

  lines.push(
    plan.indexChanged
      ? `- ${EMOJI.index} Update skill-index/SKILL.md with ${plan.finalManagedSkills.length} managed skill(s).`
      : `- ${EMOJI.index} No update to ${plan.finalManagedSkills.length} managed skill(s).`,
  );
  lines.push(formatCollectionPlan(plan.collectionPlan));
  lines.push(
    `- ${EMOJI.new} Skillzero now saves ${estimateSavedTokens(plan.finalManagedSkills)} tokens for you.`,
  );
  return lines.join("\n");
}

export async function applyInPlacePlan(
  plan: InPlacePlan,
  inventory: SkillInventory,
): Promise<void> {
  // Verify the entire preview before writing so a user edit made at the
  // confirmation prompt cannot be overwritten by a partial sync.
  for (const operation of plan.operations) {
    const content = await readFile(operation.skill.skillFile, "utf8");
    if (contentHash(content) !== operation.expectedContentHash) {
      throw new SkillzeroError(
        `SKILL.md changed while waiting for confirmation: ${operation.skill.skillFile}`,
      );
    }
  }

  for (const operation of plan.operations) {
    await writeFile(operation.skill.skillFile, operation.content, "utf8");
  }

  await mkdir(plan.indexSkillPath, { recursive: true });
  await applyCollectionPlan(plan.collectionPlan, plan.finalManagedSkills);
  await writeFile(
    plan.indexSkillFile,
    generateIndexSkill(
      plan.finalManagedSkills,
      plan.indexSkillPath,
      plan.collectionPlan.finalCollections,
    ),
    "utf8",
  );

  const filePath = statePath(inventory);
  if (plan.nextState === null) {
    await rm(filePath, { force: true });
    return;
  }

  await writeFile(filePath, `${JSON.stringify(plan.nextState, null, 2)}\n`, "utf8");
}
