import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { collectionConfigPath, collectionDirectoryPath, collectionsPath } from "./collections.js";
import { GENERATED_MARKER, SKILL_FILE_NAME } from "./constants.js";
import { SkillzeroError } from "./errors.js";
import { clearRedoState, readRedoState, writeRedoState } from "./history.js";
import {
	applyManagedSkillsPlan,
	buildManagedSkillsPlan,
	formatManagedSkillsPlan,
	readManagedSkillsState,
} from "./managed-skills.js";
import { getPathKind, removeEmptyDirectory } from "./fs-utils.js";
import { EMOJI } from "./ui.js";

import type { RedoState } from "./history.js";
import type { ManagedSkillsPlan } from "./managed-skills.js";
import type { SkillCollection, SkillInventory } from "./types.js";

export interface UndoPlan {
	redoState: RedoState;
	managedSkillsPlan: ManagedSkillsPlan;
}

function skillIds(inventory: SkillInventory): string[] {
	return inventory.skills.map((skill) => skill.id).sort((left, right) => left.localeCompare(right));
}

function filterCollections(
	collections: SkillCollection[],
	availableIds: Set<string>,
): SkillCollection[] {
	// A skill deleted while the layout was undone should stay deleted instead
	// of preventing every other remembered skill from being restored.
	return collections.map((collection) => ({
		...collection,
		skillIds: collection.skillIds.filter((skillId) => availableIds.has(skillId)),
	}));
}

function hasSkillzeroLayout(inventory: SkillInventory, stateExists: boolean): boolean {
	return (
		inventory.collections.length > 0 ||
		inventory.generatedCollectionIds.length > 0 ||
		stateExists
	);
}

export async function buildUndoPlan(inventory: SkillInventory): Promise<UndoPlan> {
	const state = await readManagedSkillsState(inventory);
	if (!hasSkillzeroLayout(inventory, state !== null)) {
		throw new SkillzeroError("No skillzero changes found in " + inventory.rootPath + ".");
	}

	const redoState: RedoState = {
		version: 3,
		managedIds: state?.skills.map((skill) => skill.id) ?? [],
		collections: inventory.collections,
	};
	// Undo deliberately builds an empty collection plan so stale memberships do
	// not block restoring metadata and removing all generated artifacts.
	const managedSkillsPlan = await buildManagedSkillsPlan(
		inventory,
		[],
		state,
		[],
	);
	return { redoState, managedSkillsPlan };
}

export async function buildRedoPlan(inventory: SkillInventory): Promise<ManagedSkillsPlan> {
	const state = await readRedoState(inventory.rootPath);
	if (state === null) {
		throw new SkillzeroError("No skillzero undo is waiting to redo in " + inventory.rootPath + ".");
	}
	if (await readManagedSkillsState(inventory)) {
		throw new SkillzeroError("Skills are already configured in " + inventory.rootPath + ".");
	}

	const availableIds = new Set(skillIds(inventory));
	const managedIds = state.managedIds.filter((id) => availableIds.has(id));
	const collections = filterCollections(state.collections, new Set(managedIds));
	return buildManagedSkillsPlan(inventory, managedIds, null, collections);
}

async function removeGeneratedFile(filePath: string, label: string): Promise<void> {
	const kind = await getPathKind(filePath);
	if (kind === "missing") {
		return;
	}
	if (kind !== "file") {
		throw new SkillzeroError("Path conflict: generated " + label + " must be a file: " + filePath);
	}

	const content = await readFile(filePath, "utf8");
	if (!content.includes(GENERATED_MARKER)) {
		throw new SkillzeroError("Refusing to remove non-generated " + label + ": " + filePath);
	}
	await rm(filePath);
}

async function removeGeneratedArtifacts(plan: ManagedSkillsPlan): Promise<void> {
	// Only recognized generated files are removed. Extra user files under the
	// reserved generated directory intentionally leave that directory in place.
	const generatedPath = plan.collectionPlan.generatedPath;
	const generatedCollectionIds = plan.collectionPlan.generatedCollectionIdsToRemove;
	for (const collectionId of generatedCollectionIds) {
		const skillFile = path.join(
			collectionDirectoryPath(generatedPath, collectionId),
			SKILL_FILE_NAME,
		);
		await removeGeneratedFile(skillFile, "collection skill");
	}

	const configFile = collectionConfigPath(generatedPath);
	const configKind = await getPathKind(configFile);
	if (configKind === "file") {
		await rm(configFile);
	} else if (configKind !== "missing") {
		throw new SkillzeroError("Path conflict: collection config must be a file: " + configFile);
	}

	for (const collectionId of generatedCollectionIds) {
		await removeEmptyDirectory(collectionDirectoryPath(generatedPath, collectionId));
	}
	await removeEmptyDirectory(collectionsPath(generatedPath));
	await removeEmptyDirectory(generatedPath);
}

export async function applyUndoPlan(plan: UndoPlan): Promise<void> {
	// Persist redo metadata before changing files so an interrupted undo still
	// has a deterministic recovery path.
	await writeRedoState(path.dirname(plan.managedSkillsPlan.stateFile), plan.redoState);
	await applyManagedSkillsPlan(plan.managedSkillsPlan);
	await removeGeneratedArtifacts(plan.managedSkillsPlan);
}

export async function applyRedoPlan(plan: ManagedSkillsPlan): Promise<void> {
	await applyManagedSkillsPlan(plan);
	await clearRedoState(path.dirname(plan.stateFile));
}

export function formatUndoPlan(plan: UndoPlan): string {
	const lines = [`${EMOJI.restore}  Undo changes:`];
	for (const operation of plan.managedSkillsPlan.operations) {
		lines.push(`- ${EMOJI.unlock}  Restore ${operation.label}: ${operation.id}`);
	}
	if (plan.managedSkillsPlan.operations.length === 0) {
		lines.push(`- ${EMOJI.info}  No skill metadata needs to be restored.`);
	}
	lines.push(`- ${EMOJI.remove}  Remove generated collection files.`);
	lines.push(`- ${EMOJI.redo}  Keep a redo record so the configuration can be restored.`);
	return lines.join("\n");
}

export function formatRedoPlan(plan: ManagedSkillsPlan): string {
	return [
		`${EMOJI.redo}  Redo changes:`,
		...formatManagedSkillsPlan(plan).split("\n").slice(1),
	].join("\n");
}
