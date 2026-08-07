import { describe, expect, it } from "vitest";

import { parseSkillMetadata } from "../src/metadata.js";

describe("parseSkillMetadata", () => {
  it("reads name and description from frontmatter", () => {
    const metadata = parseSkillMetadata(
      `---
name: API Builder
description: Build and review API contracts.
---

# API Builder
`,
      "api-builder",
    );

    expect(metadata).toEqual({
      title: "API Builder",
      description: "Build and review API contracts.",
      disableModelInvocation: false,
    });
  });

  it("falls back to a human title and first useful body line", () => {
    const metadata = parseSkillMetadata(
      `# Testing Skill

Use this skill for focused test placement.
`,
      "test-placement",
    );

    expect(metadata).toEqual({
      title: "Test Placement",
      description: "Use this skill for focused test placement.",
      disableModelInvocation: false,
    });
  });
});
