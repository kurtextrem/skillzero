import * as p from "@clack/prompts";
import cac from "cac";
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";

import { applyMovePlan } from "./apply.js";
import { CLI_NAME, CLI_VERSION } from "./constants.js";
import { discoverSkillsRoots } from "./discovery.js";
import { SkillzeroError } from "./errors.js";
import { applyHandoff, applySync, clearHandoffState, readHandoffState } from "./handoff.js";
import { applyInPlacePlan, buildInPlacePlan, formatInPlacePlan, readInPlaceState } from "./in-place.js";
import { buildMovePlan, formatMovePlan } from "./plan.js";
import { scanSkills } from "./scanner.js";
import { accent, bold, dim, printBanner, success, text, warning } from "./ui.js";

import type { DiscoveredSkillsRoot, InvocationTarget, SkillInventory, SkillRecord } from "./types.js";

interface CliOptions {
  path: string | null;
  project: string | null;
  dryRun: boolean;
  yes: boolean;
  target: InvocationTarget | null;
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

function readCliOptions(options: unknown): CliOptions {
  const pathValue = readOption(options, "path");
  const projectValue = readOption(options, "project");
  const path = typeof pathValue === "string" && pathValue.trim().length > 0 ? pathValue : null;
  const project = typeof projectValue === "string" && projectValue.trim().length > 0 ? projectValue : null;
  if (path !== null && project !== null) {
    throw new SkillzeroError("Pass either --path <skills-dir> or --project <dir>, not both.");
  }

  return {
    path,
    project,
    dryRun: readOption(options, "dryRun") === true,
    yes: readOption(options, "yes") === true,
    target: readInvocationTarget(options),
  };
}

function usesInPlaceStrategy(options: CliOptions): boolean {
  // A shared .agents root has one filesystem layout, so these flags are aliases
  // for the same in-place strategy rather than separate per-harness settings.
  return options.target === "claude" || options.target === "cursor";
}

async function resolveSkillsRoots(options: CliOptions, targetRequired: boolean): Promise<PromptRootsResult> {
  if (options.path !== null) {
    return {
      status: "ok",
      paths: [options.path],
      projectPath: null,
      discoveredRoots: [],
    };
  }

  if (options.project !== null) {
    if (targetRequired && options.target === null) {
      throw new SkillzeroError(
        "Pass a target flag with --project: --claude, --cursor, --codex, --copilot, or --gemini.",
      );
    }

    const discoveredRoots = await discoverSkillsRoots(options.project, options.target);
    return {
      status: "ok",
      paths: discoveredRoots.map((root) => root.path),
      projectPath: options.project,
      discoveredRoots,
    };
  }

  if (!process.stdin.isTTY) {
    throw new SkillzeroError("Pass --path <skills-dir> or --project <dir> when running non-interactively.");
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
  targetRequired: boolean,
): Promise<InventoryResolutionResult> {
  const rootsResult = await resolveSkillsRoots(options, targetRequired);
  if (rootsResult.status === "cancelled") {
    return rootsResult;
  }

  const inventories = await Promise.all(rootsResult.paths.map((rootPath) => scanSkills(rootPath)));
  if (targetRequired) {
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
          `The same SKILL.md is linked into multiple roots: ${previous.skillFile} and ${skill.skillFile}. Use --path for one root, or link the whole skills root so skillzero can deduplicate it.`,
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
      "This skills directory currently uses moved mode. Run manage with --codex, --copilot, or --gemini before switching to --claude or --cursor.",
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
      throw new SkillzeroError("This skills directory has moved skills. Run manage with --codex or --copilot first.");
    }

    p.note(
      "Selected skills already stay in their ordinary folders, so the skills CLI can manage them without a temporary release.",
      "No release needed",
    );
    if (!options.dryRun) {
      p.outro("Skills are ready for the skills CLI. Run skillzero sync afterwards to restore manual-only metadata.");
    }
    return 0;
  }

  if (await readInPlaceState(inventory)) {
    throw new SkillzeroError(
      "This skills directory currently uses in-place mode. Deselect its manual-only skills with --claude or --cursor before managing it with --codex or --copilot.",
    );
  }

  if (await readHandoffState(inventory)) {
    throw new SkillzeroError("Skills are already released. Run your skills command, then run skillzero sync.");
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
  p.outro("Skills released. Run your skills command, then run skillzero sync to rebuild the index.");
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

function runSkillsUpdate(): number {
  const result = spawnSync("skills", ["update"], { stdio: "inherit" });
  if (result.error) {
    throw new SkillzeroError(`Could not run skills update: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new SkillzeroError(`skills update exited with status ${result.status ?? "unknown"}. Run skillzero sync when it is ready.`);
  }
  return 0;
}

export async function runUpdate(options: CliOptions): Promise<number> {
  if (usesInPlaceStrategy(options)) {
    const exitCode = await runManage(options);
    if (exitCode !== 0 || options.dryRun) {
      return exitCode;
    }

    return runSkillsUpdate();
  }

  const exitCode = await runManage(options);
  if (exitCode !== 0 || options.dryRun) {
    return exitCode;
  }

  return runSkillsUpdate();
}

async function runInPlaceSync(options: CliOptions, inventory: SkillInventory): Promise<number> {
  const state = await readInPlaceState(inventory);
  if (!state) {
    throw new SkillzeroError("No in-place skills are waiting to sync. Run skillzero configure --claude or --cursor first.");
  }

  const availableIds = new Set(inventory.activeSkills.map((skill) => skill.id));
  const missingIds = state.skills.map((skill) => skill.id).filter((id) => !availableIds.has(id));
  if (missingIds.length > 0 && !options.yes) {
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
  const selectionResult = options.yes
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

  const confirmation = await confirmApply(options);
  if (confirmation !== "apply") {
    return reportDeclined(confirmation);
  }

  await applyInPlacePlan(plan, inventory);
  p.outro("skillzero index restored.");
  return 0;
}

async function runSyncForInventory(options: CliOptions, inventory: SkillInventory): Promise<number> {
  if (usesInPlaceStrategy(options)) {
    return runInPlaceSync(options, inventory);
  }

  if (await readInPlaceState(inventory)) {
    throw new SkillzeroError(
      "This skills directory currently uses in-place mode. Sync it with --claude or --cursor, or deselect its manual-only skills before using --codex or --copilot.",
    );
  }

  const state = await readHandoffState(inventory);
  if (!state) {
    throw new SkillzeroError("No released skills are waiting to sync. Run skillzero manage or skillzero update first.");
  }

  const availableIds = new Set(allSkills(inventory).map((skill) => skill.id));
  const missingIds = state.managedIds.filter((id) => !availableIds.has(id));
  if (missingIds.length > 0 && !options.yes) {
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

  const retainedIds = state.managedIds.filter((id) => availableIds.has(id));
  const selectionResult = options.yes
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

  const confirmation = await confirmApply(options);
  if (confirmation !== "apply") {
    return reportDeclined(confirmation);
  }

  await applySync(plan, inventory);
  p.outro("skillzero index restored.");
  return 0;
}

export async function runSync(options: CliOptions): Promise<number> {
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
    const exitCode = await runSyncForInventory(options, inventory);
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

  cli
    .option("--path <dir>", "Skills directory to scan")
    .option("--project <dir>", "Discover supported skills directories under a project")
    .option("--dry-run", "Preview changes without moving files")
    .option("--yes", "Apply after preview without a confirmation prompt")
    .option("--claude", "Use in-place manual-only metadata for Claude Code")
    .option("--cursor", "Use in-place manual-only metadata for Cursor")
    .option("--codex", "Use move-based indexing for Codex")
    .option("--copilot", "Use move-based indexing for Copilot")
    .option("--gemini", "Use move-based indexing for Gemini CLI")
    .help()
    .version(CLI_VERSION);

  cli.command("configure", "Select skills and update the generated skill index").action(async (options) => {
    exitCode = await runConfigure(readCliOptions(options));
  });

  cli.command("manage", "Release moved skills so the skills CLI can manage them").action(async (options) => {
    exitCode = await runManage(readCliOptions(options));
  });

  cli.command("update", "Prepare skills and run skills update").action(async (options) => {
    exitCode = await runUpdate(readCliOptions(options));
  });

  cli.command("sync", "Restore the skill-index after skills management").action(async (options) => {
    exitCode = await runSync(readCliOptions(options));
  });

  cli.command("scan", "Print a read-only skills summary").action(async (options) => {
    exitCode = await runScan(readCliOptions(options));
  });

  try {
    cli.parse(argv, { run: false });

    if (cli.matchedCommand) {
      printBanner();
      await cli.runMatchedCommand();
      return exitCode;
    }

    if (cli.args.length === 0) {
      printBanner();
      return runConfigure(readCliOptions(cli.options));
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
