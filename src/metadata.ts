import { readFile } from "node:fs/promises";
import matter from "gray-matter";

import type { SkillOrigin, SkillRecord } from "./types.js";

function readStringField(data: unknown, fieldName: string): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const value = Reflect.get(data, fieldName);
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function firstUsefulBodyLine(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
      continue;
    }

    return trimmed;
  }

  return null;
}

export interface ParsedSkillMetadata {
  title: string;
  description: string;
}

export function parseSkillMetadata(content: string, fallbackId: string): ParsedSkillMetadata {
  const parsed = matter(content);
  const title = readStringField(parsed.data, "name") ?? titleFromId(fallbackId);

  // The description is the only part the outer index exposes to agents, so use
  // frontmatter when available and fall back to the first real body sentence.
  const description =
    readStringField(parsed.data, "description") ??
    firstUsefulBodyLine(parsed.content) ??
    "No description provided.";

  return { title, description };
}

export async function readSkillRecord(
  id: string,
  directory: string,
  skillFile: string,
  origin: SkillOrigin,
): Promise<SkillRecord> {
  const content = await readFile(skillFile, "utf8");
  const metadata = parseSkillMetadata(content, id);
  return {
    id,
    title: metadata.title,
    description: metadata.description,
    directory,
    skillFile,
    origin,
  };
}
