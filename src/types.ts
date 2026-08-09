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

export interface SkillInventory {
	rootPath: string;
	generatedPath: string;
	skills: SkillRecord[];
	collections: SkillCollection[];
	generatedCollectionIds: string[];
}
