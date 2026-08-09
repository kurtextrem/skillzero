import * as p from "@clack/prompts";
import cac from "cac";
import { spawnSync } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { applyMovePlan } from "./apply.js";
import { collectionIdFromTitle } from "./collections.js";
import {
	CLI_NAME,
	CLI_VERSION,
	GENERATED_MARKER,
	HANDOFF_STATE_FILE_NAME,
	IN_PLACE_STATE_FILE_NAME,
	KNOWN_SKILLS_STATE_FILE_NAME,
	REDO_STATE_FILE_NAME,
	SKILL_FILE_NAME,
} from "./constants.js";
import {
	discoverGlobalSkillsRoots,
	discoverProjectSkillsRootsAtPath,
	discoverSkillsRootsAtPath,
} from "./discovery.js";
import { SkillzeroError } from "./errors.js";
import { clearRedoState, readRedoState } from "./history.js";
import { applyHandoff, applySync, clearHandoffState, readHandoffState } from "./handoff.js";
import {
	applyInPlacePlan,
	buildInPlacePlan,
	formatInPlacePlan,
	readInPlaceState,
} from "./in-place.js";
import { readKnownSkillIds, writeKnownSkillIds } from "./known-skills.js";
import { buildMovePlan, formatMovePlan } from "./plan.js";
import { scanSkills } from "./scanner.js";
import { getPathKind } from "./fs-utils.js";
import { promptVisibleMultiselect } from "./multiselect.js";
import { estimateSavedTokens } from "./tokens.js";
import {
	applyRedoPlan,
	applyUndoPlan,
	buildRedoPlan,
	buildUndoPlan,
	formatRedoPlan,
	formatUndoPlan,
} from "./undo-redo.js";
import { bold, dim, EMOJI, printBanner, success, text, warning } from "./ui.js";

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

interface RootCandidate {
	root: DiscoveredSkillsRoot;
	location: "project" | "global";
	managed: boolean;
}

type InventoryResolutionResult =
	| {
			status: "ok";
			inventories: SkillInventory[];
			projectPath: string | null;
			discoveredRoots: DiscoveredSkillsRoot[];
	  }
	| { status: "cancelled" };

type PromptSelectionResult = { status: "ok"; selectedIds: string[] } | { status: "cancelled" };

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
	return (
		options.strategy === "in-place" || options.target === "claude" || options.target === "cursor"
	);
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

function rootsResult(roots: DiscoveredSkillsRoot[], projectPath: string | null): PromptRootsResult {
	return {
		status: "ok",
		paths: roots.map((root) => root.path),
		projectPath,
		discoveredRoots: roots,
	};
}

function mergeRootCandidates(
	candidates: Map<string, RootCandidate>,
	roots: DiscoveredSkillsRoot[],
	location: RootCandidate["location"],
): void {
	for (const root of roots) {
		const existing = candidates.get(root.realPath);
		if (existing) {
			existing.root.aliases = [...new Set([...existing.root.aliases, ...root.aliases])];
			if (location === "project") {
				existing.location = location;
			}
			continue;
		}

		candidates.set(root.realPath, {
			root: { ...root, aliases: [...root.aliases] },
			location,
			managed: false,
		});
	}
}

async function isSkillzeroManagedRoot(rootPath: string): Promise<boolean> {
	// State artifacts still identify a managed root while an update handoff has
	// temporarily removed the generated index file.
	const generatedIndexFile = path.join(rootPath, "skill-index", SKILL_FILE_NAME);
	if ((await getPathKind(generatedIndexFile)) === "file") {
		if ((await readFile(generatedIndexFile, "utf8")).includes(GENERATED_MARKER)) {
			return true;
		}
	}

	const stateFiles = [
		path.join(rootPath, IN_PLACE_STATE_FILE_NAME),
		path.join(rootPath, KNOWN_SKILLS_STATE_FILE_NAME),
		path.join(rootPath, REDO_STATE_FILE_NAME),
		path.join(rootPath, "skill-index", HANDOFF_STATE_FILE_NAME),
	];
	for (const stateFile of stateFiles) {
		if ((await getPathKind(stateFile)) === "file") {
			return true;
		}
	}

	return false;
}

async function rootHasSkills(rootPath: string): Promise<boolean> {
	const inventory = await scanSkills(rootPath);
	return inventory.activeSkills.length > 0 || inventory.managedSkills.length > 0;
}

function displayRootPath(candidate: RootCandidate): string {
	if (candidate.location === "global") {
		const homeRelative = path.relative(homedir(), candidate.root.path);
		if (homeRelative === "") {
			return "~";
		}
		if (
			homeRelative !== ".." &&
			!homeRelative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(homeRelative)
		) {
			return `~/${homeRelative}`;
		}
	}

	const currentRelative = path.relative(process.cwd(), candidate.root.path);
	if (currentRelative === "") {
		return ".";
	}
	if (currentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(currentRelative)) {
		return candidate.root.path;
	}
	return `./${currentRelative}`;
}

async function rootSavings(inventory: SkillInventory): Promise<number> {
	if (inventory.managedSkills.length > 0) {
		return estimateSavedTokens(inventory.managedSkills);
	}

	const activeById = new Map(inventory.activeSkills.map((skill) => [skill.id, skill]));
	const inPlaceState = await readInPlaceState(inventory);
	if (inPlaceState !== null) {
		return estimateSavedTokens(
			inPlaceState.skills.flatMap((state) => {
				const skill = activeById.get(state.id);
				return skill ? [skill] : [];
			}),
		);
	}

	const handoffState = await readHandoffState(inventory);
	if (handoffState !== null) {
		return estimateSavedTokens(
			handoffState.managedIds.flatMap((id) => {
				const skill = activeById.get(id);
				return skill ? [skill] : [];
			}),
		);
	}

	const redoState = await readRedoState(inventory.rootPath);
	if (redoState !== null) {
		return estimateSavedTokens(
			redoState.managedIds.flatMap((id) => {
				const skill = activeById.get(id);
				return skill ? [skill] : [];
			}),
		);
	}

	return 0;
}

async function rootCandidateSummary(candidates: RootCandidate[]): Promise<string> {
	const managed = candidates.filter((candidate) => candidate.managed);
	const available = candidates.filter((candidate) => !candidate.managed);
	const lines = [`${EMOJI.managed} Managed by skillzero`];

	if (managed.length === 0) {
		lines.push(`  ${dim("None found")}`);
	} else {
		const managedPaths = await Promise.all(
			managed.map(async (candidate) => {
				const inventory = await scanSkills(candidate.root.realPath);
				const savings = await rootSavings(inventory);
				return `  ${displayRootPath(candidate)} ${dim(`(saves: ${savings} tokens)`)}`;
			}),
		);
		lines.push(...managedPaths);
	}

	lines.push("", `${EMOJI.info} Available skill paths`);
	if (available.length === 0) {
		lines.push(`  ${dim("None found")}`);
	} else {
		lines.push(...available.map((candidate) => `  ${displayRootPath(candidate)}`));
	}

	return lines.join("\n");
}

async function discoverNoPathCandidates(
	options: CliOptions,
): Promise<{ candidates: RootCandidate[]; projectPath: string | null }> {
	// Bare invocation needs a complete candidate list before scanning or writing
	// so users can review managed roots and opt into other existing roots.
	const candidates = new Map<string, RootCandidate>();
	let projectPath: string | null = null;

	if (await isLikelySkillsRoot(process.cwd())) {
		const currentPath = path.resolve(process.cwd());
		const currentRealPath = await realpath(currentPath);
		mergeRootCandidates(
			candidates,
			[
				{
					path: currentPath,
					realPath: currentRealPath,
					aliases: [currentPath],
				},
			],
			"project",
		);
	}

	mergeRootCandidates(
		candidates,
		await discoverSkillsRootsAtPath(process.cwd(), options.target),
		"project",
	);

	const projectRoots = await discoverProjectSkillsRootsAtPath(process.cwd(), options.target);
	if (projectRoots !== null) {
		projectPath = projectRoots.projectPath;
		mergeRootCandidates(candidates, projectRoots.roots, "project");
	}

	mergeRootCandidates(candidates, await discoverGlobalSkillsRoots(options.target), "global");

	const sortedCandidates = [...candidates.values()];
	for (const candidate of sortedCandidates) {
		candidate.managed = await isSkillzeroManagedRoot(candidate.root.realPath);
	}
	const nonEmptyCandidates: RootCandidate[] = [];
	for (const candidate of sortedCandidates) {
		// A conventional directory is only useful in the selector if it contains
		// at least one active or nested managed skill.
		if (await rootHasSkills(candidate.root.realPath)) {
			nonEmptyCandidates.push(candidate);
		}
	}
	nonEmptyCandidates.sort((left, right) => {
		if (left.managed !== right.managed) {
			return left.managed ? -1 : 1;
		}
		if (left.location !== right.location) {
			return left.location === "project" ? -1 : 1;
		}
		return displayRootPath(left).localeCompare(displayRootPath(right));
	});

	return { candidates: nonEmptyCandidates, projectPath };
}

async function promptForRootCandidates(
	candidates: RootCandidate[],
	projectPath: string | null,
): Promise<PromptRootsResult> {
	if (!process.stdin.isTTY) {
		// CI and update wrappers cannot choose interactively; keep project roots
		// isolated from global roots unless no project roots were discovered.
		const projectCandidates = candidates.filter((candidate) => candidate.location === "project");
		const selectedCandidates = projectCandidates.length > 0 ? projectCandidates : candidates;
		return rootsResult(
			selectedCandidates.map((candidate) => candidate.root),
			projectPath,
		);
	}

	if (candidates.length === 0) {
		p.note(
			`${EMOJI.info} No conventional skills paths were found.`,
			`${EMOJI.folder} Skills paths`,
		);
		let selectedPath: string | symbol;
		while (true) {
			selectedPath = await p.path({
				message: "Select a non-empty skills directory to manage",
				directory: true,
			});

			if (p.isCancel(selectedPath)) {
				return { status: "cancelled" };
			}

			try {
				if (await rootHasSkills(selectedPath)) {
					break;
				}
				p.note("The directory must contain at least one skill.", `${EMOJI.info} Skills paths`);
			} catch (error) {
				p.note(
					error instanceof Error ? error.message : "Select a readable skills directory.",
					`${EMOJI.info} Skills paths`,
				);
			}
		}

		return rootsResult(
			[
				{
					path: selectedPath,
					realPath: path.resolve(selectedPath),
					aliases: [selectedPath],
				},
			],
			null,
		);
	}

	p.note(await rootCandidateSummary(candidates), `${EMOJI.folder} Skills paths`);
	const selectedPaths = await p.multiselect<string>({
		message: `${EMOJI.folder} Choose skills paths to manage`,
		options: candidates.map((candidate) => ({
			value: candidate.root.path,
			label: displayRootPath(candidate),
			hint: candidate.managed ? "managed by skillzero" : "available to manage",
		})),
		initialValues: candidates
			.filter((candidate) => candidate.managed)
			.map((candidate) => candidate.root.path),
		required: false,
	});

	if (p.isCancel(selectedPaths)) {
		return { status: "cancelled" };
	}

	const selected = new Set(selectedPaths);
	return rootsResult(
		candidates
			.filter((candidate) => selected.has(candidate.root.path))
			.map((candidate) => candidate.root),
		projectPath,
	);
}

async function resolveExplicitScope(
	scope: string,
	target: InvocationTarget | null,
): Promise<PromptRootsResult> {
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
		return rootsResult(
			[
				{
					path: scope,
					realPath: await realpath(resolvedScope),
					aliases: [scope],
				},
			],
			null,
		);
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

	if (!process.stdin.isTTY && (await isLikelySkillsRoot(process.cwd()))) {
		// Non-interactive commands need a stable current scope. In particular, an
		// empty root with an existing skill-index is still a valid target for
		// read-only commands and must not fall through to the user's global roots.
		const currentPath = path.resolve(process.cwd());
		return rootsResult(
			[
				{
					path: currentPath,
					realPath: await realpath(currentPath),
					aliases: [currentPath],
				},
			],
			null,
		);
	}

	const { candidates, projectPath } = await discoverNoPathCandidates(options);
	if (candidates.length > 0 || process.stdin.isTTY) {
		return promptForRootCandidates(candidates, projectPath);
	}

	if (!process.stdin.isTTY) {
		throw new SkillzeroError(
			"No supported skills paths found. Pass a positional skills root or project path when running non-interactively.",
		);
	}

	return { status: "cancelled" };
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
					`The same SKILL.md file is linked in multiple roots: ${previous.skillFile} and ${skill.skillFile}. Use only one skills root, or invoke skillzero with the whole skills root so skillzero can handle duplicates.`,
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

function inventorySkillIds(inventory: SkillInventory): string[] {
	return allSkills(inventory).map((skill) => skill.id);
}

function hasPlanChanges(plan: {
	operations: readonly unknown[];
	indexChanged: boolean;
	collectionPlan: { collectionsChanged: boolean };
	stateChanged?: boolean;
}): boolean {
	return (
		plan.operations.length > 0 ||
		plan.indexChanged ||
		plan.collectionPlan.collectionsChanged ||
		plan.stateChanged === true
	);
}

function reportNoChanges(): void {
	p.outro(`${EMOJI.success} No changes needed.`);
}

function reportNewSkills(inventory: SkillInventory, knownIds: Iterable<string>): string[] {
	const knownIdSet = new Set(knownIds);
	const newSkills = inventory.activeSkills.filter((skill) => !knownIdSet.has(skill.id));
	if (newSkills.length === 0) {
		return [];
	}

	const lines = ["These skills were found since the last sync:"];
	for (const skill of newSkills) {
		lines.push(`- ${skill.id} — ${compactSkillDescription(skill.id, skill.description)}`);
	}
	p.note(lines.join("\n"), `${EMOJI.new} New skills found`);
	return newSkills.map((skill) => skill.id);
}

function shouldPromptForCollections(
	options: CliOptions,
	behavior: SyncBehavior,
	inventory: SkillInventory,
	newSkillIds: readonly string[],
	selectedIds: readonly string[],
): boolean {
	if (options.yes) {
		return false;
	}

	// New managed skills need an assignment immediately; an existing index with
	// no collections also needs one interactive chance to create its first route.
	return (
		newSkillIds.some((id) => selectedIds.includes(id)) ||
		(!behavior.autoApply && inventory.collections.length === 0 && selectedIds.length > 0)
	);
}

function compactSkillDescription(id: string, description: string): string {
	const firstLine =
		description
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0)
			?.replace(/^[-*]\s+/, "") ?? "No description provided.";
	const normalized = firstLine.replace(/\s+/g, " ");
	const maxLength = Math.max(20, (process.stdout.columns ?? 80) - id.length - 11);
	if (normalized.length <= maxLength) {
		return normalized;
	}

	const suffix = "...";
	return `${normalized.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
}

function promptForManagedSkills(
	inventory: SkillInventory,
	message: string,
	initialIds = inventory.managedSkills.map((skill) => skill.id),
	selectedHint = "managed",
): Promise<PromptSelectionResult> {
	const initiallyManaged = new Set(initialIds);
	const options = allSkills(inventory).map((skill) => {
		const hint = selectionHintForSkill(
			skill,
			initiallyManaged,
			inventory.collections,
			selectedHint,
		);
		return {
			value: skill.id,
			label: skill.id,
			...(hint === undefined ? {} : { hint }),
			description: skill.description,
			source: skill.skillFile,
		};
	});

	return promptVisibleMultiselect({
		message,
		options,
		initialValues: initialIds,
		required: false,
	});
}

function selectionHintForSkill(
	skill: SkillRecord,
	initiallyManaged: ReadonlySet<string>,
	collections: SkillCollection[],
	selectedHint: string,
): string | undefined {
	if (!initiallyManaged.has(skill.id)) {
		return undefined;
	}

	const collectionTitles = collections
		.filter((collection) => collection.skillIds.includes(skill.id))
		.map((collection) => collection.title);
	return collectionTitles.length > 0
		? `${EMOJI.collection} ${collectionTitles.join(", ")}`
		: selectedHint;
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
			validate: (value) =>
				(value ?? "").trim().length > 0 ? undefined : "Enter a collection title.",
		});
		if (p.isCancel(title)) {
			return { status: "cancelled" };
		}

		const description = await p.text({
			message: "Collection description",
			initialValue: existing?.description ?? "",
			validate: (value) =>
				(value ?? "").trim().length > 0 ? undefined : "Enter a collection description.",
		});
		if (p.isCancel(description)) {
			return { status: "cancelled" };
		}

		const id = collectionIdFromTitle(title);
		const duplicate = collections.some(
			(collection) => collection.id === id && collection.id !== existing?.id,
		);
		if (duplicate) {
			p.note(
				`The title produces the existing collection id '${id}'. Choose a different title.`,
				`${EMOJI.warning} Collection id conflict`,
			);
			continue;
		}

		const availableIds = new Set(skills.map((skill) => skill.id));
		const initialValues = (existing?.skillIds ?? []).filter((skillId) => availableIds.has(skillId));
		const selectedResult = await promptVisibleMultiselect({
			message: `Skills in ${title}`,
			options: skills.map((skill) => ({
				value: skill.id,
				label: skill.id,
				description: skill.description,
				source: skill.skillFile,
			})),
			initialValues,
			required: false,
		});
		if (selectedResult.status === "cancelled") {
			return selectedResult;
		}

		return {
			status: "ok",
			collection: {
				id,
				title: title.trim(),
				description: description.trim(),
				skillIds: selectedResult.selectedIds,
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
			message: `${EMOJI.collection} Configure skill collections`,
			options: [
				{
					value: "add",
					label: "Add collection",
					hint: "Create a title, description, and skill group.",
				},
				...(collections.length > 0
					? [
							{
								value: "edit" as const,
								label: "Edit collection",
								hint: "Change its routing text or assigned skills.",
							},
							{
								value: "remove" as const,
								label: `${EMOJI.cancel} Remove collection`,
								hint: "Delete its generated routing skill.",
							},
						]
					: []),
				{
					value: "done",
					label: `${EMOJI.success} Done`,
					hint: "Use the current collection configuration.",
				},
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
			message:
				action === "edit"
					? "Choose a collection to edit"
					: `${EMOJI.cancel} Choose a collection to remove`,
			options: collections.map((collection) => ({
				value: collection.id,
				label: collection.title,
				hint: collection.description,
			})),
		});
		if (p.isCancel(selectedCollectionId)) {
			return { status: "cancelled" };
		}

		const selectedCollection = collections.find(
			(collection) => collection.id === selectedCollectionId,
		);
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
			message: `${EMOJI.warning} Remove collection ${selectedCollection.title}?`,
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
	console.log(`${EMOJI.folder} ${bold("Skills directory")} ${dim(inventory.rootPath)}`);

	const sections = [
		{
			heading: "Active skills",
			skills: inventory.activeSkills,
			marker: success(EMOJI.active),
		},
		{
			heading: "Managed skills",
			skills: inventory.managedSkills,
			marker: warning(EMOJI.managed),
		},
	];

	for (const section of sections) {
		console.log();
		console.log(
			`${section.heading === "Active skills" ? EMOJI.active : EMOJI.managed} ${bold(section.heading)} ${dim(`(${section.skills.length})`)}`,
		);
		for (const skill of section.skills) {
			const description =
				skill.description.length > 0 ? ` ${dim("—")} ${dim(skill.description)}` : "";
			console.log(`   ${section.marker} ${bold(text(skill.id))}${description}`);
		}
	}

	console.log();
	console.log(
		`${EMOJI.collection} ${bold("Collections")} ${dim(`(${inventory.collections.length})`)}`,
	);
	for (const collection of inventory.collections) {
		console.log(
			`   ${EMOJI.collection} ${bold(text(collection.title))}${dim(" — ")}${dim(collection.description)}`,
		);
	}
}

function logDiscoveredAliases(discoveredRoots: DiscoveredSkillsRoot[]): void {
	for (const root of discoveredRoots) {
		if (root.aliases.length > 1) {
			console.log(
				`${EMOJI.link} ${dim("Deduplicated linked skills roots:")} ${root.aliases.join(" → ")}`,
			);
		}
	}
}

function logOperationRoot(inventory: SkillInventory, count: number): void {
	if (count > 1) {
		console.log(`\n${EMOJI.folder} ${bold("Skills directory")} ${dim(inventory.rootPath)}`);
	}
}

async function runAcrossInventories(
	options: CliOptions,
	runForInventory: (inventory: SkillInventory) => Promise<number>,
): Promise<number> {
	// Every mutating command must resolve and validate roots in exactly the same
	// way. Keep that lifecycle here so a new command cannot accidentally skip
	// alias reporting, duplicate-file protection, or early exit propagation.
	const inventoryResult = await resolveSkillInventories(options, true);
	if (inventoryResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	if (inventoryResult.inventories.length === 0) {
		console.log(
			`${EMOJI.info} No supported skills directories found in ${inventoryResult.projectPath}.`,
		);
		return 0;
	}

	logDiscoveredAliases(inventoryResult.discoveredRoots);
	for (const inventory of inventoryResult.inventories) {
		logOperationRoot(inventory, inventoryResult.inventories.length);
		const exitCode = await runForInventory(inventory);
		if (exitCode !== 0) {
			return exitCode;
		}
	}

	return 0;
}

export async function runScan(options: CliOptions): Promise<number> {
	const inventoryResult = await resolveSkillInventories(options, false);
	if (inventoryResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	if (inventoryResult.inventories.length === 0) {
		console.log(
			`${EMOJI.info} No supported skills directories found in ${inventoryResult.projectPath}.`,
		);
		return 0;
	}

	logDiscoveredAliases(inventoryResult.discoveredRoots);
	for (const inventory of inventoryResult.inventories) {
		logInventory(inventory);
	}
	return 0;
}

async function runConfigureForInventory(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	if (inventory.activeSkills.length === 0 && inventory.managedSkills.length === 0) {
		console.log(`${EMOJI.info} No skills found in ${inventory.rootPath}.`);
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
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	let collections = inventory.collections;
	const initialPlan = inPlace
		? await buildInPlacePlan(inventory, selectionResult.selectedIds, inPlaceState)
		: await buildMovePlan(inventory, selectionResult.selectedIds);
	if (initialPlan.finalManagedSkills.length > 0) {
		// Initial setup must offer collection routing before the first index is
		// written; otherwise users have to discover the separate subcommand later.
		const collectionResult = await promptForCollections(
			initialPlan.finalManagedSkills,
			inventory.collections,
		);
		if (collectionResult.status === "cancelled") {
			p.cancel(`${EMOJI.cancel} Operation cancelled.`);
			return 130;
		}
		collections = collectionResult.collections;
	}

	if (inPlace) {
		const plan = await buildInPlacePlan(
			inventory,
			selectionResult.selectedIds,
			inPlaceState,
			collections,
		);
		p.note(formatInPlacePlan(plan), `Preview`);
		if (!hasPlanChanges(plan)) {
			reportNoChanges();
			return 0;
		}
		if (options.dryRun) {
			return 0;
		}

		const confirmation = await confirmApply(options);
		if (confirmation !== "apply") {
			return reportDeclined(confirmation);
		}

		await applyInPlacePlan(plan, inventory);
		await writeKnownSkillIds(inventory.rootPath, inventorySkillIds(inventory));
		await clearHandoffState(inventory);
		await clearRedoState(inventory.rootPath);
		p.outro(`${EMOJI.success} skillzero updated.`);
		return 0;
	}

	const plan = await buildMovePlan(inventory, selectionResult.selectedIds, collections);
	p.note(formatMovePlan(plan), `Preview`);
	if (!hasPlanChanges(plan)) {
		reportNoChanges();
		return 0;
	}
	if (options.dryRun) {
		return 0;
	}

	const confirmation = await confirmApply(options);
	if (confirmation !== "apply") {
		return reportDeclined(confirmation);
	}

	await applyMovePlan(plan);
	await writeKnownSkillIds(inventory.rootPath, inventorySkillIds(inventory));
	await clearRedoState(inventory.rootPath);
	p.outro(`${EMOJI.success} skillzero updated.`);
	return 0;
}

export async function runConfigure(options: CliOptions): Promise<number> {
	return runAcrossInventories(options, (inventory) =>
		runConfigureForInventory(options, inventory),
	);
}

async function runCollectionsForInventory(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	const inPlace = usesInPlaceStrategy(options);
	if (inPlace) {
		const state = await readInPlaceState(inventory);
		const availableIds = new Set(inventory.activeSkills.map((skill) => skill.id));
		const selectedIds = (state?.skills.map((skill) => skill.id) ?? []).filter((id) =>
			availableIds.has(id),
		);
		const initialPlan = await buildInPlacePlan(inventory, selectedIds, state);
		if (initialPlan.finalManagedSkills.length === 0 && inventory.collections.length === 0) {
			console.log(
				`${EMOJI.info} No non-top-level skills or collections found in ${inventory.rootPath}.`,
			);
			return 0;
		}

		const collectionResult = await promptForCollections(
			initialPlan.finalManagedSkills,
			inventory.collections,
		);
		if (collectionResult.status === "cancelled") {
			p.cancel(`${EMOJI.cancel} Operation cancelled.`);
			return 130;
		}

		const plan = await buildInPlacePlan(
			inventory,
			selectedIds,
			state,
			collectionResult.collections,
		);
		p.note(formatInPlacePlan(plan), `Preview`);
		if (!hasPlanChanges(plan)) {
			reportNoChanges();
			return 0;
		}
		if (options.dryRun) {
			return 0;
		}

		const confirmation = await confirmApply(options);
		if (confirmation !== "apply") {
			return reportDeclined(confirmation);
		}

		await applyInPlacePlan(plan, inventory);
		await writeKnownSkillIds(inventory.rootPath, inventorySkillIds(inventory));
		await clearRedoState(inventory.rootPath);
		p.outro(`${EMOJI.success} skillzero collections updated.`);
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
		console.log(
			`${EMOJI.info} No non-top-level skills or collections found in ${inventory.rootPath}.`,
		);
		return 0;
	}

	const collectionResult = await promptForCollections(
		initialPlan.finalManagedSkills,
		inventory.collections,
	);
	if (collectionResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	const plan = await buildMovePlan(inventory, selectedIds, collectionResult.collections);
	p.note(formatMovePlan(plan), `Preview`);
	if (!hasPlanChanges(plan)) {
		reportNoChanges();
		return 0;
	}
	if (options.dryRun) {
		return 0;
	}

	const confirmation = await confirmApply(options);
	if (confirmation !== "apply") {
		return reportDeclined(confirmation);
	}

	await applyMovePlan(plan);
	await writeKnownSkillIds(inventory.rootPath, inventorySkillIds(inventory));
	await clearRedoState(inventory.rootPath);
	p.outro(`${EMOJI.success} skillzero collections updated.`);
	return 0;
}

export async function runCollections(options: CliOptions): Promise<number> {
	return runAcrossInventories(options, (inventory) =>
		runCollectionsForInventory(options, inventory),
	);
}

function formatHandoffPlan(plan: Awaited<ReturnType<typeof buildMovePlan>>): string {
	const lines = [`${EMOJI.release} Temporarily release managed skills:`];
	const restored = plan.operations.filter((operation) => operation.kind === "restore-to-root");

	if (restored.length === 0) {
		lines.push(`- ${EMOJI.info}  No managed skill folders need to move.`);
	}
	for (const operation of restored) {
		lines.push(`- ${EMOJI.restore}  Restore to root: ${operation.id}`);
	}
	lines.push(`- ${EMOJI.release}  Remove the generated skill-index router until you run sync.`);
	return lines.join("\n");
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

async function runManageForInventory(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	if (usesInPlaceStrategy(options)) {
		if (inventory.managedSkills.length > 0) {
			throw new SkillzeroError(
				"This skills directory has moved skills. Run skillzero update with --codex or --copilot first.",
			);
		}

		p.note(
			"Selected skills already stay in their ordinary folders, so the skills CLI can manage them without a temporary release.",
			`${EMOJI.info} No release needed`,
		);
		if (!options.dryRun) {
			p.outro(
				`${EMOJI.success} Skills are ready for the skills CLI. Run skillzero afterwards to restore manual-only metadata.`,
			);
		}
		return 0;
	}

	if (await readInPlaceState(inventory)) {
		throw new SkillzeroError(
			"This skills directory currently uses in-place mode. Deselect its manual-only skills with --claude or --cursor before managing it with --codex or --copilot.",
		);
	}

	if (await readHandoffState(inventory)) {
		throw new SkillzeroError(
			"Skills are already released. Run your skills command, then run skillzero to sync.",
		);
	}

	const plan = await buildMovePlan(inventory, []);
	p.note(formatHandoffPlan(plan), `Preview`);
	if (options.dryRun) {
		return 0;
	}

	const confirmation = await confirmApply(options);
	if (confirmation !== "apply") {
		return reportDeclined(confirmation);
	}

	await applyHandoff(plan, inventory);
	p.outro(
		`${EMOJI.release} Skills released. Run your skills command, then run skillzero to rebuild the index.`,
	);
	return 0;
}

export async function runManage(options: CliOptions): Promise<number> {
	return runAcrossInventories(options, (inventory) => runManageForInventory(options, inventory));
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

		const optionName = argument.startsWith("--")
			? (argument.split("=", 1)[0] ?? argument)
			: argument;
		if (UPDATE_WRAPPER_BOOLEAN_OPTIONS.has(optionName)) {
			continue;
		}

		forwardedArgs.push(argument);
	}

	return forwardedArgs;
}

function runSkillsUpdate(forwardedArgs: readonly string[] = []): void {
	p.note("Refreshing installed skills through the skills CLI.", `${EMOJI.update} Updating skills`);
	const result = spawnSync("skills", ["update", ...forwardedArgs], {
		stdio: "inherit",
	});
	if (result.error) {
		throw new SkillzeroError(`Could not run skills update: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new SkillzeroError(
			`skills update exited with status ${result.status ?? "unknown"}. Run skillzero when it is ready.`,
		);
	}
}

export async function runUpdate(
	options: CliOptions,
	forwardedArgs: readonly string[] = [],
): Promise<number> {
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
		throw new SkillzeroError(
			"No in-place skills are waiting to sync. Run skillzero <skills-dir> --claude or --cursor first.",
		);
	}

	const availableIds = new Set(inventory.activeSkills.map((skill) => skill.id));
	const missingIds = state.skills.map((skill) => skill.id).filter((id) => !availableIds.has(id));
	const knownSkillIds =
		(await readKnownSkillIds(inventory.rootPath)) ?? state.skills.map((skill) => skill.id);
	const newSkillIds = reportNewSkills(inventory, knownSkillIds);
	if (missingIds.length > 0 && !behavior.ignoreMissingSkills && !options.yes) {
		const shouldForget = await p.confirm({
			message: `${missingIds.join(", ")} ${missingIds.length === 1 ? "was" : "were"} removed. Forget ${missingIds.length === 1 ? "it" : "them"} from the manual-only set?`,
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

	const retainedIds = state.skills.map((skill) => skill.id).filter((id) => availableIds.has(id));
	const selectionResult =
		options.yes || (behavior.autoApply && newSkillIds.length === 0)
			? { status: "ok" as const, selectedIds: retainedIds }
			: await promptForManagedSkills(
					inventory,
					"Select skills to keep manual-only through skill-index (new skills are visible to the agent until selected)",
					retainedIds,
					"manual-only",
				);
	if (selectionResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	let collections = inventory.collections;
	if (
		shouldPromptForCollections(
			options,
			behavior,
			inventory,
			newSkillIds,
			selectionResult.selectedIds,
		)
	) {
		const initialPlan = await buildInPlacePlan(inventory, selectionResult.selectedIds, state);
		const collectionResult = await promptForCollections(
			initialPlan.finalManagedSkills,
			inventory.collections,
		);
		if (collectionResult.status === "cancelled") {
			p.cancel(`${EMOJI.cancel} Operation cancelled.`);
			return 130;
		}
		collections = collectionResult.collections;
	}

	const plan = await buildInPlacePlan(inventory, selectionResult.selectedIds, state, collections);
	p.note(formatInPlacePlan(plan), `Preview`);
	if (!hasPlanChanges(plan)) {
		reportNoChanges();
		return 0;
	}
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
	await writeKnownSkillIds(inventory.rootPath, inventorySkillIds(inventory));
	await clearRedoState(inventory.rootPath);
	p.outro(`${EMOJI.success} skillzero index updated.`);
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
	const knownSkillIds = (await readKnownSkillIds(inventory.rootPath)) ?? managedIds;
	const newSkillIds = reportNewSkills(inventory, knownSkillIds);
	if (missingIds.length > 0 && !behavior.ignoreMissingSkills && !options.yes) {
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

	const retainedIds = managedIds.filter((id) => availableIds.has(id));
	const selectionResult =
		options.yes || (behavior.autoApply && newSkillIds.length === 0)
			? { status: "ok" as const, selectedIds: retainedIds }
			: await promptForManagedSkills(
					inventory,
					"Select skills to move into skill-index (new skills are visible to the agent until selected)",
					retainedIds,
				);
	if (selectionResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	let collections = inventory.collections;
	if (
		shouldPromptForCollections(
			options,
			behavior,
			inventory,
			newSkillIds,
			selectionResult.selectedIds,
		)
	) {
		const initialPlan = await buildMovePlan(inventory, selectionResult.selectedIds);
		const collectionResult = await promptForCollections(
			initialPlan.finalManagedSkills,
			inventory.collections,
		);
		if (collectionResult.status === "cancelled") {
			p.cancel(`${EMOJI.cancel} Operation cancelled.`);
			return 130;
		}
		collections = collectionResult.collections;
	}

	const plan = await buildMovePlan(inventory, selectionResult.selectedIds, collections);
	p.note(formatMovePlan(plan), `Preview`);
	if (!hasPlanChanges(plan)) {
		reportNoChanges();
		return 0;
	}
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
	await writeKnownSkillIds(inventory.rootPath, inventorySkillIds(inventory));
	await clearRedoState(inventory.rootPath);
	p.outro(`${EMOJI.success} skillzero index updated.`);
	return 0;
}

export async function runSync(
	options: CliOptions,
	behavior: SyncBehavior = DEFAULT_SYNC_BEHAVIOR,
): Promise<number> {
	return runAcrossInventories(options, (inventory) =>
		runSyncForInventory(options, inventory, behavior),
	);
}

async function runUndoForInventory(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	const plan = await buildUndoPlan(inventory);
	p.note(formatUndoPlan(plan), `Preview`);
	if (options.dryRun) {
		return 0;
	}

	const confirmation = await confirmApply(options);
	if (confirmation !== "apply") {
		return reportDeclined(confirmation);
	}

	await applyUndoPlan(plan, inventory);
	p.outro(`${EMOJI.restore} skillzero changes undone. Run skillzero redo to restore them.`);
	return 0;
}

export async function runUndo(options: CliOptions): Promise<number> {
	return runAcrossInventories(options, (inventory) => runUndoForInventory(options, inventory));
}

async function runRedoForInventory(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	const plan = await buildRedoPlan(inventory);
	p.note(formatRedoPlan(plan), `Preview`);
	if (options.dryRun) {
		return 0;
	}

	const confirmation = await confirmApply(options);
	if (confirmation !== "apply") {
		return reportDeclined(confirmation);
	}

	await applyRedoPlan(plan, inventory);
	await writeKnownSkillIds(inventory.rootPath, inventorySkillIds(inventory));
	p.outro(`${EMOJI.success} skillzero changes restored.`);
	return 0;
}

export async function runRedo(options: CliOptions): Promise<number> {
	return runAcrossInventories(options, (inventory) => runRedoForInventory(options, inventory));
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
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
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
	console.error(`${EMOJI.warning} Unknown command: ${args.join(" ")}`);
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

	cli.command("undo", "Undo skillzero's generated layout changes").action(async (options) => {
		exitCode = await runUndo(readCliOptions(options));
	});

	cli.command("redo", "Redo the last skillzero undo").action(async (options) => {
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
			const options = readPositionalScope(readCliOptions(cli.options), cli.args[0] ?? "");
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
