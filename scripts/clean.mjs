import { rm } from "node:fs/promises";

// TypeScript does not remove outputs for deleted source files, so every release
// build starts empty to keep retired modules out of the published tarball.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
