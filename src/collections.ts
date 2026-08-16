import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { GENERATED_MARKER, SKILL_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind, hasDifferentFileContent, removeEmptyDirectory } from "./fs-utils.js";
import { EMOJI } from "./ui.js";
import { isRecord } from "./values.js";

import type { SkillCollection, SkillInventory, SkillRecord } from "./types.js";

export interface CollectionPlan {
	generatedPath: string;
	collectionSkillFiles: { path: string; content: string }[];
	finalCollections: SkillCollection[];
	generatedCollectionIdsToRemove: string[];
	collectionsChanged: boolean;
}

/** Prefix reserved for top-level generated collection skill folders. */
export const COLLECTION_SKILL_PREFIX = "skillzero-";

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isCollectionId(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

const COLLECTION_DESCRIPTION_PREFIX = "Use when ";

// Keep collection frontmatter canonical while letting the editor work with
// only the user-authored completion after "Use when".
export function collectionDescriptionInput(description: string): string {
	const text = cleanText(description);
	return text.startsWith(COLLECTION_DESCRIPTION_PREFIX)
		? text.slice(COLLECTION_DESCRIPTION_PREFIX.length)
		: text;
}

export function formatCollectionDescription(input: string): string {
	return `${COLLECTION_DESCRIPTION_PREFIX}${collectionDescriptionInput(input)}`;
}

function cleanCollection(collection: SkillCollection): SkillCollection {
	return {
		id: collection.id,
		title: cleanText(collection.title),
		description: formatCollectionDescription(collection.description),
		skillIds: [...collection.skillIds].sort((left, right) => left.localeCompare(right)),
	};
}

function parseCollection(value: unknown, filePath: string, index: number): SkillCollection {
	if (!isRecord(value)) {
		throw new SkillzeroError(`Invalid collection ${index + 1} in ${filePath}`);
	}

	const id = readNonEmptyString(value["id"]);
	const title = readNonEmptyString(value["title"]);
	const description = readNonEmptyString(value["description"]);
	const storedSkillIds = value["skillIds"];
	if (
		id === null ||
		!isCollectionId(id) ||
		title === null ||
		description === null ||
		!Array.isArray(storedSkillIds)
	) {
		throw new SkillzeroError(`Invalid collection ${index + 1} in ${filePath}`);
	}

	const skillIds: string[] = [];
	for (const skillIdValue of storedSkillIds) {
		const skillId = readNonEmptyString(skillIdValue);
		if (skillId === null || skillIds.includes(skillId)) {
			throw new SkillzeroError(`Invalid collection ${index + 1} in ${filePath}`);
		}

		skillIds.push(skillId);
	}

	return { id, title, description, skillIds };
}

// Active state and redo snapshots store the same records. Parse and clean them
// here so both formats have one contract.
export function parseSkillCollections(value: unknown, filePath: string): SkillCollection[] {
	if (!Array.isArray(value)) {
		throw new SkillzeroError(`Invalid collections in ${filePath}`);
	}

	const ids = new Set<string>();
	const collections: SkillCollection[] = [];
	for (const [index, collectionValue] of value.entries()) {
		const collection = parseCollection(collectionValue, filePath, index);
		if (ids.has(collection.id)) {
			throw new SkillzeroError(`Duplicate collection id in ${filePath}: ${collection.id}`);
		}

		ids.add(collection.id);
		collections.push(collection);
	}

	return collections
		.sort((left, right) => left.id.localeCompare(right.id))
		.map(cleanCollection);
}

export function collectionSkillIds(collections: readonly SkillCollection[]): Set<string> {
	return new Set(collections.flatMap((collection) => collection.skillIds));
}

export function collectionDirectoryPath(generatedPath: string, collectionId: string): string {
	// State stays under skillzero/, while generated collection skills sit beside
	// ordinary skills so the harness can discover them as top-level skills.
	return path.join(path.dirname(generatedPath), `${COLLECTION_SKILL_PREFIX}${collectionId}`);
}

function collectionSkillFilePath(generatedPath: string, collectionId: string): string {
	return path.join(collectionDirectoryPath(generatedPath, collectionId), SKILL_FILE_NAME);
}

export function collectionIdFromTitle(title: string): string {
	const id = title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return id.length > 0 ? id : "collection";
}

async function validateCollectionFiles(
	generatedPath: string,
	collections: SkillCollection[],
): Promise<void> {
	for (const collection of collections) {
		const directory = collectionDirectoryPath(generatedPath, collection.id);
		const directoryKind = await getPathKind(directory);
		if (directoryKind !== "missing" && directoryKind !== "directory") {
			throw new SkillzeroError(`Path conflict: ${directory} must be a directory.`);
		}

		const skillFile = collectionSkillFilePath(generatedPath, collection.id);
		const skillFileKind = await getPathKind(skillFile);
		if (skillFileKind !== "missing" && skillFileKind !== "file") {
			throw new SkillzeroError(`Path conflict: ${skillFile} must be a file.`);
		}

		if (
			skillFileKind === "file" &&
			!(await readFile(skillFile, "utf8")).includes(GENERATED_MARKER)
		) {
			throw new SkillzeroError(
				`Refusing to overwrite non-generated collection skill: ${skillFile}`,
			);
		}
	}
}

export async function scanGeneratedCollectionIds(
	generatedPath: string,
	configuredCollections: SkillCollection[],
): Promise<string[]> {
	// Stale generated collection files are safe to remove later; any user-authored
	// SKILL.md under the reserved top-level prefix must stop the run before a write occurs.
	await validateCollectionFiles(generatedPath, configuredCollections);

	const skillsRootPath = path.dirname(generatedPath);
	const rootKind = await getPathKind(skillsRootPath);
	if (rootKind === "missing") {
		return [];
	}
	if (rootKind !== "directory") {
		throw new SkillzeroError(`Path conflict: ${skillsRootPath} must be a directory.`);
	}

	const configuredIds = new Set(configuredCollections.map((collection) => collection.id));
	const entries = await readdir(skillsRootPath, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));

	const generatedIds: string[] = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(COLLECTION_SKILL_PREFIX)) {
			continue;
		}

		const collectionId = entry.name.slice(COLLECTION_SKILL_PREFIX.length);
		if (!isCollectionId(collectionId)) {
			throw new SkillzeroError(`Invalid generated collection skill path: ${entry.name}`);
		}

		const directory = path.join(skillsRootPath, entry.name);
		if ((await getPathKind(directory)) !== "directory") {
			continue;
		}

		const skillFile = path.join(directory, SKILL_FILE_NAME);
		const skillFileKind = await getPathKind(skillFile);
		if (skillFileKind === "missing") {
			continue;
		}
		if (skillFileKind !== "file") {
			throw new SkillzeroError(`Path conflict: ${skillFile} must be a file.`);
		}

		const content = await readFile(skillFile, "utf8");
		if (!content.includes(GENERATED_MARKER)) {
			const message = configuredIds.has(collectionId)
				? "Refusing to overwrite non-generated collection skill"
				: "Unexpected non-generated collection skill";
			throw new SkillzeroError(`${message}: ${skillFile}`);
		}

		generatedIds.push(collectionId);
	}

	return generatedIds;
}

export async function buildCollectionPlan(
	inventory: SkillInventory,
	finalManagedSkills: SkillRecord[],
	collections = inventory.collections,
): Promise<CollectionPlan> {
	// A collection can only reference skills whose metadata skillzero owns.
	const knownIds = new Set(inventory.skills.map((skill) => skill.id));
	const finalManagedIds = new Set(finalManagedSkills.map((skill) => skill.id));
	const collectionIds = new Set<string>();
	const finalCollections: SkillCollection[] = [];

	for (const collection of collections) {
		if (collectionIds.has(collection.id)) {
			throw new SkillzeroError(`Duplicate collection id: ${collection.id}`);
		}
		if (!isCollectionId(collection.id)) {
			throw new SkillzeroError(`Invalid collection id: ${collection.id}`);
		}

		const unknownSkillIds = collection.skillIds.filter((skillId) => !knownIds.has(skillId));
		if (unknownSkillIds.length > 0) {
			throw new SkillzeroError(
				`Collection ${collection.title} references unknown skills: ${unknownSkillIds.join(", ")}`,
			);
		}

		collectionIds.add(collection.id);
		finalCollections.push({
			id: collection.id,
			title: collection.title,
			description: collection.description,
			skillIds: collection.skillIds.filter((skillId) => finalManagedIds.has(skillId)),
		});
	}

	finalCollections.sort((left, right) => left.id.localeCompare(right.id));
	const cleanCollections = finalCollections.map(cleanCollection);
	// Plans carry the exact bytes they validate. Applying a confirmed plan must
	// not rerun rendering against domain records that a caller could mutate.
	const collectionSkillFiles = cleanCollections.map((collection) => ({
		path: collectionSkillFilePath(inventory.generatedPath, collection.id),
		content: generateCollectionSkill(collection, finalManagedSkills, inventory.generatedPath),
	}));
	const plan: CollectionPlan = {
		generatedPath: inventory.generatedPath,
		collectionSkillFiles,
		finalCollections: cleanCollections,
		generatedCollectionIdsToRemove: inventory.generatedCollectionIds
			.filter((id) => !collectionIds.has(id))
			.sort((left, right) => left.localeCompare(right)),
		collectionsChanged: false,
	};

	await validateCollectionFiles(plan.generatedPath, plan.finalCollections);
	let collectionsChanged = false;
	for (const file of plan.collectionSkillFiles) {
		if (await hasDifferentFileContent(file.path, file.content)) {
			collectionsChanged = true;
			break;
		}
	}

	if (!collectionsChanged && plan.generatedCollectionIdsToRemove.length > 0) {
		collectionsChanged = true;
	}

	return { ...plan, collectionsChanged };
}

function markdownTableCell(value: string): string {
	return value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}

function relativeSkillPath(
	collection: SkillCollection,
	generatedPath: string,
	skill: SkillRecord,
): string {
	return path
		.relative(collectionDirectoryPath(generatedPath, collection.id), skill.skillFile)
		.split(path.sep)
		.join("/");
}

function generateCollectionSkill(
	collection: SkillCollection,
	skills: SkillRecord[],
	generatedPath: string,
): string {
	const collectionSkillIds = new Set(collection.skillIds);
	const rows = skills
		.filter((skill) => collectionSkillIds.has(skill.id))
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((skill) => {
			const sourcePath = relativeSkillPath(collection, generatedPath, skill);
			return `| \`${markdownTableCell(skill.id)}\` | ${markdownTableCell(skill.description)} | \`${sourcePath}\` |`;
		});
	const tableRows =
		rows.length > 0
			? rows.join("\n")
			: "| _No skills assigned_ | Assign skills to this collection. | _None_ |";

	return `---
name: ${collection.id}
description: ${JSON.stringify(collection.description)}
---
# ${collection.title}

${GENERATED_MARKER}

When a user request matches any of the skill(s), read the source.

| Skill | Description | Source |
| --- | --- | --- |
${tableRows}
`;
}

export function formatCollectionPlan(plan: CollectionPlan): string {
	const lines = [
		plan.collectionsChanged
			? `- ${EMOJI.collection} Update ${plan.finalCollections.length} collection(s).`
			: `- ${EMOJI.collection} No update to collections.`,
	];
	for (const collection of plan.finalCollections) {
		lines.push(
			`- ${EMOJI.collection} Collection ${collection.title}: ${collection.skillIds.length} skill(s).`,
		);
	}
	for (const id of plan.generatedCollectionIdsToRemove) {
		lines.push(`- ${EMOJI.remove}  Remove generated collection: ${id}`);
	}
	return lines.join("\n");
}

export async function applyCollectionPlan(plan: CollectionPlan): Promise<void> {
	for (const file of plan.collectionSkillFiles) {
		await mkdir(path.dirname(file.path), { recursive: true });
		await writeFile(file.path, file.content, "utf8");
	}

	for (const collectionId of plan.generatedCollectionIdsToRemove) {
		const skillFile = collectionSkillFilePath(plan.generatedPath, collectionId);
		const kind = await getPathKind(skillFile);
		if (kind === "missing") {
			await removeEmptyDirectory(collectionDirectoryPath(plan.generatedPath, collectionId));
			continue;
		}
		if (kind !== "file") {
			throw new SkillzeroError(`Path conflict: ${skillFile} must be a file.`);
		}

		const content = await readFile(skillFile, "utf8");
		if (!content.includes(GENERATED_MARKER)) {
			throw new SkillzeroError(`Refusing to remove non-generated collection skill: ${skillFile}`);
		}
		await unlink(skillFile);
		await removeEmptyDirectory(collectionDirectoryPath(plan.generatedPath, collectionId));
	}

	// This also handles an orphaned generated collection tree with no state;
	// active state or any user file naturally keeps the reserved root in place.
	await removeEmptyDirectory(plan.generatedPath);
}
