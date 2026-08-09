export interface DiscoveredSkillsRoot {
	// `path` preserves the first usable user-facing path, while `realPath` lets
	// discovery collapse aliases such as .agents/skills -> .claude/skills.
	path: string;
	realPath: string;
	aliases: string[];
}

export interface SkillRecord {
	id: string;
	description: string;
	disableModelInvocation: boolean;
	openAiImplicitInvocationDisabled: boolean;
	skillFile: string;
}

export interface SkillCollection {
	id: string;
	title: string;
	description: string;
	skillIds: string[];
}

export type OriginalModelInvocation = boolean | null;

export interface FrontmatterState {
	originalValue: OriginalModelInvocation;
	appliedContentHash: string;
}

export interface CodexMetadataState {
	originalContent: string | null;
	appliedContentHash: string;
}

export interface ManagedSkillState {
	id: string;
	// Missing restoration data means the skill author already owned the desired
	// value. State only records metadata skillzero must be able to put back.
	frontmatter?: FrontmatterState;
	codex?: CodexMetadataState;
}

export interface SkillzeroState {
	version: 1;
	// Discovery history is independent from ownership so an unmanaged skill is
	// announced once without being pulled into the managed set.
	knownIds: string[];
	skills: ManagedSkillState[];
	collections: SkillCollection[];
}

export interface SkillInventory {
	rootPath: string;
	generatedPath: string;
	skills: SkillRecord[];
	state: SkillzeroState | null;
	// Callers may repair stale memberships before building a plan, so the
	// working collection set stays separate from the persisted state snapshot.
	collections: SkillCollection[];
	generatedCollectionIds: string[];
}
