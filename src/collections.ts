import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	COLLECTIONS_DIR_NAME,
	COLLECTION_CONFIG_FILE_NAME,
	GENERATED_MARKER,
	SKILL_FILE_NAME,
} from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind, hasDifferentFileContent } from "./fs-utils.js";
import { EMOJI } from "./ui.js";

import type { CollectionPlan, SkillCollection, SkillInventory, SkillRecord } from "./types.js";

export interface CollectionConfig {
	version: 1;
	collections: SkillCollection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

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

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function normalizeCollection(collection: SkillCollection): SkillCollection {
	return {
		id: collection.id,
		title: normalizeText(collection.title),
		description: normalizeText(collection.description),
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

function parseCollectionConfig(content: string, filePath: string): CollectionConfig {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new SkillzeroError(`Invalid skillzero collection config: ${filePath}`);
	}

	if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["collections"])) {
		throw new SkillzeroError(`Invalid skillzero collection config: ${filePath}`);
	}

	const storedCollections = value["collections"];
	const ids = new Set<string>();
	const collections: SkillCollection[] = [];
	for (const [index, collectionValue] of storedCollections.entries()) {
		const collection = parseCollection(collectionValue, filePath, index);
		if (ids.has(collection.id)) {
			throw new SkillzeroError(`Duplicate collection id in ${filePath}: ${collection.id}`);
		}

		ids.add(collection.id);
		collections.push(collection);
	}

	collections.sort((left, right) => left.id.localeCompare(right.id));
	return { version: 1, collections: collections.map(normalizeCollection) };
}

export function collectionsPath(indexSkillPath: string): string {
	return path.join(indexSkillPath, COLLECTIONS_DIR_NAME);
}

export function collectionConfigPath(indexSkillPath: string): string {
	return path.join(indexSkillPath, COLLECTION_CONFIG_FILE_NAME);
}

export function collectionDirectoryPath(indexSkillPath: string, collectionId: string): string {
	return path.join(collectionsPath(indexSkillPath), collectionId);
}

export function collectionSkillFilePath(indexSkillPath: string, collectionId: string): string {
	return path.join(collectionDirectoryPath(indexSkillPath, collectionId), SKILL_FILE_NAME);
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

export async function readCollectionConfig(indexSkillPath: string): Promise<CollectionConfig> {
	// Keep collection membership in a small machine-owned file so generated
	// routing skills can be rebuilt after a skill update without editing them.
	const filePath = collectionConfigPath(indexSkillPath);
	const kind = await getPathKind(filePath);
	if (kind === "missing") {
		return { version: 1, collections: [] };
	}
	if (kind !== "file") {
		throw new SkillzeroError(`Collection config must be a file: ${filePath}`);
	}

	return parseCollectionConfig(await readFile(filePath, "utf8"), filePath);
}

async function validateConfiguredCollectionFiles(
	indexSkillPath: string,
	collections: SkillCollection[],
): Promise<void> {
	for (const collection of collections) {
		const directory = collectionDirectoryPath(indexSkillPath, collection.id);
		const directoryKind = await getPathKind(directory);
		if (directoryKind !== "missing" && directoryKind !== "directory") {
			throw new SkillzeroError(`Path conflict: ${directory} must be a directory.`);
		}

		const skillFile = collectionSkillFilePath(indexSkillPath, collection.id);
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
	indexSkillPath: string,
	configuredCollections: SkillCollection[],
): Promise<string[]> {
	// Stale generated collection files are safe to remove later; any user-authored
	// SKILL.md in this reserved tree must stop the run before a write occurs.
	await validateConfiguredCollectionFiles(indexSkillPath, configuredCollections);

	const rootPath = collectionsPath(indexSkillPath);
	const rootKind = await getPathKind(rootPath);
	if (rootKind === "missing") {
		return [];
	}
	if (rootKind !== "directory") {
		throw new SkillzeroError(`Path conflict: ${rootPath} must be a directory.`);
	}

	const configuredIds = new Set(configuredCollections.map((collection) => collection.id));
	const entries = await readdir(rootPath, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));

	const generatedIds: string[] = [];
	for (const entry of entries) {
		const directory = path.join(rootPath, entry.name);
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
			const message = configuredIds.has(entry.name)
				? "Refusing to overwrite non-generated collection skill"
				: "Unexpected non-generated collection skill";
			throw new SkillzeroError(`${message}: ${skillFile}`);
		}

		generatedIds.push(entry.name);
	}

	return generatedIds;
}

function allInventorySkills(inventory: SkillInventory): SkillRecord[] {
	return [...inventory.activeSkills, ...inventory.managedSkills];
}

async function validateCollectionDestinations(plan: CollectionPlan): Promise<void> {
	for (const collection of plan.finalCollections) {
		const directory = collectionDirectoryPath(plan.indexSkillPath, collection.id);
		const directoryKind = await getPathKind(directory);
		if (directoryKind !== "missing" && directoryKind !== "directory") {
			throw new SkillzeroError(`Path conflict: ${directory} must be a directory.`);
		}

		const skillFile = collectionSkillFilePath(plan.indexSkillPath, collection.id);
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

export async function buildCollectionPlan(
	inventory: SkillInventory,
	finalManagedSkills: SkillRecord[],
	collections = inventory.collections,
): Promise<CollectionPlan> {
	// A collection only describes the final non-top-level set. Restored skills are
	// removed from its assignment list while the collection itself remains editable.
	const knownIds = new Set(allInventorySkills(inventory).map((skill) => skill.id));
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
	const normalizedCollections = finalCollections.map(normalizeCollection);
	// Plans carry the exact bytes they validate. Applying a confirmed plan must
	// not rerun rendering against domain records that a caller could mutate.
	const collectionConfigContent = `${JSON.stringify({ version: 1, collections: normalizedCollections }, null, 2)}\n`;
	const collectionSkillFiles = normalizedCollections.map((collection) => ({
		path: collectionSkillFilePath(inventory.indexSkillPath, collection.id),
		content: generateCollectionSkill(collection, finalManagedSkills, inventory.indexSkillPath),
	}));
	const plan: CollectionPlan = {
		indexSkillPath: inventory.indexSkillPath,
		collectionsPath: collectionsPath(inventory.indexSkillPath),
		collectionConfigFile: collectionConfigPath(inventory.indexSkillPath),
		collectionConfigContent,
		collectionSkillFiles,
		finalCollections: normalizedCollections,
		generatedCollectionIdsToRemove: inventory.generatedCollectionIds
			.filter((id) => !collectionIds.has(id))
			.sort((left, right) => left.localeCompare(right)),
		collectionsChanged: false,
	};

	await validateCollectionDestinations(plan);
	let collectionsChanged = await hasDifferentFileContent(
		plan.collectionConfigFile,
		plan.collectionConfigContent,
	);

	if (!collectionsChanged) {
		for (const file of plan.collectionSkillFiles) {
			if (await hasDifferentFileContent(file.path, file.content)) {
				collectionsChanged = true;
				break;
			}
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
	indexSkillPath: string,
	skill: SkillRecord,
): string {
	return path
		.relative(collectionDirectoryPath(indexSkillPath, collection.id), skill.skillFile)
		.split(path.sep)
		.join("/");
}

export function generateCollectionSkill(
	collection: SkillCollection,
	skills: SkillRecord[],
	indexSkillPath: string,
): string {
	const collectionSkillIds = new Set(collection.skillIds);
	const rows = skills
		.filter((skill) => collectionSkillIds.has(skill.id))
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((skill) => {
			const sourcePath = relativeSkillPath(collection, indexSkillPath, skill);
			return `| \`${markdownTableCell(skill.id)}\` | ${markdownTableCell(skill.description)} | \`${sourcePath}\` |`;
		});
	const tableRows =
		rows.length > 0
			? rows.join("\n")
			: "| _No skills assigned_ | Assign managed skills to this collection. | _None_ |";

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
			? `- ${EMOJI.collection} Update collections.json with ${plan.finalCollections.length} collection(s).`
			: `- ${EMOJI.collection} No update to collections.`,
	];
	for (const collection of plan.finalCollections) {
		lines.push(
			`- ${EMOJI.collection} Collection ${collection.title}: ${collection.skillIds.length} managed skill(s).`,
		);
	}
	for (const id of plan.generatedCollectionIdsToRemove) {
		lines.push(`- ${EMOJI.remove}  Remove generated collection: ${id}`);
	}
	return lines.join("\n");
}

export async function applyCollectionPlan(plan: CollectionPlan): Promise<void> {
	await mkdir(plan.collectionsPath, { recursive: true });

	for (const file of plan.collectionSkillFiles) {
		await mkdir(path.dirname(file.path), { recursive: true });
		await writeFile(file.path, file.content, "utf8");
	}

	for (const collectionId of plan.generatedCollectionIdsToRemove) {
		const skillFile = collectionSkillFilePath(plan.indexSkillPath, collectionId);
		const kind = await getPathKind(skillFile);
		if (kind === "missing") {
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
	}

	await writeFile(
		plan.collectionConfigFile,
		plan.collectionConfigContent,
		"utf8",
	);
}
