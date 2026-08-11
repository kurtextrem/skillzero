import { defineConfig } from "tsdown";

export default defineConfig({
	entry: "src/index.ts",
	format: "esm",
	platform: "node",
	fixedExtension: false,
	dts: false,
	sourcemap: false,
	deps: {
		// The npm package is a standalone CLI artifact: bundle every build-time
		// dependency and reject package imports left in the emitted executable.
		onlyBundle: false,
		onlyImport: [],
	},
});
