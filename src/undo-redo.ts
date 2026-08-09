import { SkillzeroError } from "./errors.js";
import { clearRedoState, readRedoState, writeRedoState } from "./history.js";
import {
	applyManagedSkillsPlan,
	buildManagedSkillsPlan,
	formatManagedSkillsPlan,
} from "./managed-skills.js";
import { EMOJI } from "./ui.js";

import type { RedoState } from "./history.js";
import type { ManagedSkillsPlan } from "./managed-skills.js";
import type { SkillCollection, SkillInventory } from "./types.js";

export interface UndoPlan {
	redoState: RedoState;
	managedSkillsPlan: ManagedSkillsPlan;
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

export async function buildUndoPlan(inventory: SkillInventory): Promise<UndoPlan> {
	const state = inventory.state;
	if (
		state === null &&
		inventory.collections.length === 0 &&
		inventory.generatedCollectionIds.length === 0
	) {
		throw new SkillzeroError("No skillzero changes found in " + inventory.rootPath + ".");
	}

	const visibleIds = new Set(
		inventory.collections.flatMap((collection) => collection.skillIds),
	);
	const redoState: RedoState = {
		version: 1,
		hiddenIds: (state?.skills ?? [])
			.map((skill) => skill.id)
			.filter((id) => !visibleIds.has(id)),
		collections: inventory.collections,
	};
	// Undo deliberately builds an empty collection plan so stale memberships do
	// not block restoring metadata and removing all generated artifacts.
	const managedSkillsPlan = await buildManagedSkillsPlan(
		inventory,
		[],
		state,
		[],
		[],
	);
	return { redoState, managedSkillsPlan };
}

export async function buildRedoPlan(inventory: SkillInventory): Promise<ManagedSkillsPlan> {
	const state = await readRedoState(inventory.rootPath);
	if (state === null) {
		throw new SkillzeroError("No skillzero undo is waiting to redo in " + inventory.rootPath + ".");
	}
	if (inventory.state !== null) {
		throw new SkillzeroError("Skills are already configured in " + inventory.rootPath + ".");
	}

	const availableIds = new Set(inventory.skills.map((skill) => skill.id));
	const hiddenIds = state.hiddenIds.filter((id) => availableIds.has(id));
	const collections = filterCollections(state.collections, availableIds);
	return buildManagedSkillsPlan(inventory, hiddenIds, null, collections);
}

export async function applyUndoPlan(plan: UndoPlan): Promise<void> {
	// Persist redo metadata before changing files so an interrupted undo still
	// has a deterministic recovery path.
	await writeRedoState(plan.managedSkillsPlan.rootPath, plan.redoState);
	await applyManagedSkillsPlan(plan.managedSkillsPlan);
}

export async function applyRedoPlan(plan: ManagedSkillsPlan): Promise<void> {
	await applyManagedSkillsPlan(plan);
	await clearRedoState(plan.rootPath);
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
