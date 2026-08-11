import * as p from "@clack/prompts";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { GENERATED_DIR_NAME, REDO_STATE_FILE_NAME, SKILL_FILE_NAME } from "./constants.js";
import {
	discoverGlobalSkillsRoots,
	discoverProjectSkillsRootsAtPath,
	discoverSkillsRootsAtPath,
} from "./discovery.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";
import { readRedoState } from "./history.js";
import { scanSkills } from "./scanner.js";
import { skillzeroStatePath } from "./state.js";
import { estimateSavedTokens } from "./tokens.js";
import { dim, EMOJI } from "./ui.js";

import type { DiscoveredSkillsRoot, SkillInventory } from "./types.js";

type RootsResult =
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

type InventoryResult =
	| {
			status: "ok";
			inventories: SkillInventory[];
			projectPath: string | null;
			discoveredRoots: DiscoveredSkillsRoot[];
	  }
	| { status: "cancelled" };

/** Resolve chosen roots and reject the same physical skill linked across roots. */
export async function resolveSkillInventories(scope: string | null): Promise<InventoryResult> {
	const result = await resolveSkillsRoots(scope);
	if (result.status === "cancelled") {
		return result;
	}

	const inventories = await Promise.all(result.paths.map((rootPath) => scanSkills(rootPath)));
	await assertDistinctPhysicalSkills(inventories);

	return {
		status: "ok",
		inventories,
		projectPath: result.projectPath,
		discoveredRoots: result.discoveredRoots,
	};
}

async function resolveSkillsRoots(scope: string | null): Promise<RootsResult> {
	if (scope !== null) {
		return resolveExplicitScope(scope);
	}

	if (!process.stdin.isTTY && (await isLikelySkillsRoot(process.cwd()))) {
		// An empty configured root is still a valid non-interactive target and
		// must not fall through to the user's global roots.
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

	const { candidates, projectPath } = await discoverCandidates();
	if (candidates.length > 0 || process.stdin.isTTY) {
		return chooseRoots(candidates, projectPath);
	}

	throw new SkillzeroError(
		"No supported skills paths found. Pass a positional skills root or project path when running non-interactively.",
	);
}

async function resolveExplicitScope(scope: string): Promise<RootsResult> {
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

async function discoverCandidates(): Promise<{
	candidates: RootCandidate[];
	projectPath: string | null;
}> {
	// Build the full list before scanning so users can review managed roots and
	// opt into other roots without any writes taking place.
	const candidates = new Map<string, RootCandidate>();
	let projectPath: string | null = null;

	if (await isLikelySkillsRoot(process.cwd())) {
		const currentPath = path.resolve(process.cwd());
		const currentRealPath = await realpath(currentPath);
		mergeCandidates(
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

	mergeCandidates(candidates, await discoverSkillsRootsAtPath(process.cwd()), "project");

	const projectRoots = await discoverProjectSkillsRootsAtPath(process.cwd());
	if (projectRoots !== null) {
		projectPath = projectRoots.projectPath;
		mergeCandidates(candidates, projectRoots.roots, "project");
	}

	mergeCandidates(candidates, await discoverGlobalSkillsRoots(), "global");

	const sortedCandidates = [...candidates.values()];
	for (const candidate of sortedCandidates) {
		candidate.managed = await isManagedRoot(candidate.root.realPath);
	}

	const nonEmptyCandidates: RootCandidate[] = [];
	for (const candidate of sortedCandidates) {
		// Empty conventional directories add no useful choice to the selector.
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
		return displayPath(left).localeCompare(displayPath(right));
	});

	return { candidates: nonEmptyCandidates, projectPath };
}

async function chooseRoots(
	candidates: RootCandidate[],
	projectPath: string | null,
): Promise<RootsResult> {
	if (!process.stdin.isTTY) {
		// Non-interactive callers cannot choose, so prefer project roots and only
		// fall back to global roots when no project roots exist.
		const projectCandidates = candidates.filter((candidate) => candidate.location === "project");
		const selected = projectCandidates.length > 0 ? projectCandidates : candidates;
		return rootsResult(
			selected.map((candidate) => candidate.root),
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

	p.note(await candidateSummary(candidates), `${EMOJI.folder} Skills paths`);
	const selectedPaths = await p.multiselect<string>({
		message: `${EMOJI.folder} Choose skills paths to manage`,
		options: candidates.map((candidate) => ({
			value: candidate.root.path,
			label: displayPath(candidate),
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

async function candidateSummary(candidates: RootCandidate[]): Promise<string> {
	const managed = candidates.filter((candidate) => candidate.managed);
	const available = candidates.filter((candidate) => !candidate.managed);
	const lines = [`${EMOJI.managed} Managed by skillzero`];

	if (managed.length === 0) {
		lines.push(`  ${dim("None found")}`);
	} else {
		const managedPaths = await Promise.all(
			managed.map(async (candidate) => {
				const inventory = await scanSkills(candidate.root.realPath);
				const savings = await savedTokens(inventory);
				return `  ${displayPath(candidate)} ${dim(`(saves: ${savings} tokens)`)}`;
			}),
		);
		lines.push(...managedPaths);
	}

	lines.push("", `${EMOJI.info} Available skill paths`);
	if (available.length === 0) {
		lines.push(`  ${dim("None found")}`);
	} else {
		lines.push(...available.map((candidate) => `  ${displayPath(candidate)}`));
	}

	return lines.join("\n");
}

async function savedTokens(inventory: SkillInventory): Promise<number> {
	const skillsById = new Map(inventory.skills.map((skill) => [skill.id, skill]));
	if (inventory.state !== null) {
		return estimateSavedTokens(
			inventory.state.skills.flatMap((managedSkill) => {
				const skill = skillsById.get(managedSkill.id);
				return skill ? [skill] : [];
			}),
			inventory.collections,
		);
	}

	const redoState = await readRedoState(inventory.rootPath);
	if (redoState === null) {
		return 0;
	}

	const managedIds = new Set(redoState.hiddenIds);
	for (const collection of redoState.collections) {
		for (const skillId of collection.skillIds) {
			managedIds.add(skillId);
		}
	}
	return estimateSavedTokens(
		[...managedIds].flatMap((id) => {
			const skill = skillsById.get(id);
			return skill ? [skill] : [];
		}),
		redoState.collections,
	);
}

function displayPath(candidate: RootCandidate): string {
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

function mergeCandidates(
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

async function isLikelySkillsRoot(scopePath: string): Promise<boolean> {
	const resolvedScope = path.resolve(scopePath);
	if (path.basename(resolvedScope) === "skills") {
		return true;
	}
	if ((await getPathKind(resolvedScope)) !== "directory") {
		return false;
	}
	if ((await getPathKind(path.join(resolvedScope, GENERATED_DIR_NAME))) === "directory") {
		return true;
	}
	if ((await getPathKind(path.join(resolvedScope, REDO_STATE_FILE_NAME))) === "file") {
		return true;
	}

	// A custom root is identified by an immediate child with a skill file.
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

async function isManagedRoot(rootPath: string): Promise<boolean> {
	const stateFile = skillzeroStatePath(path.join(rootPath, GENERATED_DIR_NAME));
	return (
		(await getPathKind(stateFile)) === "file" ||
		(await getPathKind(path.join(rootPath, REDO_STATE_FILE_NAME))) === "file"
	);
}

async function rootHasSkills(rootPath: string): Promise<boolean> {
	return (await scanSkills(rootPath)).skills.length > 0;
}

function rootsResult(roots: DiscoveredSkillsRoot[], projectPath: string | null): RootsResult {
	return {
		status: "ok",
		paths: roots.map((root) => root.path),
		projectPath,
		discoveredRoots: roots,
	};
}

async function assertDistinctPhysicalSkills(inventories: SkillInventory[]): Promise<void> {
	const foundByFile = new Map<string, { rootPath: string; skillFile: string }>();
	for (const inventory of inventories) {
		for (const skill of inventory.skills) {
			const physicalSkillFile = await realpath(skill.skillFile);
			const previous = foundByFile.get(physicalSkillFile);
			if (previous && previous.rootPath !== inventory.rootPath) {
				throw new SkillzeroError(
					`The same SKILL.md file is linked in multiple roots: ${previous.skillFile} and ${skill.skillFile}. Use only one skills root, or invoke skillzero with the whole skills root so skillzero can handle duplicates.`,
				);
			}

			foundByFile.set(physicalSkillFile, {
				rootPath: inventory.rootPath,
				skillFile: skill.skillFile,
			});
		}
	}
}
