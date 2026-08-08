export class SkillzeroError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillzeroError";
	}
}
