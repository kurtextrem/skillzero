import * as p from "@clack/prompts";
import cac from "cac";
import { spawnSync } from "node:child_process";

import { collectionSkillIds } from "./collections.js";
import { CLI_NAME, CLI_VERSION } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { clearRedoState } from "./history.js";
import {
	applyManagedSkillsPlan,
	buildManagedSkillsPlan,
	formatManagedSkillsPlan,
	type ManagedSkillsPlan,
} from "./managed-skills.js";
import { resolveSkillInventories } from "./root-selection.js";
import {
	chooseManagedSkills,
	editCollections,
	keepManagedSkills,
	repairCollections,
	reportNewSkills,
} from "./skill-selection.js";
import {
	applyRedoPlan,
	applyUndoPlan,
	buildRedoPlan,
	buildUndoPlan,
	formatRedoPlan,
	formatUndoPlan,
} from "./undo-redo.js";
import { bold, dim, EMOJI, printBanner } from "./ui.js";
import { isRecord } from "./values.js";

import type { DiscoveredSkillsRoot, SkillInventory } from "./types.js";

interface CliOptions {
	scope: string | null;
	dryRun: boolean;
	yes: boolean;
}

type SyncOrigin = "direct" | "update";

const UPDATE_WRAPPER_OPTIONS = new Set(["--dry-run", "--yes", "--help", "--version"]);

export async function runCli(argv: string[]): Promise<number> {
	let exitCode = 0;
	const cli = cac(CLI_NAME);
	cli.usage("[path] [options]");

	cli
		.option("--dry-run", "Preview changes without writing files")
		.option("--yes", "Apply after preview without a confirmation prompt")
		.help()
		.version(CLI_VERSION);

	cli
		.command("undo", "Undo skillzero's metadata and generated collection changes")
		.action(async (options) => {
			exitCode = await runUndo(readCliOptions(options));
		});

	cli.command("redo", "Redo the last skillzero undo").action(async (options) => {
		exitCode = await runRedo(readCliOptions(options));
	});

	cli
		.command("collections", "Configure title-and-use-condition groups for managed skills")
		.action(async (options) => {
			exitCode = await runCollections(readCliOptions(options));
		});

	cli
		.command(
			"update [...skillArgs]",
			"Run skills update and refresh skillzero metadata and collections",
		)
		.allowUnknownOptions()
		.action(async (_skillArgs, options) => {
			exitCode = await runUpdate(readCliOptions(options), readUpdateArgs(argv));
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
			return await runSync(readCliOptions(cli.options));
		}

		if (cli.args.length === 1) {
			printBanner();
			const options = withScope(readCliOptions(cli.options), cli.args[0] ?? "");
			return await runSync(options);
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

async function runSync(options: CliOptions, origin: SyncOrigin = "direct"): Promise<number> {
	return runAcrossInventories(
		options,
		(inventory) => syncInventory(options, inventory, origin),
		true,
	);
}

async function syncInventory(
	options: CliOptions,
	inventory: SkillInventory,
	origin: SyncOrigin,
): Promise<number> {
	// An update skips unconfigured roots, accepts removed skills, and applies the
	// rebuilt state without another confirmation.
	const followsUpdate = origin === "update";
	const state = inventory.state;
	if (!state) {
		if (followsUpdate) {
			// A successful update starts a new operation even when no managed state exists.
			await clearRedoState(inventory.rootPath);
			return 0;
		}
		if (inventory.skills.length === 0) {
			console.log(`${EMOJI.info} No skills found in ${inventory.rootPath}.`);
			return 0;
		}
	}

	const availableIds = new Set(inventory.skills.map((skill) => skill.id));
	const missingIds = (state?.skills ?? [])
		.map((skill) => skill.id)
		.filter((id) => !availableIds.has(id));
	const newSkillIds = state === null ? [] : reportNewSkills(inventory, state.knownIds);
	if (missingIds.length > 0 && !followsUpdate && !options.yes) {
		const shouldForget = await p.confirm({
			message: `${missingIds.join(", ")} ${missingIds.length === 1 ? "was" : "were"} removed. Forget ${missingIds.length === 1 ? "it" : "them"} from the managed set?`,
			initialValue: true,
		});
		if (p.isCancel(shouldForget)) {
			p.cancel(`${EMOJI.cancel} Operation cancelled.`);
			return 130;
		}
		if (!shouldForget) {
			p.cancel(`${EMOJI.warning}  No changes applied. Restore the missing skills before syncing.`);
			return 0;
		}
	}

	const managedIds = new Set(state?.skills.map((skill) => skill.id) ?? []);
	// First-time setup selects every skill. Later runs start from saved ownership
	// so discovery cannot silently manage a new skill.
	const initialSelectedIds = inventory.skills
		.filter((skill) => state === null || managedIds.has(skill.id))
		.map((skill) => skill.id);
	const selection =
		options.yes || (followsUpdate && newSkillIds.length === 0)
			? { status: "ok" as const, selectedIds: initialSelectedIds }
			: await chooseManagedSkills(
					inventory,
					"Select skills for skillzero to manage",
					initialSelectedIds,
					managedIds,
				);
	if (selection.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	const selectedManagedIds = new Set(selection.selectedIds);
	let collections = keepManagedSkills(inventory.collections, selectedManagedIds);
	const newlySelectedIds = selection.selectedIds.filter((id) => !managedIds.has(id));
	if (!options.yes && newlySelectedIds.length > 0) {
		const candidates = inventory.skills.filter((skill) => selectedManagedIds.has(skill.id));
		const result = await editCollections(
			candidates,
			collections,
			state === null ? "add" : "done",
		);
		if (result.status === "cancelled") {
			p.cancel(`${EMOJI.cancel} Operation cancelled.`);
			return 130;
		}
		collections = result.collections;
	}

	const assignedIds = collectionSkillIds(collections);
	const hiddenIds = selection.selectedIds.filter((id) => !assignedIds.has(id));
	const plan = await buildManagedSkillsPlan(inventory, hiddenIds, state, collections);
	return previewAndApplyPlan(
		options,
		plan,
		`${EMOJI.success} skillzero updated.`,
		followsUpdate,
	);
}

async function runCollections(options: CliOptions): Promise<number> {
	return runAcrossInventories(
		options,
		(inventory) => editInventoryCollections(options, inventory),
		true,
	);
}

async function editInventoryCollections(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	const managedIds = new Set(inventory.state?.skills.map((skill) => skill.id) ?? []);
	const managedSkills = inventory.skills.filter((skill) => managedIds.has(skill.id));
	if (managedSkills.length === 0 && inventory.collections.length === 0) {
		console.log(
			`${EMOJI.info} No managed skills or collections found in ${inventory.rootPath}.`,
		);
		return 0;
	}

	// Collection editing must include hidden managed skills; this is the explicit
	// path for making one visible now that the main picker represents ownership.
	const result = await editCollections(managedSkills, inventory.collections);
	if (result.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	// A skill without a collection becomes hidden; a skill in a collection stays visible.
	const finalVisibleIds = collectionSkillIds(result.collections);
	const finalHiddenIds = (inventory.state?.skills ?? [])
		.map((skill) => skill.id)
		.filter((id) => !finalVisibleIds.has(id));
	const plan = await buildManagedSkillsPlan(
		inventory,
		finalHiddenIds,
		inventory.state,
		result.collections,
	);
	return previewAndApplyPlan(
		options,
		plan,
		`${EMOJI.success} skillzero collections updated.`,
	);
}

async function runUpdate(options: CliOptions, args: readonly string[]): Promise<number> {
	if (options.dryRun) {
		p.note(
			"Managed skill folders already stay available to the skills CLI.",
			`${EMOJI.info} No release needed`,
		);
		return 0;
	}

	runSkillsUpdate(args);
	return runSync(options, "update");
}

function runSkillsUpdate(args: readonly string[]): void {
	p.note("Refreshing installed skills through the skills CLI.", `${EMOJI.update} Updating skills`);
	const result = spawnSync("skills", ["update", ...args], { stdio: "inherit" });
	if (result.error) {
		throw new SkillzeroError(`Could not run skills update: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new SkillzeroError(
			`skills update exited with status ${result.status ?? "unknown"}. Run skillzero when it is ready.`,
		);
	}
}

async function runUndo(options: CliOptions): Promise<number> {
	return runAcrossInventories(options, (inventory) => undoInventory(options, inventory));
}

async function undoInventory(options: CliOptions, inventory: SkillInventory): Promise<number> {
	const plan = await buildUndoPlan(inventory);
	p.note(formatUndoPlan(plan), `Preview`);
	if (options.dryRun) {
		return 0;
	}

	const confirmation = await confirmApply(options);
	if (confirmation !== "apply") {
		return reportDeclined(confirmation);
	}

	await applyUndoPlan(plan);
	p.outro(`${EMOJI.restore}  skillzero changes undone. Run skillzero redo to restore them.`);
	return 0;
}

async function runRedo(options: CliOptions): Promise<number> {
	return runAcrossInventories(options, (inventory) => redoInventory(options, inventory));
}

async function redoInventory(options: CliOptions, inventory: SkillInventory): Promise<number> {
	const plan = await buildRedoPlan(inventory);
	p.note(formatRedoPlan(plan), `Preview`);
	if (options.dryRun) {
		return 0;
	}

	const confirmation = await confirmApply(options);
	if (confirmation !== "apply") {
		return reportDeclined(confirmation);
	}

	await applyRedoPlan(plan);
	p.outro(`${EMOJI.success} skillzero changes restored.`);
	return 0;
}

async function runAcrossInventories(
	options: CliOptions,
	run: (inventory: SkillInventory) => Promise<number>,
	repairStaleCollections = false,
): Promise<number> {
	// Keep root resolution, alias reporting, stale-state repair, and early exits
	// in one lifecycle shared by every command.
	const result = await resolveSkillInventories(options.scope);
	if (result.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	if (result.inventories.length === 0) {
		console.log(`${EMOJI.info} No supported skills directories found in ${result.projectPath}.`);
		return 0;
	}

	logAliases(result.discoveredRoots);
	for (const inventory of result.inventories) {
		logRoot(inventory, result.inventories.length);
		const exitCode = repairStaleCollections
			? await runWithRepairedCollections(options, inventory, run)
			: await run(inventory);
		if (exitCode !== 0) {
			return exitCode;
		}
	}

	return 0;
}

async function runWithRepairedCollections(
	options: CliOptions,
	inventory: SkillInventory,
	run: (inventory: SkillInventory) => Promise<number>,
): Promise<number> {
	const repair = await repairCollections(inventory, options.yes);
	if (repair.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}
	if (repair.status === "declined") {
		p.cancel(`${EMOJI.warning} No changes applied.`);
		return 0;
	}

	return run(repair.inventory);
}

async function previewAndApplyPlan(
	options: CliOptions,
	plan: ManagedSkillsPlan,
	successMessage: string,
	autoApply = false,
): Promise<number> {
	p.note(formatManagedSkillsPlan(plan), `Preview`);
	const hasFileChanges = plan.operations.length > 0 || plan.collectionPlan.collectionsChanged;
	if (hasFileChanges) {
		if (options.dryRun) {
			return 0;
		}
		if (!autoApply) {
			const confirmation = await confirmApply(options);
			if (confirmation !== "apply") {
				return reportDeclined(confirmation);
			}
		}
	} else if (options.dryRun) {
		p.outro(`${EMOJI.success} No changes needed.`);
		return 0;
	}

	// State-only changes record discovery and restoration ownership without an
	// empty confirmation prompt.
	await applyManagedSkillsPlan(plan);
	await clearRedoState(plan.rootPath);
	if (!hasFileChanges) {
		p.outro(`${EMOJI.success} No changes needed.`);
		return 0;
	}

	p.outro(successMessage);
	return 0;
}

async function confirmApply(options: CliOptions): Promise<"apply" | "cancelled" | "declined"> {
	if (options.yes) {
		return "apply";
	}

	const shouldApply = await p.confirm({
		message: `${EMOJI.apply} Apply these changes?`,
		initialValue: false,
	});
	if (p.isCancel(shouldApply)) {
		return "cancelled";
	}
	return shouldApply ? "apply" : "declined";
}

function reportDeclined(result: "cancelled" | "declined"): number {
	p.cancel(`${EMOJI.warning}  No changes applied.`);
	return result === "cancelled" ? 130 : 0;
}

function readUpdateArgs(argv: readonly string[]): string[] {
	// CAC owns the wrapper flags. Read argv so unknown flags reach the skills CLI
	// in their original order; `--` makes an ambiguous flag explicit.
	const commandIndex = argv.findIndex((argument, index) => index >= 2 && argument === "update");
	if (commandIndex === -1) {
		return [];
	}

	const args: string[] = [];
	let afterSeparator = false;
	for (const argument of argv.slice(commandIndex + 1)) {
		if (afterSeparator) {
			args.push(argument);
			continue;
		}
		if (argument === "--") {
			afterSeparator = true;
			continue;
		}

		const optionName = argument.startsWith("--")
			? (argument.split("=", 1)[0] ?? argument)
			: argument;
		if (!UPDATE_WRAPPER_OPTIONS.has(optionName)) {
			args.push(argument);
		}
	}

	return args;
}

function logAliases(roots: DiscoveredSkillsRoot[]): void {
	for (const root of roots) {
		if (root.aliases.length > 1) {
			console.log(
				`${EMOJI.link} ${dim("Deduplicated linked skills roots:")} ${root.aliases.join(" → ")}`,
			);
		}
	}
}

function logRoot(inventory: SkillInventory, count: number): void {
	if (count > 1) {
		console.log(`\n${EMOJI.folder} ${bold("Skills directory")} ${dim(inventory.rootPath)}`);
	}
}

function readCliOptions(options: unknown, scope: string | null = null): CliOptions {
	return {
		scope,
		dryRun: readOption(options, "dryRun") === true,
		yes: readOption(options, "yes") === true,
	};
}

function readOption(options: unknown, key: string): unknown {
	return isRecord(options) ? options[key] : undefined;
}

function withScope(options: CliOptions, scope: string): CliOptions {
	if (options.scope !== null) {
		throw new SkillzeroError("Pass only one positional scope path.");
	}
	return { ...options, scope };
}

function printUnknownCommand(args: readonly string[]): void {
	console.error(`${EMOJI.warning} Unknown command: ${args.join(" ")}`);
	console.error(`Run ${CLI_NAME} --help for usage.`);
}
