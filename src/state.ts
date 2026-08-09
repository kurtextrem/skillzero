import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseSkillCollections } from "./collections.js";
import { STATE_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";

import type {
	CodexMetadataState,
	FrontmatterState,
	ManagedSkillState,
	SkillzeroState,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFrontmatterState(value: unknown): value is FrontmatterState {
	if (!isRecord(value)) {
		return false;
	}

	return (
		(typeof value["originalValue"] === "boolean" || value["originalValue"] === null) &&
		typeof value["appliedContentHash"] === "string"
	);
}

function isCodexMetadataState(value: unknown): value is CodexMetadataState {
	if (!isRecord(value)) {
		return false;
	}

	return (
		(typeof value["originalContent"] === "string" || value["originalContent"] === null) &&
		typeof value["appliedContentHash"] === "string"
	);
}

function isManagedSkillState(value: unknown): value is ManagedSkillState {
	return (
		isRecord(value) &&
		typeof value["id"] === "string" &&
		value["id"].length > 0 &&
		(value["frontmatter"] === undefined || isFrontmatterState(value["frontmatter"])) &&
		(value["codex"] === undefined || isCodexMetadataState(value["codex"]))
	);
}

function parseSkillzeroState(content: string, filePath: string): SkillzeroState {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new SkillzeroError(`Invalid skillzero state: ${filePath}`);
	}

	if (
		!isRecord(value) ||
		value["version"] !== 1 ||
		!Array.isArray(value["knownIds"]) ||
		!Array.isArray(value["skills"])
	) {
		throw new SkillzeroError(`Invalid skillzero state: ${filePath}`);
	}

	const knownIds: string[] = [];
	const knownIdSet = new Set<string>();
	for (const storedId of value["knownIds"]) {
		if (typeof storedId !== "string" || storedId.length === 0 || knownIdSet.has(storedId)) {
			throw new SkillzeroError(`Invalid skillzero state: ${filePath}`);
		}
		knownIdSet.add(storedId);
		knownIds.push(storedId);
	}

	const skills: ManagedSkillState[] = [];
	const skillIds = new Set<string>();
	for (const storedSkill of value["skills"]) {
		if (
			!isManagedSkillState(storedSkill) ||
			skillIds.has(storedSkill.id) ||
			!knownIdSet.has(storedSkill.id)
		) {
			throw new SkillzeroError(`Invalid skillzero state: ${filePath}`);
		}

		skillIds.add(storedSkill.id);
		const skill: ManagedSkillState = { id: storedSkill.id };
		if (storedSkill.frontmatter) {
			skill.frontmatter = { ...storedSkill.frontmatter };
		}
		if (storedSkill.codex) {
			skill.codex = { ...storedSkill.codex };
		}
		skills.push(skill);
	}

	knownIds.sort((left, right) => left.localeCompare(right));
	skills.sort((left, right) => left.id.localeCompare(right.id));
	return {
		version: 1,
		knownIds,
		skills,
		collections: parseSkillCollections(value["collections"], filePath),
	};
}

export function skillzeroStatePath(generatedPath: string): string {
	return path.join(generatedPath, STATE_FILE_NAME);
}

export async function readSkillzeroState(generatedPath: string): Promise<SkillzeroState | null> {
	// The generated tree is the one durable boundary for active configuration:
	// restoration ownership and collection definitions must move together.
	const filePath = skillzeroStatePath(generatedPath);
	const kind = await getPathKind(filePath);
	if (kind === "missing") {
		return null;
	}
	if (kind !== "file") {
		throw new SkillzeroError(`Skillzero state must be a file: ${filePath}`);
	}

	return parseSkillzeroState(await readFile(filePath, "utf8"), filePath);
}
