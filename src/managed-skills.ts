import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "@11ty/gray-matter";

import {
	CODEX_METADATA_DIR_NAME,
	CODEX_METADATA_FILE_NAME,
	DISABLE_MODEL_INVOCATION_FIELD,
} from "./constants.js";
import {
	applyCollectionPlan,
	buildCollectionPlan,
	formatCollectionPlan,
	type CollectionPlan,
} from "./collections.js";
import { SkillzeroError } from "./errors.js";
import { getPathKind, removeEmptyDirectory } from "./fs-utils.js";
import { readOpenAiImplicitInvocation } from "./scanner.js";
import { skillzeroStatePath } from "./state.js";
import { estimateSavedTokens } from "./tokens.js";
import { EMOJI } from "./ui.js";

import type {
	CodexMetadataState,
	FrontmatterState,
	ManagedSkillState,
	OriginalModelInvocation,
	SkillCollection,
	SkillInventory,
	SkillRecord,
	SkillzeroState,
} from "./types.js";

interface MetadataOperationBase {
	id: string;
	label: "disable-model-invocation" | "OpenAI policy";
	filePath: string;
}

// The operation shape carries only fields that its apply branch can use, so a
// malformed plan cannot defer a missing-content failure until after confirmation.
export type MetadataOperation =
	| (MetadataOperationBase & {
			kind: "write";
			expectedContentHash: string | null;
			content: string;
	  })
	| (MetadataOperationBase & {
			kind: "remove";
			expectedContentHash: string;
	  });

export interface ManagedSkillsPlan {
	// Redo survives removal of the generated tree, so callers need the skills
	// root separately from the active state file nested below it.
	rootPath: string;
	stateFile: string;
	finalManagedSkills: SkillRecord[];
	finalHiddenSkills: SkillRecord[];
	operations: MetadataOperation[];
	nextState: SkillzeroState | null;
	stateChanged: boolean;
	collectionPlan: CollectionPlan;
}

function codexMetadataPath(skill: SkillRecord): string {
	return path.join(
		path.dirname(skill.skillFile),
		CODEX_METADATA_DIR_NAME,
		CODEX_METADATA_FILE_NAME,
	);
}

function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function readDisableModelInvocation(content: string, skillFile: string): OriginalModelInvocation {
	let parsed: ReturnType<typeof matter>;
	try {
		parsed = matter(content);
	} catch {
		throw new SkillzeroError(`Invalid SKILL.md frontmatter: ${skillFile}`);
	}

	const value = parsed.data[DISABLE_MODEL_INVOCATION_FIELD];
	if (value === undefined) {
		return null;
	}
	if (typeof value !== "boolean") {
		throw new SkillzeroError(
			`${DISABLE_MODEL_INVOCATION_FIELD} must be true or false: ${skillFile}`,
		);
	}

	return value;
}

interface FrontmatterBounds {
	openingEnd: number;
	closingStart: number;
	lineEnding: string;
}

function frontmatterBounds(content: string): FrontmatterBounds | null {
	const firstNewline = content.indexOf("\n");
	const firstLineEnd = firstNewline === -1 ? content.length : firstNewline;
	const firstLine = content.slice(0, firstLineEnd).replace(/\r$/, "");
	if (!/^\uFEFF?---[ \t]*$/.test(firstLine)) {
		return null;
	}

	const openingEnd = firstNewline === -1 ? content.length : firstNewline + 1;
	const lineEnding = content.slice(0, openingEnd).endsWith("\r\n") ? "\r\n" : "\n";
	let lineStart = openingEnd;

	while (lineStart < content.length) {
		const nextNewline = content.indexOf("\n", lineStart);
		const lineEnd = nextNewline === -1 ? content.length : nextNewline;
		const line = content.slice(lineStart, lineEnd).replace(/\r$/, "");
		if (/^(---|\.\.\.)[ \t]*$/.test(line)) {
			return { openingEnd, closingStart: lineStart, lineEnding };
		}

		if (nextNewline === -1) {
			break;
		}
		lineStart = nextNewline + 1;
	}

	throw new SkillzeroError("SKILL.md frontmatter is missing its closing delimiter.");
}

const DISABLE_MODEL_INVOCATION_LINE =
	/^(?:"disable-model-invocation"|'disable-model-invocation'|disable-model-invocation):[^\r\n]*(?:\r?\n|$)/m;

// Skills are user-authored documents. Rewriting only the policy line avoids
// unrelated YAML formatting churn when skillzero changes their invocation mode.
function withDisableModelInvocation(content: string, value: OriginalModelInvocation): string {
	const bounds = frontmatterBounds(content);
	if (bounds === null) {
		if (value === null) {
			return content;
		}

		const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
		return `---${lineEnding}${DISABLE_MODEL_INVOCATION_FIELD}: ${value}${lineEnding}---${lineEnding}${content}`;
	}

	const frontmatter = content.slice(bounds.openingEnd, bounds.closingStart);
	const beforeFrontmatter = content.slice(0, bounds.openingEnd);
	const afterFrontmatter = content.slice(bounds.closingStart);
	const replacement =
		value === null ? "" : `${DISABLE_MODEL_INVOCATION_FIELD}: ${value}${bounds.lineEnding}`;

	if (DISABLE_MODEL_INVOCATION_LINE.test(frontmatter)) {
		return `${beforeFrontmatter}${frontmatter.replace(DISABLE_MODEL_INVOCATION_LINE, replacement)}${afterFrontmatter}`;
	}

	if (value === null) {
		return content;
	}

	return `${beforeFrontmatter}${frontmatter}${replacement}${afterFrontmatter}`;
}

/** Change only the policy field so user-authored YAML keeps its layout and comments. */
function disableCodexImplicitInvocation(content: string, filePath: string): string {
	const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
	const hasTrailingNewline = content.endsWith("\n");
	const lines = content.split(/\r?\n/);
	if (hasTrailingNewline) {
		lines.pop();
	}

	const blockPolicyIndex = lines.findIndex((line) => /^policy:[ \t]*(?:#.*)?$/.test(line));
	if (blockPolicyIndex !== -1) {
		let blockEnd = lines.length;
		for (let index = blockPolicyIndex + 1; index < lines.length; index += 1) {
			const line = lines[index] ?? "";
			if (line.trim().length > 0 && !line.trimStart().startsWith("#") && /^\S/.test(line)) {
				blockEnd = index;
				break;
			}
		}

		for (let index = blockPolicyIndex + 1; index < blockEnd; index += 1) {
			const line = lines[index] ?? "";
			const match = line.match(
				/^([ \t]+)allow_implicit_invocation:[ \t]*(?:true|false)([ \t]*(?:#.*)?)$/,
			);
			if (match) {
				lines[index] = `${match[1]}allow_implicit_invocation: false${match[2]}`;
				return `${lines.join(lineEnding)}${hasTrailingNewline ? lineEnding : ""}`;
			}
		}

		const firstPolicyEntry = lines
			.slice(blockPolicyIndex + 1, blockEnd)
			.find((line) => /^[ \t]+\S/.test(line));
		const indentation = firstPolicyEntry?.match(/^([ \t]+)/)?.[1] ?? "  ";
		lines.splice(blockPolicyIndex + 1, 0, `${indentation}allow_implicit_invocation: false`);
		return `${lines.join(lineEnding)}${hasTrailingNewline ? lineEnding : ""}`;
	}

	const inlinePolicyIndex = lines.findIndex((line) =>
		/^policy:[ \t]*\{.*\}[ \t]*(?:#.*)?$/.test(line),
	);
	if (inlinePolicyIndex !== -1) {
		const line = lines[inlinePolicyIndex] ?? "";
		if (/allow_implicit_invocation[ \t]*:/.test(line)) {
			lines[inlinePolicyIndex] = line.replace(
				/(allow_implicit_invocation[ \t]*:[ \t]*)(?:true|false)/,
				"$1false",
			);
		} else {
			lines[inlinePolicyIndex] = line.replace("{", "{ allow_implicit_invocation: false,");
		}
		return `${lines.join(lineEnding)}${hasTrailingNewline ? lineEnding : ""}`;
	}

	if (readOpenAiImplicitInvocation(content, filePath) !== null) {
		throw new SkillzeroError(`Unsupported Codex skill metadata policy layout: ${filePath}`);
	}

	const prefix =
		content.length === 0 || content.endsWith("\n") ? content : `${content}${lineEnding}`;
	return `${prefix}policy:${lineEnding}  allow_implicit_invocation: false${lineEnding}`;
}

function sortedState(
	skills: ManagedSkillState[],
	knownIds: Iterable<string>,
	collections: SkillCollection[],
): SkillzeroState | null {
	const knownIdSet = new Set(knownIds);
	for (const skill of skills) {
		knownIdSet.add(skill.id);
	}
	if (skills.length === 0 && knownIdSet.size === 0 && collections.length === 0) {
		return null;
	}

	return {
		version: 1,
		knownIds: [...knownIdSet].sort((left, right) => left.localeCompare(right)),
		skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
		collections,
	};
}

export async function buildManagedSkillsPlan(
	inventory: SkillInventory,
	hiddenIds: Iterable<string>,
	previousState: SkillzeroState | null,
	collections = inventory.collections,
	nextKnownIds: Iterable<string> = inventory.skills.map((skill) => skill.id),
): Promise<ManagedSkillsPlan> {
	// Hidden selection and collection membership are the only two ownership
	// inputs in v1. Derive their union here so callers cannot confuse discovery
	// with management.
	const managedIdSet = new Set(hiddenIds);
	for (const collection of collections) {
		for (const skillId of collection.skillIds) {
			managedIdSet.add(skillId);
		}
	}
	const skillsById = new Map(inventory.skills.map((skill) => [skill.id, skill]));
	const unknownIds = [...managedIdSet]
		.filter((id) => !skillsById.has(id))
		.sort((left, right) => left.localeCompare(right));
	if (unknownIds.length > 0) {
		throw new SkillzeroError(`Unknown managed skill names: ${unknownIds.join(", ")}`);
	}

	const previousById = new Map(previousState?.skills.map((skill) => [skill.id, skill]));
	const operations: MetadataOperation[] = [];
	const nextSkills: ManagedSkillState[] = [];
	const finalManagedSkills = inventory.skills.filter((skill) => managedIdSet.has(skill.id));

	for (const skill of finalManagedSkills) {
		const previous = previousById.get(skill.id);
		const skillContent = await readFile(skill.skillFile, "utf8");
		const skillHash = contentHash(skillContent);
		const currentFrontmatterValue = readDisableModelInvocation(skillContent, skill.skillFile);
		let frontmatterState: FrontmatterState | undefined;
		if (currentFrontmatterValue === true) {
			frontmatterState =
				previous?.frontmatter?.appliedContentHash === skillHash ? previous.frontmatter : undefined;
		} else {
			const updatedContent = withDisableModelInvocation(skillContent, true);
			operations.push({
				id: skill.id,
				kind: "write",
				label: "disable-model-invocation",
				filePath: skill.skillFile,
				expectedContentHash: skillHash,
				content: updatedContent,
			});
			frontmatterState = {
				originalValue: currentFrontmatterValue,
				appliedContentHash: contentHash(updatedContent),
			};
		}

		const codexFile = codexMetadataPath(skill);
		const codexFileKind = await getPathKind(codexFile);
		if (codexFileKind !== "missing" && codexFileKind !== "file") {
			throw new SkillzeroError(`Codex skill metadata must be a file: ${codexFile}`);
		}
		const codexContent = codexFileKind === "file" ? await readFile(codexFile, "utf8") : null;
		const codexHash = codexContent === null ? null : contentHash(codexContent);
		const currentCodexValue =
			codexContent === null ? null : readOpenAiImplicitInvocation(codexContent, codexFile);
		let codexState: CodexMetadataState | undefined;
		if (currentCodexValue === false) {
			codexState = previous?.codex?.appliedContentHash === codexHash ? previous.codex : undefined;
		} else {
			const updatedContent = disableCodexImplicitInvocation(codexContent ?? "", codexFile);
			operations.push({
				id: skill.id,
				kind: "write",
				label: "OpenAI policy",
				filePath: codexFile,
				expectedContentHash: codexHash,
				content: updatedContent,
			});
			codexState = {
				originalContent: codexContent,
				appliedContentHash: contentHash(updatedContent),
			};
		}

		const nextSkill: ManagedSkillState = { id: skill.id };
		if (frontmatterState) {
			nextSkill.frontmatter = frontmatterState;
		}
		if (codexState) {
			nextSkill.codex = codexState;
		}
		nextSkills.push(nextSkill);
	}

	for (const previous of previousById.values()) {
		if (managedIdSet.has(previous.id)) {
			continue;
		}

		const skill = skillsById.get(previous.id);
		if (!skill) {
			continue;
		}

		if (previous.frontmatter) {
			const content = await readFile(skill.skillFile, "utf8");
			if (contentHash(content) === previous.frontmatter.appliedContentHash) {
				operations.push({
					id: skill.id,
					kind: "write",
					label: "disable-model-invocation",
					filePath: skill.skillFile,
					expectedContentHash: previous.frontmatter.appliedContentHash,
					content: withDisableModelInvocation(content, previous.frontmatter.originalValue),
				});
			}
		}

		if (previous.codex) {
			const codexFile = codexMetadataPath(skill);
			if ((await getPathKind(codexFile)) === "file") {
				const content = await readFile(codexFile, "utf8");
				if (contentHash(content) === previous.codex.appliedContentHash) {
					if (previous.codex.originalContent === null) {
						operations.push({
							id: skill.id,
							kind: "remove",
							label: "OpenAI policy",
							filePath: codexFile,
							expectedContentHash: previous.codex.appliedContentHash,
						});
					} else {
						operations.push({
							id: skill.id,
							kind: "write",
							label: "OpenAI policy",
							filePath: codexFile,
							expectedContentHash: previous.codex.appliedContentHash,
							content: previous.codex.originalContent,
						});
					}
				}
			}
		}
	}

	finalManagedSkills.sort((left, right) => left.id.localeCompare(right.id));
	const collectionPlan = await buildCollectionPlan(inventory, finalManagedSkills, collections);
	const collectionSkillIds = new Set(
		collectionPlan.finalCollections.flatMap((collection) => collection.skillIds),
	);
	const finalHiddenSkills = finalManagedSkills.filter((skill) => !collectionSkillIds.has(skill.id));
	const nextState = sortedState(nextSkills, nextKnownIds, collectionPlan.finalCollections);
	// Sorted state makes byte comparison enough to skip no-op state writes.
	const stateChanged = JSON.stringify(previousState) !== JSON.stringify(nextState);
	return {
		rootPath: inventory.rootPath,
		stateFile: skillzeroStatePath(inventory.generatedPath),
		finalManagedSkills,
		finalHiddenSkills,
		operations,
		nextState,
		stateChanged,
		collectionPlan,
	};
}

export function formatManagedSkillsPlan(plan: ManagedSkillsPlan): string {
	const lines = [`${EMOJI.plan} Planned changes:`];

	for (const operation of plan.operations) {
		const verb =
			operation.kind === "remove"
				? `Remove skillzero's ${operation.label}`
				: operation.expectedContentHash === null
					? `Add ${operation.label}`
					: `Update ${operation.label}`;
		lines.push(
			`- ${operation.kind === "remove" ? EMOJI.unlock : EMOJI.lock} ${verb}: ${operation.id}`,
		);
	}

	if (plan.finalHiddenSkills.length > 0) {
		lines.push(`- ${EMOJI.ghost} Keep ${plan.finalHiddenSkills.length} skill(s) hidden.`);
	}
	lines.push(formatCollectionPlan(plan.collectionPlan));
	lines.push(
		`- ${EMOJI.new} Skillzero now saves ${estimateSavedTokens(plan.finalManagedSkills, plan.collectionPlan.finalCollections)} tokens for you.`,
	);
	return lines.join("\n");
}

export async function applyManagedSkillsPlan(plan: ManagedSkillsPlan): Promise<void> {
	// Validate the complete preview before writing so edits made at the
	// confirmation prompt cannot produce a partially applied metadata set.
	for (const operation of plan.operations) {
		const kind = await getPathKind(operation.filePath);
		if (operation.expectedContentHash === null) {
			if (kind !== "missing") {
				throw new SkillzeroError(
					`Metadata changed while waiting for confirmation: ${operation.filePath}`,
				);
			}
			continue;
		}
		if (kind !== "file") {
			throw new SkillzeroError(
				`Metadata changed while waiting for confirmation: ${operation.filePath}`,
			);
		}
		const content = await readFile(operation.filePath, "utf8");
		if (contentHash(content) !== operation.expectedContentHash) {
			throw new SkillzeroError(
				`Metadata changed while waiting for confirmation: ${operation.filePath}`,
			);
		}
	}

	for (const operation of plan.operations) {
		if (operation.kind === "remove") {
			await rm(operation.filePath);
			await removeEmptyDirectory(path.dirname(operation.filePath));
			continue;
		}

		await mkdir(path.dirname(operation.filePath), { recursive: true });
		await writeFile(operation.filePath, operation.content, "utf8");
	}

	if (plan.collectionPlan.collectionsChanged) {
		await applyCollectionPlan(plan.collectionPlan);
	}
	if (!plan.stateChanged) {
		return;
	}

	if (plan.nextState === null) {
		await rm(plan.stateFile, { force: true });
		await removeEmptyDirectory(path.dirname(plan.stateFile));
		return;
	}

	await mkdir(path.dirname(plan.stateFile), { recursive: true });
	await writeFile(plan.stateFile, `${JSON.stringify(plan.nextState, null, 2)}\n`, "utf8");
}
