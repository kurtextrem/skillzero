import * as p from "@clack/prompts";
import cac from "cac";
import { spawnSync } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { applyMovePlan } from "./apply.js";
import { collectionIdFromTitle } from "./collections.js";
import { CLI_NAME, CLI_VERSION, REDO_STATE_FILE_NAME, SKILL_FILE_NAME } from "./constants.js";
import {
  discoverGlobalSkillsRoots,
  discoverProjectSkillsRootsAtPath,
  discoverSkillsRootsAtPath,
} from "./discovery.js";
import { SkillzeroError } from "./errors.js";
import { clearRedoState } from "./history.js";
import { applyHandoff, applySync, clearHandoffState, readHandoffState } from "./handoff.js";
import { applyInPlacePlan, buildInPlacePlan, formatInPlacePlan, readInPlaceState } from "./in-place.js";
import { buildMovePlan, formatMovePlan } from "./plan.js";
import { scanSkills } from "./scanner.js";
import { getPathKind } from "./fs-utils.js";
import {
  applyRedoPlan,
  applyUndoPlan,
  buildRedoPlan,
  buildUndoPlan,
  formatRedoPlan,
  formatUndoPlan,
} from "./undo-redo.js";
import { accent, bold, dim, printBanner, success, text, warning } from "./ui.js";

import type {
  DiscoveredSkillsRoot,
  InvocationTarget,
  SkillCollection,
  SkillInventory,
  SkillRecord,
} from "./types.js";

interface CliOptions {
  scope: string | null;
  dryRun: boolean;
  yes: boolean;
  target: InvocationTarget | null;
  strategy: "move" | "in-place" | null;
}

type PromptRootsResult =
  | {
      status: "ok";
      paths: string[];
      projectPath: string | null;
      discoveredRoots: DiscoveredSkillsRoot[];
    }
  | { status: "cancelled" };

type InventoryResolutionResult =
  | {
      status: "ok";
      inventories: SkillInventory[];
      projectPath: string | null;
      discoveredRoots: DiscoveredSkillsRoot[];
    }
  | { status: "cancelled" };

type PromptSelectionResult =
  | { status: "ok"; selectedIds: string[] }
  | { status: "cancelled" };

type PromptCollectionsResult =
  | { status: "ok"; collections: SkillCollection[] }
  | { status: "cancelled" };

type PromptCollectionDetailsResult =
  | { status: "ok"; collection: SkillCollection }
  | { status: "cancelled" };

interface SyncBehavior {
  ignoreMissingSkills: boolean;
  skipUnconfiguredInPlace: boolean;
  autoApply: boolean;
}

const DEFAULT_SYNC_BEHAVIOR: SyncBehavior = {
  ignoreMissingSkills: false,
  skipUnconfiguredInPlace: false,
  autoApply: false,
};

const UPDATE_WRAPPER_BOOLEAN_OPTIONS = new Set([
  "--dry-run",
  "--yes",
  "--claude",
  "--cursor",
  "--codex",
  "--copilot",
  "--gemini",
  "--help",
  "--version",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOption(options: unknown, key: string): unknown {
  if (!isRecord(options)) {
    return undefined;
  }

  return options[key];
}

function readInvocationTarget(options: unknown): InvocationTarget | null {
  const targets: InvocationTarget[] = [];
  if (readOption(options, "claude") === true) {
    targets.push("claude");
  }
  if (readOption(options, "cursor") === true) {
    targets.push("cursor");
  }
  if (readOption(options, "codex") === true) {
    targets.push("codex");
  }
  if (readOption(options, "copilot") === true) {
    targets.push("copilot");
  }
  if (readOption(options, "gemini") === true) {
    targets.push("gemini");
  }

  if (targets.length > 1) {
    throw new SkillzeroError(
      "Choose exactly one target: --claude, --cursor, --codex, --copilot, or --gemini.",
    );
  }

  return targets[0] ?? null;
}

function readCliOptions(options: unknown, scope: string | null = null): CliOptions {
  return {
    scope,
    dryRun: readOption(options, "dryRun") === true,
    yes: readOption(options, "yes") === true,
    target: readInvocationTarget(options),
    strategy: null,
  };
}

function usesInPlaceStrategy(options: CliOptions): boolean {
  // A shared .agents root has one filesystem layout, so these flags are aliases
  // for the same in-place strategy rather than separate per-harness settings.
  return options.strategy === "in-place" || options.target === "claude" || options.target === "cursor";
}

async function isLikelySkillsRoot(scopePath: string): Promise<boolean> {
  const resolvedScope = path.resolve(scopePath);
  if (path.basename(resolvedScope) === "skills") {
    return true;
  }
  if ((await getPathKind(resolvedScope)) !== "directory") {
    return false;
  }
  if ((await getPathKind(path.join(resolvedScope, "skill-index"))) === "directory") {
    return true;
  }
  if ((await getPathKind(path.join(resolvedScope, REDO_STATE_FILE_NAME))) === "file") {
    return true;
  }

  // Custom roots may not use a conventional parent name. An immediate child
  // with the canonical skill file is enough to identify the scope directly.
  const entries = await readdir(resolvedScope, { withFileTypes: true });
  for (const entry of entries) {
    const directory = path.join(resolvedScope, entry.name);
    if (
      (await getPathKind(directory)) === "directory" &&
      (await getPathKind(path.join(directory, SKILL_FILE_NAME))) === "file"
    ) {
      return true;
    }
  }

  return false;
}

function rootsResult(
  roots: DiscoveredSkillsRoot[],
  projectPath: string | null,
): PromptRootsResult {
  return {
    status: "ok",
    paths: roots.map((root) => root.path),
    projectPath,
    discoveredRoots: roots,
  };
}

async function resolveExplicitScope(scope: string, target: InvocationTarget | null): Promise<PromptRootsResult> {
  const resolvedScope = path.resolve(scope);
  const scopeKind = await getPathKind(resolvedScope);
  if (scopeKind === "missing") {
    if (await isLikelySkillsRoot(scope)) {
      return rootsResult([{ path: scope, realPath: resolvedScope, aliases: [scope] }], null);
    }
    throw new SkillzeroError(`Scope path does not exist: ${resolvedScope}`);
  }
  if (scopeKind !== "directory") {
    throw new SkillzeroError(`Scope path must be a directory: ${resolvedScope}`);
  }

  if (await isLikelySkillsRoot(scope)) {
    return rootsResult([{ path: scope, realPath: await realpath(resolvedScope), aliases: [scope] }], null);
  }

  const directRoots = await discoverSkillsRootsAtPath(scope, target);
  if (directRoots.length > 0) {
    return rootsResult(directRoots, null);
  }

  const projectRoots = await discoverProjectSkillsRootsAtPath(scope, target);
  if (projectRoots !== null) {
    return rootsResult(projectRoots.roots, projectRoots.projectPath);
  }

  return rootsResult([], resolvedScope);
}

async function resolveSkillsRoots(options: CliOptions): Promise<PromptRootsResult> {
  if (options.scope !== null) {
    return resolveExplicitScope(options.scope, options.target);
  }

  if (await isLikelySkillsRoot(process.cwd())) {
    const currentPath = process.cwd();
    return rootsResult(
      [{ path: currentPath, realPath: await realpath(currentPath), aliases: [currentPath] }],
      null,
    );
  }

  const directRoots = await discoverSkillsRootsAtPath(process.cwd(), options.target);
  if (directRoots.length > 0) {
    return rootsResult(directRoots, null);
  }

  const projectRoots = await discoverProjectSkillsRootsAtPath(process.cwd(), options.target);
  if (projectRoots !== null) {
    return rootsResult(projectRoots.roots, projectRoots.projectPath);
  }

  const globalRoots = await discoverGlobalSkillsRoots(options.target);
  if (globalRoots.length > 0) {
    return rootsResult(globalRoots, null);
  }

  if (!process.stdin.isTTY) {
    throw new SkillzeroError("Pass a positional skills root or project path when running non-interactively.");
  }

  const selectedPath = await p.path({
    message: "Select the skills directory",
    directory: true,
  });

  if (p.isCancel(selectedPath)) {
    return { status: "cancelled" };
  }

  return {
    status: "ok",
    paths: [selectedPath],
    projectPath: null,
    discoveredRoots: [],
  };
}

async function resolveSkillInventories(
  options: CliOptions,
  assertDistinct: boolean,
): Promise<InventoryResolutionResult> {
  const rootsResult = await resolveSkillsRoots(options);
  if (rootsResult.status === "cancelled") {
    return rootsResult;
  }

  const inventories = await Promise.all(rootsResult.paths.map((rootPath) => scanSkills(rootPath)));
  if (assertDistinct) {
    await assertDistinctPhysicalSkills(inventories);
  }

  return {
    status: "ok",
    inventories,
    projectPath: rootsResult.projectPath,
    discoveredRoots: rootsResult.discoveredRoots,
  };
}

async function assertDistinctPhysicalSkills(inventories: SkillInventory[]): Promise<void> {
  const discoveredByFile = new Map<string, { rootPath: string; skillFile: string }>();
  for (const inventory of inventories) {
    for (const skill of allSkills(inventory)) {
      const physicalSkillFile = await realpath(skill.skillFile);
      const previous = discoveredByFile.get(physicalSkillFile);
      if (previous && previous.rootPath !== inventory.rootPath) {
        throw new SkillzeroError(
          `The same SKILL.md is linked into multiple roots: ${previous.skillFile} and ${skill.skillFile}. Run skillzero with one positional skills root, or link the whole skills root so skillzero can deduplicate it.`,
        );
      }

      discoveredByFile.set(physicalSkillFile, {
        rootPath: inventory.rootPath,
        skillFile: skill.skillFile,
      });
    }
  }
}

function allSkills(inventory: SkillInventory): SkillRecord[] {
  return [...inventory.activeSkills, ...inventory.managedSkills].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function reportNewSkills(inventory: SkillInventory, knownIds: Iterable<string>): string[] {
  const knownIdSet = new Set(knownIds);
  const newSkills = inventory.activeSkills.filter((skill) => !knownIdSet.has(skill.id));
  if (newSkills.length === 0) {
    return [];
  }

  const lines = ["These skills were found since the last sync:"];
  for (const skill of newSkills) {
    lines.push(`- ${skill.id} — ${skill.description}`);
  }
  lines.push("Select a skill to add it to skill-index; otherwise it stays top-level.");
  p.note(lines.join("\n"), "New skills available");
  return newSkills.map((skill) => skill.id);
}

async function promptForManagedSkills(
  inventory: SkillInventory,
  message: string,
  initialIds = inventory.managedSkills.map((skill) => skill.id),
  selectedHint = "managed",
): Promise<PromptSelectionResult> {
  const initiallyManaged = new Set(initialIds);
  const options = allSkills(inventory).map((skill) => ({
    value: skill.id,
    label: skill.id,
    hint: `${initiallyManaged.has(skill.id) ? selectedHint : skill.origin}: ${skill.description}`,
  }));

  const selectedIds = await p.multiselect<string>({
    message,
    options,
    initialValues: initialIds,
    required: false,
  });

  if (p.isCancel(selectedIds)) {
    return { status: "cancelled" };
  }

  return { status: "ok", selectedIds };
}

async function promptForCollectionDetails(
  existing: SkillCollection | null,
  collections: SkillCollection[],
  skills: SkillRecord[],
): Promise<PromptCollectionDetailsResult> {
  while (true) {
    const title = await p.text({
      message: "Collection title",
      initialValue: existing?.title ?? "",
      validate: (value) => ((value ?? "").trim().length > 0 ? undefined : "Enter a collection title."),
    });
    if (p.isCancel(title)) {
      return { status: "cancelled" };
    }

    const description = await p.text({
      message: "Collection description",
      initialValue: existing?.description ?? "",
      validate: (value) => ((value ?? "").trim().length > 0 ? undefined : "Enter a collection description."),
    });
    if (p.isCancel(description)) {
      return { status: "cancelled" };
    }

    const id = collectionIdFromTitle(title);
    const duplicate = collections.some((collection) => collection.id === id && collection.id !== existing?.id);
    if (duplicate) {
      p.note(`The title produces the existing collection id '${id}'. Choose a different title.`, "Collection id conflict");
      continue;
    }

    const availableIds = new Set(skills.map((skill) => skill.id));
    const initialValues = (existing?.skillIds ?? []).filter((skillId) => availableIds.has(skillId));
    const selectedIds = await p.multiselect<string>({
      message: `Skills in ${title}`,
      options: skills.map((skill) => ({
        value: skill.id,
        label: skill.id,
        hint: skill.description,
      })),
      initialValues,
      required: false,
    });
    if (p.isCancel(selectedIds)) {
      return { status: "cancelled" };
    }

    return {
      status: "ok",
      collection: {
        id,
        title: title.trim(),
        description: description.trim(),
        skillIds: selectedIds,
      },
    };
  }
}

async function promptForCollections(
  skills: SkillRecord[],
  initialCollections: SkillCollection[],
): Promise<PromptCollectionsResult> {
  let collections = initialCollections.map((collection) => ({
    ...collection,
    skillIds: [...collection.skillIds],
  }));

  while (true) {
    const action = await p.select<"add" | "edit" | "remove" | "done">({
      message: "Configure skill collections",
      options: [
        { value: "add", label: "Add collection", hint: "Create a title, description, and skill group." },
        ...(collections.length > 0
          ? [
              { value: "edit" as const, label: "Edit collection", hint: "Change its routing text or assigned skills." },
              { value: "remove" as const, label: "Remove collection", hint: "Delete its generated routing skill." },
            ]
          : []),
        { value: "done", label: "Done", hint: "Use the current collection configuration." },
      ],
    });
    if (p.isCancel(action)) {
      return { status: "cancelled" };
    }

    if (action === "done") {
      return { status: "ok", collections };
    }

    if (action === "add") {
      const result = await promptForCollectionDetails(null, collections, skills);
      if (result.status === "cancelled") {
        return result;
      }
      collections = [...collections, result.collection];
      continue;
    }

    const selectedCollectionId = await p.select<string>({
      message: action === "edit" ? "Choose a collection to edit" : "Choose a collection to remove",
      options: collections.map((collection) => ({
        value: collection.id,
        label: collection.title,
        hint: collection.description,
      })),
    });
    if (p.isCancel(selectedCollectionId)) {
      return { status: "cancelled" };
    }

    const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId);
    if (!selectedCollection) {
      throw new SkillzeroError(`Unknown collection: ${selectedCollectionId}`);
    }

    if (action === "edit") {
      const result = await promptForCollectionDetails(selectedCollection, collections, skills);
      if (result.status === "cancelled") {
        return result;
      }
      collections = collections.map((collection) =>
        collection.id === selectedCollectionId ? result.collection : collection,
      );
      continue;
    }

    const shouldRemove = await p.confirm({
      message: `Remove collection ${selectedCollection.title}?`,
      initialValue: false,
    });
    if (p.isCancel(shouldRemove)) {
      return { status: "cancelled" };
    }
    if (shouldRemove) {
      collections = collections.filter((collection) => collection.id !== selectedCollectionId);
    }
  }
}

function logInventory(inventory: SkillInventory): void {
  console.log(`${accent("◆")} ${bold("Skills directory")} ${dim(inventory.rootPath)}`);

  const sections = [
    { heading: "Active skills", skills: inventory.activeSkills, marker: success("✔") },
    { heading: "Managed skills", skills: inventory.managedSkills, marker: warning("◆") },
  ];

  for (const section of sections) {
    console.log();
    console.log(`${accent("◆")} ${bold(section.heading)} ${dim(`(${section.skills.length})`)}`);
    for (const skill of section.skills) {
      const description = skill.description.length > 0 ? ` ${dim("—")} ${dim(skill.description)}` : "";
      console.log(`   ${section.marker} ${bold(text(skill.id))}${description}`);
    }
  }

  console.log();
  console.log(`${accent("◆")} ${bold("Collections")} ${dim(`(${inventory.collections.length})`)}`);
  for (const collection of inventory.collections) {
    console.log(`   ${warning("◆")} ${bold(text(collection.title))}${dim(" — ")}${dim(collection.description)}`);
  }
}

function logDiscoveredAliases(discoveredRoots: DiscoveredSkillsRoot[]): void {
  for (const root of discoveredRoots) {
    if (root.aliases.length > 1) {
      console.log(
        `${accent("◆")} ${dim("Deduplicated linked skills roots:")} ${root.aliases.join(" → ")}`,
      );
    }
  }
}

function logOperationRoot(inventory: SkillInventory, count: number): void {
  if (count > 1) {
    console.log(`\n${accent("◆")} ${bold("Skills directory")} ${dim(inventory.rootPath)}`);
  }
}

export async function runScan(options: CliOptions): Promise<number> {
  const inventoryResult = await resolveSkillInventories(options, false);
  if (inventoryResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inventoryResult.inventories.length === 0) {
    console.log(`No supported skills directories found in ${inventoryResult.projectPath}.`);
    return 0;
  }

  logDiscoveredAliases(inventoryResult.discoveredRoots);
  for (const inventory of inventoryResult.inventories) {
    logInventory(inventory);
  }
  return 0;
}

async function runConfigureForInventory(options: CliOptions, inventory: SkillInventory): Promise<number> {
  if (inventory.activeSkills.length === 0 && inventory.managedSkills.length === 0) {
    console.log(`No skills found in ${inventory.rootPath}.`);
    return 0;
  }

  const inPlace = usesInPlaceStrategy(options);
  if (inPlace && inventory.managedSkills.length > 0) {
    throw new SkillzeroError(
      "This skills directory currently uses moved mode. Run skillzero <skills-dir> with --codex, --copilot, or --gemini before switching to --claude or --cursor.",
    );
  }

  const inPlaceState = inPlace ? await readInPlaceState(inventory) : null;
  if (!inPlace && (await readInPlaceState(inventory))) {
    throw new SkillzeroError(
      "This skills directory currently uses in-place mode. Deselect its manual-only skills with --claude or --cursor before switching to --codex, --copilot, or --gemini.",
    );
  }

  const activeIds = new Set(inventory.activeSkills.map((skill) => skill.id));
  const initialInPlaceIds = inPlaceState?.skills
    .map((skill) => skill.id)
    .filter((id) => activeIds.has(id));
  const selectionResult = await promptForManagedSkills(
    inventory,
    inPlace
      ? "Select skills to keep in place and make manual-only through skill-index"
      : "Select skills to manage through skill-index",
    inPlace ? (initialInPlaceIds ?? []) : undefined,
    inPlace ? "manual-only" : "managed",
  );
  if (selectionResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inPlace) {
    const plan = await buildInPlacePlan(inventory, selectionResult.selectedIds, inPlaceState);
    p.note(formatInPlacePlan(plan), "Preview");
    if (options.dryRun) {
      return 0;
    }

    const confirmation = await confirmApply(options);
    if (confirmation !== "apply") {
      return reportDeclined(confirmation);
    }

    await applyInPlacePlan(plan, inventory);
    await clearHandoffState(inventory);
    await clearRedoState(inventory.rootPath);
    p.outro("skillzero updated.");
    return 0;
  }

  const plan = await buildMovePlan(inventory, selectionResult.selectedIds);
  p.note(formatMovePlan(plan), "Preview");
  if (options.dryRun) {
    return 0;
  }

  const confirmation = await confirmApply(options);
  if (confirmation !== "apply") {
    return reportDeclined(confirmation);
  }

  await applyMovePlan(plan);
  await clearRedoState(inventory.rootPath);
  p.outro("skillzero updated.");
  return 0;
}

export async function runConfigure(options: CliOptions): Promise<number> {
  const inventoryResult = await resolveSkillInventories(options, true);
  if (inventoryResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inventoryResult.inventories.length === 0) {
    console.log(`No supported skills directories found in ${inventoryResult.projectPath}.`);
    return 0;
  }

  logDiscoveredAliases(inventoryResult.discoveredRoots);
  for (const inventory of inventoryResult.inventories) {
    logOperationRoot(inventory, inventoryResult.inventories.length);
    const exitCode = await runConfigureForInventory(options, inventory);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

async function runCollectionsForInventory(options: CliOptions, inventory: SkillInventory): Promise<number> {
  const inPlace = usesInPlaceStrategy(options);
  if (inPlace) {
    const state = await readInPlaceState(inventory);
    const availableIds = new Set(inventory.activeSkills.map((skill) => skill.id));
    const selectedIds = (state?.skills.map((skill) => skill.id) ?? []).filter((id) => availableIds.has(id));
    const initialPlan = await buildInPlacePlan(inventory, selectedIds, state);
    if (initialPlan.finalManagedSkills.length === 0 && inventory.collections.length === 0) {
      console.log(`No non-top-level skills or collections found in ${inventory.rootPath}.`);
      return 0;
    }

    const collectionResult = await promptForCollections(initialPlan.finalManagedSkills, inventory.collections);
    if (collectionResult.status === "cancelled") {
      p.cancel("Operation cancelled.");
      return 130;
    }

    const plan = await buildInPlacePlan(inventory, selectedIds, state, collectionResult.collections);
    p.note(formatInPlacePlan(plan), "Preview");
    if (options.dryRun) {
      return 0;
    }

    const confirmation = await confirmApply(options);
    if (confirmation !== "apply") {
      return reportDeclined(confirmation);
    }

    await applyInPlacePlan(plan, inventory);
    await clearRedoState(inventory.rootPath);
    p.outro("skillzero collections updated.");
    return 0;
  }

  if (await readInPlaceState(inventory)) {
    throw new SkillzeroError(
      "This skills directory currently uses in-place mode. Manage collections with --claude or --cursor.",
    );
  }
  if (await readHandoffState(inventory)) {
    throw new SkillzeroError("Skills are already released. Run sync before editing collections.");
  }

  const selectedIds = inventory.managedSkills.map((skill) => skill.id);
  const initialPlan = await buildMovePlan(inventory, selectedIds);
  if (initialPlan.finalManagedSkills.length === 0 && inventory.collections.length === 0) {
    console.log(`No non-top-level skills or collections found in ${inventory.rootPath}.`);
    return 0;
  }

  const collectionResult = await promptForCollections(initialPlan.finalManagedSkills, inventory.collections);
  if (collectionResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  const plan = await buildMovePlan(inventory, selectedIds, collectionResult.collections);
  p.note(formatMovePlan(plan), "Preview");
  if (options.dryRun) {
    return 0;
  }

  const confirmation = await confirmApply(options);
  if (confirmation !== "apply") {
    return reportDeclined(confirmation);
  }

  await applyMovePlan(plan);
  await clearRedoState(inventory.rootPath);
  p.outro("skillzero collections updated.");
  return 0;
}

export async function runCollections(options: CliOptions): Promise<number> {
  const inventoryResult = await resolveSkillInventories(options, true);
  if (inventoryResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inventoryResult.inventories.length === 0) {
    console.log(`No supported skills directories found in ${inventoryResult.projectPath}.`);
    return 0;
  }

  logDiscoveredAliases(inventoryResult.discoveredRoots);
  for (const inventory of inventoryResult.inventories) {
    logOperationRoot(inventory, inventoryResult.inventories.length);
    const exitCode = await runCollectionsForInventory(options, inventory);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

function formatHandoffPlan(plan: Awaited<ReturnType<typeof buildMovePlan>>): string {
  const lines = ["Temporarily release managed skills:"];
  const restored = plan.operations.filter((operation) => operation.kind === "restore-to-root");

  if (restored.length === 0) {
    lines.push("- No managed skill folders need to move.");
  }
  for (const operation of restored) {
    lines.push(`- Restore to root: ${operation.id}`);
  }
  lines.push("- Remove the generated skill-index router until you run sync.");
  return lines.join("\n");
}

async function confirmApply(options: CliOptions): Promise<"apply" | "cancelled" | "declined"> {
  if (options.yes) {
    return "apply";
  }

  const shouldApply = await p.confirm({
    message: "Apply these changes?",
    initialValue: false,
  });
  if (p.isCancel(shouldApply)) {
    return "cancelled";
  }
  return shouldApply ? "apply" : "declined";
}

function reportDeclined(result: "cancelled" | "declined"): number {
  p.cancel("No changes applied.");
  return result === "cancelled" ? 130 : 0;
}

async function runManageForInventory(options: CliOptions, inventory: SkillInventory): Promise<number> {
  if (usesInPlaceStrategy(options)) {
    if (inventory.managedSkills.length > 0) {
      throw new SkillzeroError("This skills directory has moved skills. Run skillzero update with --codex or --copilot first.");
    }

    p.note(
      "Selected skills already stay in their ordinary folders, so the skills CLI can manage them without a temporary release.",
      "No release needed",
    );
    if (!options.dryRun) {
      p.outro("Skills are ready for the skills CLI. Run skillzero afterwards to restore manual-only metadata.");
    }
    return 0;
  }

  if (await readInPlaceState(inventory)) {
    throw new SkillzeroError(
      "This skills directory currently uses in-place mode. Deselect its manual-only skills with --claude or --cursor before managing it with --codex or --copilot.",
    );
  }

  if (await readHandoffState(inventory)) {
    throw new SkillzeroError("Skills are already released. Run your skills command, then run skillzero to sync.");
  }

  const plan = await buildMovePlan(inventory, []);
  p.note(formatHandoffPlan(plan), "Preview");
  if (options.dryRun) {
    return 0;
  }

  const confirmation = await confirmApply(options);
  if (confirmation !== "apply") {
    return reportDeclined(confirmation);
  }

  await applyHandoff(plan, inventory);
  p.outro("Skills released. Run your skills command, then run skillzero to rebuild the index.");
  return 0;
}

export async function runManage(options: CliOptions): Promise<number> {
  const inventoryResult = await resolveSkillInventories(options, true);
  if (inventoryResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inventoryResult.inventories.length === 0) {
    console.log(`No supported skills directories found in ${inventoryResult.projectPath}.`);
    return 0;
  }

  logDiscoveredAliases(inventoryResult.discoveredRoots);
  for (const inventory of inventoryResult.inventories) {
    logOperationRoot(inventory, inventoryResult.inventories.length);
    const exitCode = await runManageForInventory(options, inventory);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

function readForwardedUpdateArgs(argv: readonly string[]): string[] {
  // CAC owns skillzero's wrapper flags. Read the original argv so unknown
  // flags such as --global and -p reach the upstream skills CLI in their
  // original order; use -- when a forwarded flag is ambiguous.
  const commandIndex = argv.findIndex((argument, index) => index >= 2 && argument === "update");
  if (commandIndex === -1) {
    return [];
  }

  const rawArguments = argv.slice(commandIndex + 1);
  const forwardedArgs: string[] = [];
  let afterSeparator = false;

  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index];
    if (argument === undefined) {
      continue;
    }
    if (afterSeparator) {
      forwardedArgs.push(argument);
      continue;
    }
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }

    const optionName = argument.startsWith("--") ? (argument.split("=", 1)[0] ?? argument) : argument;
    if (UPDATE_WRAPPER_BOOLEAN_OPTIONS.has(optionName)) {
      continue;
    }

    forwardedArgs.push(argument);
  }

  return forwardedArgs;
}

function runSkillsUpdate(forwardedArgs: readonly string[] = []): number {
  const result = spawnSync("skills", ["update", ...forwardedArgs], { stdio: "inherit" });
  if (result.error) {
    throw new SkillzeroError(`Could not run skills update: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new SkillzeroError(`skills update exited with status ${result.status ?? "unknown"}. Run skillzero when it is ready.`);
  }
  return 0;
}

export async function runUpdate(options: CliOptions, forwardedArgs: readonly string[] = []): Promise<number> {
  // The handoff state is written before the upstream process starts. If that
  // process fails, the state deliberately remains so a later sync can recover.
  const exitCode = await runManage(options);
  if (exitCode !== 0 || options.dryRun) {
    return exitCode;
  }

  runSkillsUpdate(forwardedArgs);
  return runSync(options, {
    ignoreMissingSkills: true,
    skipUnconfiguredInPlace: true,
    autoApply: true,
  });
}

async function runInPlaceSync(
  options: CliOptions,
  inventory: SkillInventory,
  behavior: SyncBehavior,
): Promise<number> {
  const state = await readInPlaceState(inventory);
  if (!state) {
    if (behavior.skipUnconfiguredInPlace) {
      // A successful upstream update is a new operation, so it invalidates a
      // redo snapshot even when there is no in-place state to rebuild.
      await clearRedoState(inventory.rootPath);
      return 0;
    }
    throw new SkillzeroError("No in-place skills are waiting to sync. Run skillzero <skills-dir> --claude or --cursor first.");
  }

  const availableIds = new Set(inventory.activeSkills.map((skill) => skill.id));
  const missingIds = state.skills.map((skill) => skill.id).filter((id) => !availableIds.has(id));
  const newSkillIds = reportNewSkills(inventory, state.skills.map((skill) => skill.id));
  if (missingIds.length > 0 && !behavior.ignoreMissingSkills && !options.yes) {
    const shouldForget = await p.confirm({
      message: `${missingIds.join(", ")} ${missingIds.length === 1 ? "was" : "were"} removed. Forget ${missingIds.length === 1 ? "it" : "them"} from the manual-only set?`,
      initialValue: true,
    });
    if (p.isCancel(shouldForget)) {
      p.cancel("Operation cancelled.");
      return 130;
    }
    if (!shouldForget) {
      p.cancel("No changes applied. Restore the missing skills before syncing.");
      return 0;
    }
  }

  const retainedIds = state.skills.map((skill) => skill.id).filter((id) => availableIds.has(id));
  const selectionResult = options.yes || (behavior.autoApply && newSkillIds.length === 0)
    ? { status: "ok" as const, selectedIds: retainedIds }
    : await promptForManagedSkills(
        inventory,
        "Select skills to keep manual-only through skill-index (new skills stay visible unless selected)",
        retainedIds,
        "manual-only",
      );
  if (selectionResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  const plan = await buildInPlacePlan(inventory, selectionResult.selectedIds, state);
  p.note(formatInPlacePlan(plan), "Preview");
  if (options.dryRun) {
    return 0;
  }

  if (!behavior.autoApply) {
    const confirmation = await confirmApply(options);
    if (confirmation !== "apply") {
      return reportDeclined(confirmation);
    }
  }

  await applyInPlacePlan(plan, inventory);
  await clearRedoState(inventory.rootPath);
  p.outro("skillzero index restored.");
  return 0;
}

async function runSyncForInventory(
  options: CliOptions,
  inventory: SkillInventory,
  behavior: SyncBehavior,
): Promise<number> {
  if (usesInPlaceStrategy(options)) {
    return runInPlaceSync(options, inventory, behavior);
  }

  if (await readInPlaceState(inventory)) {
    throw new SkillzeroError(
      "This skills directory currently uses in-place mode. Sync it with --claude or --cursor, or deselect its manual-only skills before using --codex or --copilot.",
    );
  }

  const state = await readHandoffState(inventory);
  const managedIds = state?.managedIds ?? inventory.managedSkills.map((skill) => skill.id);
  if (state === null && inventory.managedSkills.length === 0) {
    throw new SkillzeroError("No managed skills are waiting to sync. Run skillzero first.");
  }

  const availableIds = new Set(allSkills(inventory).map((skill) => skill.id));
  const missingIds = managedIds.filter((id) => !availableIds.has(id));
  const newSkillIds = reportNewSkills(inventory, managedIds);
  if (missingIds.length > 0 && !behavior.ignoreMissingSkills && !options.yes) {
    const shouldForget = await p.confirm({
      message: `${missingIds.join(", ")} ${missingIds.length === 1 ? "was" : "were"} removed. Forget ${missingIds.length === 1 ? "it" : "them"} from the managed set?`,
      initialValue: true,
    });
    if (p.isCancel(shouldForget)) {
      p.cancel("Operation cancelled.");
      return 130;
    }
    if (!shouldForget) {
      p.cancel("No changes applied. Restore the missing skills before syncing.");
      return 0;
    }
  }

  const retainedIds = managedIds.filter((id) => availableIds.has(id));
  const selectionResult = options.yes || (behavior.autoApply && newSkillIds.length === 0)
    ? { status: "ok" as const, selectedIds: retainedIds }
    : await promptForManagedSkills(
        inventory,
        "Select skills to restore into skill-index (new skills stay visible unless selected)",
        retainedIds,
      );
  if (selectionResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  const plan = await buildMovePlan(inventory, selectionResult.selectedIds);
  p.note(formatMovePlan(plan), "Preview");
  if (options.dryRun) {
    return 0;
  }

  if (!behavior.autoApply) {
    const confirmation = await confirmApply(options);
    if (confirmation !== "apply") {
      return reportDeclined(confirmation);
    }
  }

  await applySync(plan, inventory);
  await clearRedoState(inventory.rootPath);
  p.outro("skillzero index restored.");
  return 0;
}

export async function runSync(
  options: CliOptions,
  behavior: SyncBehavior = DEFAULT_SYNC_BEHAVIOR,
): Promise<number> {
  const inventoryResult = await resolveSkillInventories(options, true);
  if (inventoryResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inventoryResult.inventories.length === 0) {
    console.log(`No supported skills directories found in ${inventoryResult.projectPath}.`);
    return 0;
  }

  logDiscoveredAliases(inventoryResult.discoveredRoots);
  for (const inventory of inventoryResult.inventories) {
    logOperationRoot(inventory, inventoryResult.inventories.length);
    const exitCode = await runSyncForInventory(options, inventory, behavior);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

async function runUndoForInventory(options: CliOptions, inventory: SkillInventory): Promise<number> {
  const plan = await buildUndoPlan(inventory);
  p.note(formatUndoPlan(plan), "Preview");
  if (options.dryRun) {
    return 0;
  }

  const confirmation = await confirmApply(options);
  if (confirmation !== "apply") {
    return reportDeclined(confirmation);
  }

  await applyUndoPlan(plan, inventory);
  p.outro("skillzero changes undone. Run skillzero redo to restore them.");
  return 0;
}

export async function runUndo(options: CliOptions): Promise<number> {
  const inventoryResult = await resolveSkillInventories(options, true);
  if (inventoryResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inventoryResult.inventories.length === 0) {
    console.log("No supported skills directories found in " + inventoryResult.projectPath + ".");
    return 0;
  }

  logDiscoveredAliases(inventoryResult.discoveredRoots);
  for (const inventory of inventoryResult.inventories) {
    logOperationRoot(inventory, inventoryResult.inventories.length);
    const exitCode = await runUndoForInventory(options, inventory);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

async function runRedoForInventory(options: CliOptions, inventory: SkillInventory): Promise<number> {
  const plan = await buildRedoPlan(inventory);
  p.note(formatRedoPlan(plan), "Preview");
  if (options.dryRun) {
    return 0;
  }

  const confirmation = await confirmApply(options);
  if (confirmation !== "apply") {
    return reportDeclined(confirmation);
  }

  await applyRedoPlan(plan, inventory);
  p.outro("skillzero changes restored.");
  return 0;
}

export async function runRedo(options: CliOptions): Promise<number> {
  const inventoryResult = await resolveSkillInventories(options, true);
  if (inventoryResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inventoryResult.inventories.length === 0) {
    console.log("No supported skills directories found in " + inventoryResult.projectPath + ".");
    return 0;
  }

  logDiscoveredAliases(inventoryResult.discoveredRoots);
  for (const inventory of inventoryResult.inventories) {
    logOperationRoot(inventory, inventoryResult.inventories.length);
    const exitCode = await runRedoForInventory(options, inventory);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

function readPositionalScope(options: CliOptions, argument: string): CliOptions {
  if (options.scope !== null) {
    throw new SkillzeroError("Pass only one positional scope path.");
  }

  return { ...options, scope: argument };
}

async function runDefault(options: CliOptions): Promise<number> {
  const inventoryResult = await resolveSkillInventories(options, true);
  if (inventoryResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  if (inventoryResult.inventories.length === 0) {
    console.log(`No supported skills directories found in ${inventoryResult.projectPath}.`);
    return 0;
  }

  const inPlaceStates = new Map<string, boolean>();
  const moveStates = new Map<string, boolean>();
  let hasInPlaceState = false;
  let hasMoveState = false;
  for (const inventory of inventoryResult.inventories) {
    const inPlaceState = await readInPlaceState(inventory);
    const handoffState = await readHandoffState(inventory);
    inPlaceStates.set(inventory.rootPath, inPlaceState !== null);
    moveStates.set(inventory.rootPath, handoffState !== null || inventory.managedSkills.length > 0);
    hasInPlaceState ||= inPlaceState !== null;
    hasMoveState ||= handoffState !== null || inventory.managedSkills.length > 0;
  }

  if (hasInPlaceState && hasMoveState) {
    throw new SkillzeroError(
      "Discovered skills directories use mixed layouts. Run skillzero with one path at a time to sync them safely.",
    );
  }

  const resolvedOptions: CliOptions = {
    ...options,
    // An explicit harness flag is authoritative. Bare invocation is the only
    // mode that infers the existing layout from state and nested managed skills.
    strategy: options.target === null ? (hasInPlaceState ? "in-place" : "move") : null,
  };
  logDiscoveredAliases(inventoryResult.discoveredRoots);
  for (const inventory of inventoryResult.inventories) {
    logOperationRoot(inventory, inventoryResult.inventories.length);
    const shouldSync =
      (hasInPlaceState && inPlaceStates.get(inventory.rootPath) === true) ||
      (!hasInPlaceState && moveStates.get(inventory.rootPath) === true);
    const exitCode = shouldSync
      ? await runSyncForInventory(resolvedOptions, inventory, DEFAULT_SYNC_BEHAVIOR)
      : await runConfigureForInventory(resolvedOptions, inventory);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

function printUnknownCommand(args: readonly string[]): void {
  console.error(`Unknown command: ${args.join(" ")}`);
  console.error(`Run ${CLI_NAME} --help for usage.`);
}

export async function runCli(argv: string[]): Promise<number> {
  let exitCode = 0;
  const cli = cac(CLI_NAME);
  cli.usage("[path] [options]");

  cli
    .option("--dry-run", "Preview changes without moving files")
    .option("--yes", "Apply after preview without a confirmation prompt")
    .option("--claude", "Use in-place manual-only metadata for Claude Code")
    .option("--cursor", "Use in-place manual-only metadata for Cursor")
    .option("--codex", "Use move-based indexing for Codex")
    .option("--copilot", "Use move-based indexing for Copilot")
    .option("--gemini", "Use move-based indexing for Gemini CLI")
    .help()
    .version(CLI_VERSION);

  cli
    .command("undo", "Undo skillzero's generated layout changes")
    .action(async (options) => {
      exitCode = await runUndo(readCliOptions(options));
    });

  cli
    .command("redo", "Redo the last skillzero undo")
    .action(async (options) => {
      exitCode = await runRedo(readCliOptions(options));
    });

  cli
    .command("collections", "Configure title-and-description groups for managed skills")
    .action(async (options) => {
      exitCode = await runCollections(readCliOptions(options));
    });

  cli
    .command("update [...skillArgs]", "Restore, run skills update, and rebuild skillzero indexes")
    .allowUnknownOptions()
    .action(async (_skillArgs, options) => {
      exitCode = await runUpdate(readCliOptions(options), readForwardedUpdateArgs(argv));
    });

  try {
    cli.parse(argv, { run: false });

    if (readOption(cli.options, "help") === true || readOption(cli.options, "version") === true) {
      return 0;
    }

    if (cli.matchedCommand) {
      printBanner();
      await cli.runMatchedCommand();
      return exitCode;
    }

    if (cli.args.length === 0) {
      printBanner();
      return await runDefault(readCliOptions(cli.options));
    }

    if (cli.args.length === 1) {
      printBanner();
      const options = await readPositionalScope(readCliOptions(cli.options), cli.args[0] ?? "");
      return await runDefault(options);
    }

    printUnknownCommand(cli.args);
    return 1;
  } catch (error) {
    if (error instanceof SkillzeroError) {
      console.error(error.message);
      return 1;
    }

    throw error;
  }
}
