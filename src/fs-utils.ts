import { access, stat } from "node:fs/promises";

export type PathKind = "missing" | "file" | "directory" | "other";

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
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
