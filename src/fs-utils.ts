import { readFile, rmdir, stat } from "node:fs/promises";

export type PathKind = "missing" | "file" | "directory" | "other";

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function getPathKind(filePath: string): Promise<PathKind> {
	try {
		const details = await stat(filePath);
		if (details.isDirectory()) {
			return "directory";
		}

		if (details.isFile()) {
			return "file";
		}

		return "other";
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return "missing";
		}

		throw error;
	}
}

export async function hasDifferentFileContent(
	filePath: string,
	expectedContent: string,
): Promise<boolean> {
	const kind = await getPathKind(filePath);
	if (kind !== "file") {
		// Callers validate destination conflicts before comparing generated files;
		// missing files are changes, while invalid paths are handled there.
		return true;
	}

	return (await readFile(filePath, "utf8")) !== expectedContent;
}

export async function removeEmptyDirectory(directory: string): Promise<void> {
	try {
		await rmdir(directory);
	} catch (error) {
		// Empty-directory cleanup is opportunistic. Missing or non-empty paths are
		// already valid final states, while permission and type errors must surface.
		if (
			hasErrorCode(error, "ENOENT") ||
			hasErrorCode(error, "ENOTEMPTY") ||
			hasErrorCode(error, "EEXIST")
		) {
			return;
		}

		throw error;
	}
}
