import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyCollectionPlan } from "./collections.js";
import type { MovePlan } from "./types.js";

export async function applyMoveOperations(plan: MovePlan): Promise<void> {
	// Plans validate every source and destination before this point. Keeping the
	// move loop separate lets the temporary handoff reuse the same safe moves
	// without recreating a public skill-index during an upstream `skills` run.
	for (const operation of plan.operations) {
		await mkdir(path.dirname(operation.to), { recursive: true });
		if (operation.kind === "move-to-index") {
			// Rename before moving auto-invocable skills so their nested file is
			// never visible as a discoverable SKILL.md in the managed tree.
			const movedSkillFile = path.join(operation.from, path.basename(operation.toSkillFile));
			if (movedSkillFile !== operation.fromSkillFile) {
				await rename(operation.fromSkillFile, movedSkillFile);
			}
			await rename(operation.from, operation.to);
			continue;
		}

		await rename(operation.from, operation.to);
		const movedSkillFile = path.join(operation.to, path.basename(operation.fromSkillFile));
		if (movedSkillFile !== operation.toSkillFile) {
			await rename(movedSkillFile, operation.toSkillFile);
		}
	}
}

export async function applyMovePlan(plan: MovePlan): Promise<void> {
	await mkdir(plan.managedSkillsPath, { recursive: true });
	await applyMoveOperations(plan);

	await mkdir(plan.indexSkillPath, { recursive: true });
	// Finish nested generated files before publishing the outer index so readers
	// never observe a partially applied layout after a successful operation.
	await applyCollectionPlan(plan.collectionPlan);
	await writeFile(
		plan.indexSkillFile,
		plan.indexContent,
		"utf8",
	);
}
