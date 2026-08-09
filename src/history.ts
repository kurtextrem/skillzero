import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseSkillCollections } from "./collections.js";
import { REDO_STATE_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";

import type { SkillCollection } from "./types.js";

// The generated directory is removed by undo, so this small root-level snapshot is
// the durable source for the one redo operation we support.
export interface RedoState {
	version: 1;
	hiddenIds: string[];
	collections: SkillCollection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseRedoState(content: string, filePath: string): RedoState {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new SkillzeroError(`Invalid skillzero redo state: ${filePath}`);
	}

	if (!isRecord(value) || value["version"] !== 1) {
		throw new SkillzeroError(`Invalid skillzero redo state: ${filePath}`);
	}

	const storedHiddenIds = value["hiddenIds"];
	if (!Array.isArray(storedHiddenIds)) {
		throw new SkillzeroError(`Invalid skillzero redo state: ${filePath}`);
	}

	const hiddenIds: string[] = [];
	for (const storedId of storedHiddenIds) {
		if (typeof storedId !== "string" || storedId.length === 0 || hiddenIds.includes(storedId)) {
			throw new SkillzeroError(`Invalid skillzero redo state: ${filePath}`);
		}
		hiddenIds.push(storedId);
	}

	const collections = parseSkillCollections(value["collections"], filePath);
	hiddenIds.sort((left, right) => left.localeCompare(right));
	return { version: 1, hiddenIds, collections };
}

function redoStatePath(rootPath: string): string {
	return path.join(rootPath, REDO_STATE_FILE_NAME);
}

export async function readRedoState(rootPath: string): Promise<RedoState | null> {
	const filePath = redoStatePath(rootPath);
	const kind = await getPathKind(filePath);
	if (kind === "missing") {
		return null;
	}
	if (kind !== "file") {
		throw new SkillzeroError(`Redo state must be a file: ${filePath}`);
	}

	return parseRedoState(await readFile(filePath, "utf8"), filePath);
}

export async function writeRedoState(rootPath: string, state: RedoState): Promise<void> {
	const filePath = redoStatePath(rootPath);
	const normalized: RedoState = {
		version: 1,
		hiddenIds: [...state.hiddenIds].sort((left, right) => left.localeCompare(right)),
		collections: parseSkillCollections(state.collections, filePath),
	};

	await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function clearRedoState(rootPath: string): Promise<void> {
	await rm(redoStatePath(rootPath), { force: true });
}
