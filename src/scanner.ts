import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import matter from "@11ty/gray-matter";

import {
	CODEX_METADATA_DIR_NAME,
	CODEX_METADATA_FILE_NAME,
	GENERATED_DIR_NAME,
	SKILL_FILE_NAME,
} from "./constants.js";
import { collectionDirectoryPath, scanGeneratedCollectionIds } from "./collections.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind } from "./fs-utils.js";
import { readSkillzeroState } from "./state.js";
import { isRecord } from "./values.js";

import type { SkillInventory, SkillRecord } from "./types.js";

/** Read OpenAI policy YAML without mistaking document separators for skill frontmatter. */
export function readOpenAiImplicitInvocation(content: string, filePath: string): boolean | null {
	let parsed: ReturnType<typeof matter>;
	try {
		parsed = matter(`%%%\n${content}\n%%%`, { delimiters: "%%%" });
	} catch {
		throw new SkillzeroError(`Invalid OpenAI skill metadata: ${filePath}`);
	}

	if (!isRecord(parsed.data)) {
		throw new SkillzeroError(`OpenAI skill metadata must be an object: ${filePath}`);
	}
	const policy = parsed.data["policy"];
	if (policy === undefined) {
		return null;
	}
	if (!isRecord(policy)) {
		throw new SkillzeroError(`OpenAI skill metadata policy must be an object: ${filePath}`);
	}
	const value = policy["allow_implicit_invocation"];
	if (value === undefined) {
		return null;
	}
	if (typeof value !== "boolean") {
		throw new SkillzeroError(
			`policy.allow_implicit_invocation must be true or false: ${filePath}`,
		);
	}

	return value;
}

async function hasOpenAiExplicitOnlyPolicy(directory: string): Promise<boolean> {
	const filePath = path.join(directory, CODEX_METADATA_DIR_NAME, CODEX_METADATA_FILE_NAME);
	const kind = await getPathKind(filePath);
	if (kind === "missing") {
		return false;
	}
	if (kind !== "file") {
		throw new SkillzeroError(`OpenAI skill metadata must be a file: ${filePath}`);
	}

	return readOpenAiImplicitInvocation(await readFile(filePath, "utf8"), filePath) === false;
}

function readDescription(data: unknown): string | null {
	if (!isRecord(data) || typeof data["description"] !== "string") {
		return null;
	}

	const description = data["description"].trim();
	return description.length > 0 ? description : null;
}

function firstUsefulBodyLine(content: string): string | null {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
			continue;
		}

		return trimmed;
	}

	return null;
}

async function readSkillFromDirectory(
	directory: string,
	id: string,
): Promise<SkillRecord | null> {
	const skillFile = path.join(directory, SKILL_FILE_NAME);
	const skillFileKind = await getPathKind(skillFile);
	if (skillFileKind !== "file") {
		return null;
	}

	const [content, openAiImplicitInvocationDisabled] = await Promise.all([
		readFile(skillFile, "utf8"),
		hasOpenAiExplicitOnlyPolicy(directory),
	]);
	const parsed = matter(content);
	return {
		id,
		description:
			readDescription(parsed.data) ??
			firstUsefulBodyLine(parsed.content) ??
			"No description provided.",
		disableModelInvocation:
			isRecord(parsed.data) && parsed.data["disable-model-invocation"] === true,
		openAiImplicitInvocationDisabled,
		skillFile,
	};
}

async function scanImmediateSkillChildren(rootPath: string): Promise<SkillRecord[]> {
	const entries = await readdir(rootPath, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));

	const skills: SkillRecord[] = [];
	const seenSkillFiles = new Set<string>();
	for (const entry of entries) {
		const directory = path.join(rootPath, entry.name);
		// Dirent reports a symbolic link as neither a file nor a directory. Stat
		// follows the link, letting a linked skill directory participate normally
		// while broken links remain safely ignored.
		if ((await getPathKind(directory)) !== "directory") {
			continue;
		}

		const skill = await readSkillFromDirectory(directory, entry.name);
		if (skill !== null) {
			// A directory can be linked twice under one skills root. Keep the first
			// stable name so one physical SKILL.md cannot receive conflicting state
			// entries during the same operation.
			const physicalSkillFile = await realpath(skill.skillFile);
			if (seenSkillFiles.has(physicalSkillFile)) {
				continue;
			}

			seenSkillFiles.add(physicalSkillFile);
			skills.push(skill);
		}
	}

	return skills;
}

export async function scanSkills(rootPath: string): Promise<SkillInventory> {
	const resolvedRoot = path.resolve(rootPath);
	const rootKind = await getPathKind(resolvedRoot);

	if (rootKind === "missing") {
		throw new SkillzeroError(`Skills path does not exist: ${resolvedRoot}`);
	}

	if (rootKind !== "directory") {
		throw new SkillzeroError(`Skills path must be a directory: ${resolvedRoot}`);
	}

	const generatedPath = path.join(resolvedRoot, GENERATED_DIR_NAME);
	const generatedPathKind = await getPathKind(generatedPath);
	if (generatedPathKind !== "missing" && generatedPathKind !== "directory") {
		throw new SkillzeroError(`Path conflict: ${generatedPath} must be a directory.`);
	}

	const state = await readSkillzeroState(generatedPath);
	const collections = state?.collections ?? [];
	const generatedCollectionIds = await scanGeneratedCollectionIds(
		generatedPath,
		collections,
	);
	const generatedCollectionNames = new Set(
		generatedCollectionIds.map((id) => path.basename(collectionDirectoryPath(generatedPath, id))),
	);

	// Top-level generated collections contain SKILL.md too, but they are routing
	// entries rather than user-owned skills and must not enter the inventory.
	const skills = (await scanImmediateSkillChildren(resolvedRoot)).filter(
		(skill) => skill.id !== GENERATED_DIR_NAME && !generatedCollectionNames.has(skill.id),
	);

	return {
		rootPath: resolvedRoot,
		generatedPath,
		skills,
		state,
		collections,
		generatedCollectionIds,
	};
}
