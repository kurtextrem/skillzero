import * as p from "@clack/prompts";
import cac from "cac";
import { spawnSync } from "node:child_process";

import { applyMovePlan } from "./apply.js";
import { CLI_NAME, CLI_VERSION } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { applyHandoff, applySync, readHandoffState } from "./handoff.js";
import { buildMovePlan, formatMovePlan } from "./plan.js";
import { scanSkills } from "./scanner.js";
import { accent, bold, dim, printBanner, success, text, warning } from "./ui.js";

import type { SkillInventory, SkillRecord } from "./types.js";

interface CliOptions {
  path: string | null;
  dryRun: boolean;
  yes: boolean;
}

type PromptPathResult =
  | { status: "ok"; path: string }
  | { status: "cancelled" };

type PromptSelectionResult =
  | { status: "ok"; selectedIds: string[] }
  | { status: "cancelled" };

function readOption(options: unknown, key: string): unknown {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }

  return Reflect.get(options, key);
}

function readCliOptions(options: unknown): CliOptions {
  const pathValue = readOption(options, "path");
  return {
    path: typeof pathValue === "string" && pathValue.trim().length > 0 ? pathValue : null,
    dryRun: readOption(options, "dryRun") === true,
    yes: readOption(options, "yes") === true,
  };
}

async function resolveSkillsPath(options: CliOptions): Promise<PromptPathResult> {
  if (options.path !== null) {
    return { status: "ok", path: options.path };
  }

  if (!process.stdin.isTTY) {
    throw new SkillzeroError("Pass --path <dir> when running non-interactively.");
  }

  const selectedPath = await p.path({
    message: "Select the skills directory",
    directory: true,
  });

  if (p.isCancel(selectedPath)) {
    return { status: "cancelled" };
  }

  return { status: "ok", path: selectedPath };
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
): Promise<PromptSelectionResult> {
  const initiallyManaged = new Set(initialIds);
  const options = allSkills(inventory).map((skill) => ({
    value: skill.id,
    label: skill.id,
    hint: `${initiallyManaged.has(skill.id) ? "managed before handoff" : skill.origin}: ${skill.description}`,
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

export async function runScan(options: CliOptions): Promise<number> {
  const pathResult = await resolveSkillsPath(options);
  if (pathResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  const inventory = await scanSkills(pathResult.path);
  logInventory(inventory);
  return 0;
}

export async function runConfigure(options: CliOptions): Promise<number> {
  const pathResult = await resolveSkillsPath(options);
  if (pathResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  const inventory = await scanSkills(pathResult.path);
  if (inventory.activeSkills.length === 0 && inventory.managedSkills.length === 0) {
    console.log(`No skills found in ${inventory.rootPath}.`);
    return 0;
  }

  const selectionResult = await promptForManagedSkills(inventory, "Select skills to manage through skill-index");
  if (selectionResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  const plan = await buildMovePlan(inventory, selectionResult.selectedIds);
  const preview = formatMovePlan(plan);
  p.note(preview, "Preview");

  if (options.dryRun) {
    return 0;
  }

  if (!options.yes) {
    const shouldApply = await p.confirm({
      message: "Apply these changes?",
      initialValue: false,
    });

    if (p.isCancel(shouldApply) || !shouldApply) {
      p.cancel("No changes applied.");
      return p.isCancel(shouldApply) ? 130 : 0;
    }
  }

  await applyMovePlan(plan);
  p.outro("skillzero updated.");
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

export async function runManage(options: CliOptions): Promise<number> {
  const pathResult = await resolveSkillsPath(options);
  if (pathResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  const inventory = await scanSkills(pathResult.path);
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
  const exitCode = await runManage(options);
  if (exitCode !== 0 || options.dryRun) {
    return exitCode;
  }

  return runSkillsUpdate();
}

export async function runSync(options: CliOptions): Promise<number> {
  const pathResult = await resolveSkillsPath(options);
  if (pathResult.status === "cancelled") {
    p.cancel("Operation cancelled.");
    return 130;
  }

  const inventory = await scanSkills(pathResult.path);
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

function printUnknownCommand(args: readonly string[]): void {
  console.error(`Unknown command: ${args.join(" ")}`);
  console.error(`Run ${CLI_NAME} --help for usage.`);
}

export async function runCli(argv: string[]): Promise<number> {
  let exitCode = 0;
  const cli = cac(CLI_NAME);

  cli
    .option("--path <dir>", "Skills directory to scan")
    .option("--dry-run", "Preview changes without moving files")
    .option("--yes", "Apply after preview without a confirmation prompt")
    .help()
    .version(CLI_VERSION);

  cli.command("configure", "Select skills and update the generated skill index").action(async (options) => {
    exitCode = await runConfigure(readCliOptions(options));
  });

  cli.command("manage", "Release managed skills so the skills CLI can manage them").action(async (options) => {
    exitCode = await runManage(readCliOptions(options));
  });

  cli.command("update", "Release managed skills and run skills update").action(async (options) => {
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
