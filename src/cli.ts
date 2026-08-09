import * as p from "@clack/prompts";
import cac from "cac";
import { spawnSync } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
	collectionDescriptionInput,
	collectionIdFromTitle,
	formatCollectionDescription,
} from "./collections.js";
import {
	CLI_NAME,
	CLI_VERSION,
	GENERATED_MARKER,
	REDO_STATE_FILE_NAME,
	SKILL_FILE_NAME,
	STATE_FILE_NAME,
} from "./constants.js";
import {
	discoverGlobalSkillsRoots,
	discoverProjectSkillsRootsAtPath,
	discoverSkillsRootsAtPath,
} from "./discovery.js";
import { SkillzeroError } from "./errors.js";
import { clearRedoState, readRedoState } from "./history.js";
import {
	applyManagedSkillsPlan,
	buildManagedSkillsPlan,
	formatManagedSkillsPlan,
	readManagedSkillsState,
	selectionFromManagedSkillsState,
	type ManagedSkillSelection,
	type ManagedSkillsPlan,
} from "./managed-skills.js";
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
import { bold, dim, EMOJI, printBanner } from "./ui.js";

import type {
	DiscoveredSkillsRoot,
	ManagedSkillMode,
	SkillCollection,
	SkillInventory,
	SkillRecord,
} from "./types.js";

interface CliOptions {
	scope: string | null;
	dryRun: boolean;
	yes: boolean;
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
	skipUnconfigured: boolean;
	autoApply: boolean;
}

const DEFAULT_SYNC_BEHAVIOR: SyncBehavior = {
	ignoreMissingSkills: false,
	skipUnconfigured: false,
	autoApply: false,
};

const UPDATE_WRAPPER_BOOLEAN_OPTIONS = new Set(["--dry-run", "--yes", "--help", "--version"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readOption(options: unknown, key: string): unknown {
	if (!isRecord(options)) {
		return undefined;
	}

	return options[key];
}

function readCliOptions(options: unknown, scope: string | null = null): CliOptions {
	return {
		scope,
		dryRun: readOption(options, "dryRun") === true,
		yes: readOption(options, "yes") === true,
	};
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
	// State artifacts identify a managed root even if its generated index was
	// removed manually or by an interrupted undo.
	const generatedIndexFile = path.join(rootPath, "skill-index", SKILL_FILE_NAME);
	if ((await getPathKind(generatedIndexFile)) === "file") {
		if ((await readFile(generatedIndexFile, "utf8")).includes(GENERATED_MARKER)) {
			return true;
		}
	}

	const stateFiles = [
		path.join(rootPath, STATE_FILE_NAME),
		path.join(rootPath, REDO_STATE_FILE_NAME),
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
	return inventory.skills.length > 0;
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
	const skillsById = new Map(inventory.skills.map((skill) => [skill.id, skill]));
	const state = await readManagedSkillsState(inventory);
	if (state !== null) {
		return estimateSavedTokens(
			state.skills.flatMap((managedSkill) => {
				const skill = skillsById.get(managedSkill.id);
				return skill ? [skill] : [];
			}),
		);
	}

	const redoState = await readRedoState(inventory.rootPath);
	if (redoState !== null) {
		return estimateSavedTokens(
			[...redoState.indexIds, ...redoState.hideIds].flatMap((id) => {
				const skill = skillsById.get(id);
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

async function discoverNoPathCandidates(): Promise<{
	candidates: RootCandidate[];
	projectPath: string | null;
}> {
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

	mergeRootCandidates(candidates, await discoverSkillsRootsAtPath(process.cwd()), "project");

	const projectRoots = await discoverProjectSkillsRootsAtPath(process.cwd());
	if (projectRoots !== null) {
		projectPath = projectRoots.projectPath;
		mergeRootCandidates(candidates, projectRoots.roots, "project");
	}

	mergeRootCandidates(candidates, await discoverGlobalSkillsRoots(), "global");

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

async function resolveExplicitScope(scope: string): Promise<PromptRootsResult> {
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

	const directRoots = await discoverSkillsRootsAtPath(scope);
	if (directRoots.length > 0) {
		return rootsResult(directRoots, null);
	}

	const projectRoots = await discoverProjectSkillsRootsAtPath(scope);
	if (projectRoots !== null) {
		return rootsResult(projectRoots.roots, projectRoots.projectPath);
	}

	return rootsResult([], resolvedScope);
}

async function resolveSkillsRoots(options: CliOptions): Promise<PromptRootsResult> {
	if (options.scope !== null) {
		return resolveExplicitScope(options.scope);
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

	const { candidates, projectPath } = await discoverNoPathCandidates();
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

async function resolveSkillInventories(options: CliOptions): Promise<InventoryResolutionResult> {
	const rootsResult = await resolveSkillsRoots(options);
	if (rootsResult.status === "cancelled") {
		return rootsResult;
	}

	const inventories = await Promise.all(rootsResult.paths.map((rootPath) => scanSkills(rootPath)));
	await assertDistinctPhysicalSkills(inventories);

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
	return [...inventory.skills].sort((left, right) => left.id.localeCompare(right.id));
}

function hasVisiblePlanChanges(plan: ManagedSkillsPlan): boolean {
	return plan.operations.length > 0 || plan.indexChanged || plan.collectionPlan.collectionsChanged;
}

async function previewAndApplyManagedPlan(
	options: CliOptions,
	plan: ManagedSkillsPlan,
	successMessage: string,
	autoApply = false,
): Promise<number> {
	p.note(formatManagedSkillsPlan(plan), `Preview`);
	const hasVisibleChanges = hasVisiblePlanChanges(plan);
	if (hasVisibleChanges) {
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

	// State-only changes remember discovery and restoration ownership without
	// asking users to approve a preview containing no managed file edits.
	await applyManagedSkillsPlan(plan);
	await clearRedoState(path.dirname(plan.stateFile));
	if (!hasVisibleChanges) {
		p.outro(`${EMOJI.success} No changes needed.`);
		return 0;
	}

	p.outro(successMessage);
	return 0;
}

function reportNewSkills(inventory: SkillInventory, knownIds: Iterable<string>): string[] {
	const knownIdSet = new Set(knownIds);
	const newSkills = inventory.skills.filter((skill) => !knownIdSet.has(skill.id));
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

	// New indexed skills need an assignment immediately; an existing index with
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

function skillPickerMetadataRank(skill: SkillRecord): number {
	if (skill.disableModelInvocation && skill.openAiImplicitInvocationDisabled) {
		return 3;
	}
	if (skill.openAiImplicitInvocationDisabled) {
		return 2;
	}
	return skill.disableModelInvocation ? 1 : 0;
}

function skillPickerOptions(
	skills: readonly SkillRecord[],
	stateForSkill: (skill: SkillRecord) => {
		hint: string | undefined;
		managed: boolean;
	},
) {
	// Keep explicit-only skills after ordinary choices, but only annotate
	// author-owned metadata; skillzero-managed rows already explain their state.
	return [...skills]
		.sort(
			(left, right) =>
				skillPickerMetadataRank(left) - skillPickerMetadataRank(right) ||
				left.id.localeCompare(right.id),
		)
		.map((skill) => {
			const state = stateForSkill(skill);
			let annotation: string | undefined;
			if (!state.managed) {
				if (skill.disableModelInvocation && skill.openAiImplicitInvocationDisabled) {
					annotation = `${EMOJI.ghost} ${EMOJI.success}`;
				} else if (skill.disableModelInvocation) {
					annotation = `${EMOJI.ghost} ${EMOJI.cancel} - lacks OpenAI policy`;
				} else if (skill.openAiImplicitInvocationDisabled) {
					annotation = `${EMOJI.ghost} lacks disable-model-invocation`;
				}
			}
			return {
				value: skill.id,
				label: skill.id,
				...(state.hint === undefined ? {} : { hint: state.hint }),
				...(annotation === undefined ? {} : { annotation }),
				description: skill.description,
				source: skill.skillFile,
			};
		});
}

function promptForSkillMode(
	inventory: SkillInventory,
	message: string,
	selection: ManagedSkillSelection,
	mode: ManagedSkillMode,
): Promise<PromptSelectionResult> {
	const indexedIds = new Set(selection.indexIds);
	const hiddenIds = new Set(selection.hideIds);
	const managedIds = new Set([...indexedIds, ...hiddenIds]);
	const initialIds = mode === "index" ? selection.indexIds : selection.hideIds;
	const hiddenHint = `${EMOJI.ghost} hidden`;
	const options = skillPickerOptions(inventory.skills, (skill) => ({
		hint:
			mode === "index"
				? indexedIds.has(skill.id)
					? collectionHintForSkill(skill, inventory.collections) ?? "indexed"
					: hiddenIds.has(skill.id)
						? hiddenHint
						: undefined
				: hiddenIds.has(skill.id)
					? hiddenHint
					: indexedIds.has(skill.id)
						? collectionHintForSkill(skill, inventory.collections) ?? "indexed"
						: undefined,
		managed: managedIds.has(skill.id),
	}));

	return promptVisibleMultiselect({
		message: `${message}\n${dim(`${EMOJI.ghost} hidden skill · ${EMOJI.collection} collection membership`)}`,
		options,
		initialValues: initialIds,
		required: false,
	});
}

function availableManagedSelection(
	inventory: SkillInventory,
	selection: ManagedSkillSelection,
): ManagedSkillSelection {
	const availableIds = new Set(inventory.skills.map((skill) => skill.id));
	return {
		indexIds: selection.indexIds.filter((id) => availableIds.has(id)),
		hideIds: selection.hideIds.filter((id) => availableIds.has(id)),
	};
}

function selectionAfterModePrompt(
	selection: ManagedSkillSelection,
	mode: ManagedSkillMode,
	selectedIds: string[],
): ManagedSkillSelection {
	const selectedIdSet = new Set(selectedIds);
	return mode === "index"
		? {
				indexIds: selectedIds,
				hideIds: selection.hideIds.filter((id) => !selectedIdSet.has(id)),
			}
		: {
				indexIds: selection.indexIds.filter((id) => !selectedIdSet.has(id)),
				hideIds: selectedIds,
			};
}

function collectionHintForSkill(
	skill: SkillRecord,
	collections: SkillCollection[],
	excludedCollectionId: string | null = null,
): string | undefined {
	// While editing a collection, only show the other memberships; the checkbox
	// already communicates whether the skill belongs to the current collection.
	const collectionTitles = collections
		.filter(
			(collection) =>
				collection.id !== excludedCollectionId && collection.skillIds.includes(skill.id),
		)
		.map((collection) => collection.title);
	return collectionTitles.length > 0
		? `${EMOJI.collection} ${collectionTitles.join(", ")}`
		: undefined;
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
			message: "Use when:",
			initialValue: collectionDescriptionInput(existing?.description ?? ""),
			validate: (value) =>
				(value ?? "").trim().length > 0 ? undefined : "Enter when this collection should be used.",
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
			options: skillPickerOptions(skills, (skill) => ({
				hint: collectionHintForSkill(skill, collections, existing?.id ?? null),
				managed: true,
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
				description: formatCollectionDescription(description),
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
					hint: "Create a title, use condition, and skill group.",
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

type CollectionResolutionResult =
	| { status: "ok"; inventory: SkillInventory }
	| { status: "cancelled" }
	| { status: "declined" };

async function resolveUnknownCollectionSkills(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<CollectionResolutionResult> {
	const availableIds = new Set(allSkills(inventory).map((skill) => skill.id));
	let collections = inventory.collections;

	for (const collection of inventory.collections) {
		const unknownIds = collection.skillIds.filter((skillId) => !availableIds.has(skillId));
		if (unknownIds.length === 0) {
			continue;
		}

		p.note(
			[
				`Collection ${collection.title} references unknown skills:`,
				...unknownIds.map((skillId) => `- ${skillId}`),
			].join("\n"),
			`${EMOJI.warning} Collection needs repair`,
		);
		if (!options.yes) {
			const shouldRemove = await p.confirm({
				message: "Remove from collection?",
				initialValue: true,
			});
			if (p.isCancel(shouldRemove)) {
				return { status: "cancelled" };
			}
			if (!shouldRemove) {
				return { status: "declined" };
			}
		}

		const unknownIdSet = new Set(unknownIds);
		collections = collections.map((candidate) =>
			candidate.id === collection.id
				? {
						...candidate,
						skillIds: candidate.skillIds.filter((skillId) => !unknownIdSet.has(skillId)),
					}
				: candidate,
		);
	}

	return {
		status: "ok",
		inventory: collections === inventory.collections ? inventory : { ...inventory, collections },
	};
}

async function runWithResolvedCollections(
	options: CliOptions,
	inventory: SkillInventory,
	runForInventory: (resolvedInventory: SkillInventory) => Promise<number>,
): Promise<number> {
	const resolution = await resolveUnknownCollectionSkills(options, inventory);
	if (resolution.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}
	if (resolution.status === "declined") {
		p.cancel(`${EMOJI.warning} No changes applied.`);
		return 0;
	}

	return runForInventory(resolution.inventory);
}

async function runAcrossInventories(
	options: CliOptions,
	runForInventory: (inventory: SkillInventory) => Promise<number>,
	behavior: { resolveStaleCollections?: boolean } = {},
): Promise<number> {
	// Every mutating command must resolve and validate roots in exactly the same
	// way. Keep that lifecycle here so a new command cannot accidentally skip
	// alias reporting, duplicate-file protection, or early exit propagation.
	const inventoryResult = await resolveSkillInventories(options);
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
		const exitCode = behavior.resolveStaleCollections
			? await runWithResolvedCollections(options, inventory, runForInventory)
			: await runForInventory(inventory);
		if (exitCode !== 0) {
			return exitCode;
		}
	}

	return 0;
}

async function runConfigureForInventory(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	if (inventory.skills.length === 0) {
		console.log(`${EMOJI.info} No skills found in ${inventory.rootPath}.`);
		return 0;
	}

	const state = await readManagedSkillsState(inventory);
	const initialSelection = availableManagedSelection(
		inventory,
		selectionFromManagedSkillsState(state),
	);
	const selectionResult = await promptForSkillMode(
		inventory,
		"Select skills to make explicit-only and manage through skill-index",
		initialSelection,
		"index",
	);
	if (selectionResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	const selection = selectionAfterModePrompt(
		initialSelection,
		"index",
		selectionResult.selectedIds,
	);
	let collections = inventory.collections;
	const initialPlan = await buildManagedSkillsPlan(inventory, selection, state);
	if (initialPlan.finalIndexedSkills.length > 0) {
		// Initial setup must offer collection routing before the first index is
		// written; otherwise users have to discover the separate subcommand later.
		const collectionResult = await promptForCollections(
			initialPlan.finalIndexedSkills,
			inventory.collections,
		);
		if (collectionResult.status === "cancelled") {
			p.cancel(`${EMOJI.cancel} Operation cancelled.`);
			return 130;
		}
		collections = collectionResult.collections;
	}

	const plan = await buildManagedSkillsPlan(
		inventory,
		selection,
		state,
		collections,
	);
	return previewAndApplyManagedPlan(options, plan, `${EMOJI.success} skillzero updated.`);
}

async function runCollectionsForInventory(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	const state = await readManagedSkillsState(inventory);
	const selection = availableManagedSelection(
		inventory,
		selectionFromManagedSkillsState(state),
	);
	const initialPlan = await buildManagedSkillsPlan(inventory, selection, state);
	if (initialPlan.finalIndexedSkills.length === 0 && inventory.collections.length === 0) {
		console.log(
			`${EMOJI.info} No indexed skills or collections found in ${inventory.rootPath}.`,
		);
		return 0;
	}

	const collectionResult = await promptForCollections(
		initialPlan.finalIndexedSkills,
		inventory.collections,
	);
	if (collectionResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	const plan = await buildManagedSkillsPlan(
		inventory,
		selection,
		state,
		collectionResult.collections,
	);
	return previewAndApplyManagedPlan(
		options,
		plan,
		`${EMOJI.success} skillzero collections updated.`,
	);
}

async function runCollections(options: CliOptions): Promise<number> {
	return runAcrossInventories(
		options,
		(inventory) => runCollectionsForInventory(options, inventory),
		{ resolveStaleCollections: true },
	);
}

async function runHideForInventory(
	options: CliOptions,
	inventory: SkillInventory,
): Promise<number> {
	if (inventory.skills.length === 0) {
		console.log(`${EMOJI.info} No skills found in ${inventory.rootPath}.`);
		return 0;
	}

	const state = await readManagedSkillsState(inventory);
	const initialSelection = availableManagedSelection(
		inventory,
		selectionFromManagedSkillsState(state),
	);
	const selectionResult = await promptForSkillMode(
		inventory,
		"Select skills to hide from the model and generated indexes",
		initialSelection,
		"hide",
	);
	if (selectionResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	const selection = selectionAfterModePrompt(
		initialSelection,
		"hide",
		selectionResult.selectedIds,
	);
	const plan = await buildManagedSkillsPlan(inventory, selection, state);
	return previewAndApplyManagedPlan(
		options,
		plan,
		`${EMOJI.success} skillzero hidden skills updated.`,
	);
}

async function runHide(options: CliOptions): Promise<number> {
	return runAcrossInventories(
		options,
		(inventory) => runHideForInventory(options, inventory),
		{ resolveStaleCollections: true },
	);
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

async function runUpdate(
	options: CliOptions,
	forwardedArgs: readonly string[] = [],
): Promise<number> {
	if (options.dryRun) {
		p.note(
			"Managed skill folders already stay available to the skills CLI.",
			`${EMOJI.info} No release needed`,
		);
		return 0;
	}

	runSkillsUpdate(forwardedArgs);
	return runSync(options, {
		ignoreMissingSkills: true,
		skipUnconfigured: true,
		autoApply: true,
	});
}

async function runManagedSkillsSync(
	options: CliOptions,
	inventory: SkillInventory,
	behavior: SyncBehavior,
): Promise<number> {
	const state = await readManagedSkillsState(inventory);
	if (!state) {
		if (behavior.skipUnconfigured) {
			// A successful upstream update is a new operation, so it invalidates a
			// redo snapshot even when there is no managed state to rebuild.
			await clearRedoState(inventory.rootPath);
			return 0;
		}
		throw new SkillzeroError("No managed skills are waiting to sync. Run skillzero first.");
	}

	const availableIds = new Set(inventory.skills.map((skill) => skill.id));
	const missingIds = state.skills.map((skill) => skill.id).filter((id) => !availableIds.has(id));
	const newSkillIds = reportNewSkills(inventory, state.knownSkillIds);
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

	const retainedSelection = availableManagedSelection(
		inventory,
		selectionFromManagedSkillsState(state),
	);
	const selectionResult =
		options.yes || (behavior.autoApply && newSkillIds.length === 0)
			? { status: "ok" as const, selectedIds: retainedSelection.indexIds }
			: await promptForSkillMode(
					inventory,
					"Select skills to keep explicit-only through skill-index (new skills remain implicitly available until selected)",
					retainedSelection,
					"index",
				);
	if (selectionResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	const selection = selectionAfterModePrompt(
		retainedSelection,
		"index",
		selectionResult.selectedIds,
	);

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
		const initialPlan = await buildManagedSkillsPlan(inventory, selection, state);
		const collectionResult = await promptForCollections(
			initialPlan.finalIndexedSkills,
			inventory.collections,
		);
		if (collectionResult.status === "cancelled") {
			p.cancel(`${EMOJI.cancel} Operation cancelled.`);
			return 130;
		}
		collections = collectionResult.collections;
	}

	const plan = await buildManagedSkillsPlan(
		inventory,
		selection,
		state,
		collections,
	);
	return previewAndApplyManagedPlan(
		options,
		plan,
		`${EMOJI.success} skillzero index updated.`,
		behavior.autoApply,
	);
}

async function runSync(
	options: CliOptions,
	behavior: SyncBehavior = DEFAULT_SYNC_BEHAVIOR,
): Promise<number> {
	return runAcrossInventories(
		options,
		(inventory) => runManagedSkillsSync(options, inventory, behavior),
		{ resolveStaleCollections: true },
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

	await applyUndoPlan(plan);
	p.outro(`${EMOJI.restore}  skillzero changes undone. Run skillzero redo to restore them.`);
	return 0;
}

async function runUndo(options: CliOptions): Promise<number> {
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

	await applyRedoPlan(plan);
	p.outro(`${EMOJI.success} skillzero changes restored.`);
	return 0;
}

async function runRedo(options: CliOptions): Promise<number> {
	return runAcrossInventories(options, (inventory) => runRedoForInventory(options, inventory));
}

function readPositionalScope(options: CliOptions, argument: string): CliOptions {
	if (options.scope !== null) {
		throw new SkillzeroError("Pass only one positional scope path.");
	}

	return { ...options, scope: argument };
}

async function runDefault(options: CliOptions): Promise<number> {
	const inventoryResult = await resolveSkillInventories(options);
	if (inventoryResult.status === "cancelled") {
		p.cancel(`${EMOJI.cancel} Operation cancelled.`);
		return 130;
	}

	if (inventoryResult.inventories.length === 0) {
		console.log(`No supported skills directories found in ${inventoryResult.projectPath}.`);
		return 0;
	}

	const configuredRoots = new Map<string, boolean>();
	for (const inventory of inventoryResult.inventories) {
		configuredRoots.set(inventory.rootPath, (await readManagedSkillsState(inventory)) !== null);
	}

	logDiscoveredAliases(inventoryResult.discoveredRoots);
	for (const inventory of inventoryResult.inventories) {
		logOperationRoot(inventory, inventoryResult.inventories.length);
		const exitCode = await runWithResolvedCollections(options, inventory, (resolvedInventory) =>
			configuredRoots.get(inventory.rootPath) === true
				? runManagedSkillsSync(options, resolvedInventory, DEFAULT_SYNC_BEHAVIOR)
				: runConfigureForInventory(options, resolvedInventory),
		);
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
		.option("--dry-run", "Preview changes without writing files")
		.option("--yes", "Apply after preview without a confirmation prompt")
		.help()
		.version(CLI_VERSION);

	cli
		.command("undo", "Undo skillzero's metadata and generated index changes")
		.action(async (options) => {
			exitCode = await runUndo(readCliOptions(options));
		});

	cli.command("redo", "Redo the last skillzero undo").action(async (options) => {
		exitCode = await runRedo(readCliOptions(options));
	});

	cli
		.command("collections", "Configure title-and-use-condition groups for indexed skills")
		.action(async (options) => {
			exitCode = await runCollections(readCliOptions(options));
		});

	cli.command("hide", "Hide skills from the model and generated indexes").action(async (options) => {
		exitCode = await runHide(readCliOptions(options));
	});

	cli
		.command(
			"update [...skillArgs]",
			"Run skills update and refresh skillzero metadata and indexes",
		)
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
