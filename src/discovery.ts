import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";

import type { DiscoveredSkillsRoot } from "./types.js";

const CONVENTIONAL_SKILL_ROOT_SEGMENTS = [
	[".agents", "skills"],
	[".claude", "skills"],
	[".codex", "skills"],
	[".cursor", "skills"],
	[".gemini", "skills"],
	[".github", "skills"],
];

function ancestorPaths(startPath: string): string[] {
	const ancestors: string[] = [];
	let currentPath = path.resolve(startPath);
	while (true) {
		ancestors.push(currentPath);
		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) {
			return ancestors;
		}
		currentPath = parentPath;
	}
}

function isWithin(parentPath: string, childPath: string): boolean {
	const relativePath = path.relative(parentPath, childPath);
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath))
	);
}

async function discoverCandidateRoots(
	candidatePaths: readonly string[],
): Promise<DiscoveredSkillsRoot[]> {
	const rootsByRealPath = new Map<string, DiscoveredSkillsRoot>();
	for (const candidatePath of candidatePaths) {
		const candidateKind = await getPathKind(candidatePath);
		if (candidateKind === "missing") {
			continue;
		}
		if (candidateKind !== "directory") {
			throw new SkillzeroError(`Discovered skills path must be a directory: ${candidatePath}`);
		}

		// A skills root is often linked into .agents from a harness-specific
		// directory. Use the real directory as its identity so we never manage
		// the same generated index twice through two aliases.
		const realPath = await realpath(candidatePath);
		const existingRoot = rootsByRealPath.get(realPath);
		if (existingRoot) {
			existingRoot.aliases.push(candidatePath);
			continue;
		}

		rootsByRealPath.set(realPath, {
			path: candidatePath,
			realPath,
			aliases: [candidatePath],
		});
	}

	return [...rootsByRealPath.values()];
}

export async function discoverSkillsRoots(projectPath: string): Promise<DiscoveredSkillsRoot[]> {
	const resolvedProjectPath = path.resolve(projectPath);
	const projectKind = await getPathKind(resolvedProjectPath);
	if (projectKind === "missing") {
		throw new SkillzeroError(`Project path does not exist: ${resolvedProjectPath}`);
	}
	if (projectKind !== "directory") {
		throw new SkillzeroError(`Project path must be a directory: ${resolvedProjectPath}`);
	}

	const candidatePaths = CONVENTIONAL_SKILL_ROOT_SEGMENTS.map((segments) =>
		path.join(resolvedProjectPath, ...segments),
	);
	return discoverCandidateRoots(candidatePaths);
}

export async function discoverSkillsRootsAtPath(scopePath: string): Promise<DiscoveredSkillsRoot[]> {
	const resolvedScopePath = path.resolve(scopePath);
	const candidatePaths: string[] = [];
	for (const ancestorPath of ancestorPaths(resolvedScopePath)) {
		for (const segments of CONVENTIONAL_SKILL_ROOT_SEGMENTS) {
			const candidatePath = path.join(ancestorPath, ...segments);
			if (
				isWithin(candidatePath, resolvedScopePath) ||
				path.dirname(candidatePath) === resolvedScopePath
			) {
				candidatePaths.push(candidatePath);
			}
		}
	}

	return discoverCandidateRoots(candidatePaths);
}

export async function discoverProjectSkillsRootsAtPath(
	scopePath: string,
): Promise<{ projectPath: string; roots: DiscoveredSkillsRoot[] } | null> {
	for (const ancestorPath of ancestorPaths(scopePath)) {
		if (ancestorPath === homedir()) {
			break;
		}

		if ((await getPathKind(ancestorPath)) !== "directory") {
			continue;
		}

		const roots = await discoverSkillsRoots(ancestorPath);
		if (roots.length > 0) {
			return { projectPath: ancestorPath, roots };
		}
	}

	return null;
}

export async function discoverGlobalSkillsRoots(): Promise<DiscoveredSkillsRoot[]> {
	// Bare `skillzero` falls back to the conventional user-level roots after
	// checking the current project, which makes global sync repeatable without
	// storing machine-specific paths in the project.
	const candidatePaths = CONVENTIONAL_SKILL_ROOT_SEGMENTS.map((segments) =>
		path.join(homedir(), ...segments),
	);
	return discoverCandidateRoots(candidatePaths);
}
