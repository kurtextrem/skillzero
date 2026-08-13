import * as p from "@clack/prompts";

import {
	collectionDescriptionInput,
	collectionIdFromTitle,
	collectionSkillIds,
	formatCollectionDescription,
} from "./collections.js";
import { SkillzeroError } from "./errors.js";
import { promptVisibleMultiselect } from "./multiselect.js";
import { dim, EMOJI } from "./ui.js";

import type { SkillCollection, SkillInventory, SkillRecord } from "./types.js";

// ASCII badges keep selector state monochrome and stable across terminal emoji palettes.
const HIDDEN_MARKER = "[H]";
const INCOMPLETE_MARKER = "[!]";

type CollectionsResult = { status: "ok"; collections: SkillCollection[] } | { status: "cancelled" };

type CollectionResult = { status: "ok"; collection: SkillCollection } | { status: "cancelled" };

type CollectionAction = "add" | "edit" | "remove" | "done";

type CollectionRepairResult =
	| { status: "ok"; inventory: SkillInventory }
	| { status: "cancelled" }
	| { status: "declined" };

export function reportNewSkills(inventory: SkillInventory, knownIds: Iterable<string>): string[] {
	const known = new Set(knownIds);
	const newSkills = inventory.skills.filter((skill) => !known.has(skill.id));
	if (newSkills.length === 0) {
		return [];
	}

	const lines = ["These skills were found since the last sync:"];
	for (const skill of newSkills) {
		lines.push(`- ${skill.id} — ${shortDescription(skill.id, skill.description)}`);
	}
	p.note(lines.join("\n"), `${EMOJI.new} New skills found`);
	return newSkills.map((skill) => skill.id);
}

/** Choose ownership first; the collection editor then splits it into visible and hidden skills. */
export function chooseManagedSkills(
	inventory: SkillInventory,
	message: string,
	selectedIds: string[],
	managedIds: ReadonlySet<string>,
) {
	const options = pickerOptions(inventory.skills, (skill) => ({
		hint: collectionHint(skill, inventory.collections),
		managed: managedIds.has(skill.id),
	}));

	return promptVisibleMultiselect({
		message: `${message}\n${dim(`${HIDDEN_MARKER} hidden to model · ${EMOJI.collection} collection`)}`,
		options,
		initialValues: selectedIds,
		required: false,
	});
}

export function keepManagedSkills(
	collections: SkillCollection[],
	managedIds: ReadonlySet<string>,
): SkillCollection[] {
	const retainedCollections: SkillCollection[] = [];
	for (const collection of collections) {
		const skillIds = collection.skillIds.filter((skillId) => managedIds.has(skillId));
		// A collection without managed skills cannot route to anything. Removing it
		// here lets collection planning delete its generated skill and preview that change.
		if (skillIds.length > 0) {
			retainedCollections.push({ ...collection, skillIds });
		}
	}
	return retainedCollections;
}

/** Edit copies so cancellation cannot alter the scanned inventory. */
export async function editCollections(
	skills: SkillRecord[],
	initialCollections: SkillCollection[],
	initialAction: "add" | "done" = "done",
): Promise<CollectionsResult> {
	let collections = initialCollections.map((collection) => ({
		...collection,
		skillIds: [...collection.skillIds],
	}));
	let defaultAction: CollectionAction = initialAction;

	while (true) {
		const action = await p.select<CollectionAction>({
			message: `${EMOJI.collection} Configure skill collections`,
			initialValue: defaultAction,
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
		// First-time setup starts on Add; every subsequent pass should make
		// accepting the current collection configuration the shortest path.
		defaultAction = "done";

		if (action === "done") {
			return { status: "ok", collections };
		}

		if (action === "add") {
			const result = await editCollection(null, collections, skills);
			if (result.status === "cancelled") {
				return result;
			}
			collections = [...collections, result.collection];
			continue;
		}

		const selectedId = await p.select<string>({
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
		if (p.isCancel(selectedId)) {
			return { status: "cancelled" };
		}

		const selected = collections.find((collection) => collection.id === selectedId);
		if (!selected) {
			throw new SkillzeroError(`Unknown collection: ${selectedId}`);
		}

		if (action === "edit") {
			const result = await editCollection(selected, collections, skills);
			if (result.status === "cancelled") {
				return result;
			}
			collections = collections.map((collection) =>
				collection.id === selectedId ? result.collection : collection,
			);
			continue;
		}

		const shouldRemove = await p.confirm({
			message: `${EMOJI.warning} Remove collection ${selected.title}?`,
			initialValue: false,
		});
		if (p.isCancel(shouldRemove)) {
			return { status: "cancelled" };
		}
		if (shouldRemove) {
			collections = collections.filter((collection) => collection.id !== selectedId);
		}
	}
}

/** Drop stale memberships only after the caller's confirmation policy allows it. */
export async function repairCollections(
	inventory: SkillInventory,
	autoConfirm: boolean,
): Promise<CollectionRepairResult> {
	const availableIds = new Set(inventory.skills.map((skill) => skill.id));
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
		if (!autoConfirm) {
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

		const unknown = new Set(unknownIds);
		collections = collections.map((candidate) =>
			candidate.id === collection.id
				? {
						...candidate,
						skillIds: candidate.skillIds.filter((skillId) => !unknown.has(skillId)),
					}
				: candidate,
		);
	}

	return {
		status: "ok",
		inventory: collections === inventory.collections ? inventory : { ...inventory, collections },
	};
}

async function editCollection(
	existing: SkillCollection | null,
	collections: SkillCollection[],
	skills: SkillRecord[],
): Promise<CollectionResult> {
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
			message: "Model should use when:",
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
		const selected = await promptVisibleMultiselect({
			message: `Skills in ${title}`,
			options: pickerOptions(skills, (skill) => ({
				hint: collectionHint(skill, collections, existing?.id ?? null),
				managed: true,
			})),
			initialValues,
			required: false,
		});
		if (selected.status === "cancelled") {
			return selected;
		}

		return {
			status: "ok",
			collection: {
				id,
				title: title.trim(),
				description: formatCollectionDescription(description),
				skillIds: selected.selectedIds,
			},
		};
	}
}

function pickerOptions(
	skills: readonly SkillRecord[],
	stateForSkill: (skill: SkillRecord) => {
		hint: string | undefined;
		managed: boolean;
	},
) {
	// Annotate only author-owned metadata; managed rows already state their role.
	return [...skills]
		.sort(
			(left, right) => metadataRank(left) - metadataRank(right) || left.id.localeCompare(right.id),
		)
		.map((skill) => {
			const state = stateForSkill(skill);
			let annotation: string | undefined;
			if (!state.managed) {
				if (skill.disableModelInvocation && skill.openAiImplicitInvocationDisabled) {
					annotation = HIDDEN_MARKER;
				} else if (skill.disableModelInvocation) {
					annotation = `${INCOMPLETE_MARKER} lacks OpenAI policy`;
				} else if (skill.openAiImplicitInvocationDisabled) {
					annotation = `${INCOMPLETE_MARKER} lacks disable-model-invocation`;
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

function metadataRank(skill: SkillRecord): number {
	if (skill.disableModelInvocation && skill.openAiImplicitInvocationDisabled) {
		return 3;
	}
	if (skill.openAiImplicitInvocationDisabled) {
		return 2;
	}
	return skill.disableModelInvocation ? 1 : 0;
}

function collectionHint(
	skill: SkillRecord,
	collections: SkillCollection[],
	excludedId: string | null = null,
): string | undefined {
	// The checkbox shows current membership, so an edit only lists other groups.
	const titles = collections
		.filter((collection) => collection.id !== excludedId && collection.skillIds.includes(skill.id))
		.map((collection) => collection.title);
	return titles.length > 0 ? `${EMOJI.collection} ${titles.join(", ")}` : undefined;
}

function shortDescription(id: string, description: string): string {
	const firstLine =
		description
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0)
			?.replace(/^[-*]\s+/, "") ?? "No description provided.";
	const text = firstLine.replace(/\s+/g, " ");
	const maxLength = Math.max(20, (process.stdout.columns ?? 80) - id.length - 11);
	if (text.length <= maxLength) {
		return text;
	}

	const suffix = "...";
	return `${text.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
}
