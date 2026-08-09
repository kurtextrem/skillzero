import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createTempRoot(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "skillzero-"));
}

export async function writeSkill(rootPath: string, name: string, content: string): Promise<string> {
	const directory = path.join(rootPath, name);
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, "SKILL.md"), content, "utf8");
	return directory;
}
