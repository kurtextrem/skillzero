import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function run(command, args, cwd = repositoryRoot) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			const result = {
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			};
			if (code === 0) {
				resolve(result);
				return;
			}
			reject(
				new Error(
					`${command} ${args.join(" ")} exited with ${code}\n${result.stdout}${result.stderr}`,
				),
			);
		});
	});
}

function readPackResult(output) {
	const results = JSON.parse(output);
	if (!Array.isArray(results) || results.length !== 1 || typeof results[0] !== "object") {
		throw new Error("Expected npm pack to return exactly one package");
	}
	return results[0];
}

function assertPackedFiles(packResult) {
	// skillzero is an executable package, so its public tarball contains one
	// self-contained JavaScript file and the metadata required by npm.
	const expectedFiles = new Set(["LICENSE", "README.md", "dist/index.js", "package.json"]);

	const actualFiles = new Set(packResult.files.map((file) => file.path));
	const missing = [...expectedFiles].filter((file) => !actualFiles.has(file));
	const unexpected = [...actualFiles].filter((file) => !expectedFiles.has(file));
	if (missing.length > 0 || unexpected.length > 0) {
		throw new Error(
			`Packed files do not match the CLI release contract. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
		);
	}
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skillzero-package-"));
try {
	await run("aube", ["run", "build"]);
	// npm is the production publisher, so this must exercise npm's manifest
	// normalization instead of relying on another package manager's pack behavior.
	const dryRun = await run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"]);
	assertPackedFiles(readPackResult(dryRun.stdout));

	const packed = readPackResult(
		(
			await run("npm", [
				"pack",
				// A parent `npm publish --dry-run` exports its setting to child npm
				// commands; this step needs a real temporary tarball to test installation.
				"--dry-run=false",
				"--ignore-scripts",
				"--json",
				"--pack-destination",
				temporaryRoot,
			])
		).stdout,
	);
	const tarballPath = path.isAbsolute(packed.filename)
		? packed.filename
		: path.join(temporaryRoot, packed.filename);
	await access(tarballPath);

	const installRoot = path.join(temporaryRoot, "install");
	await mkdir(installRoot);
	await writeFile(
		path.join(installRoot, "package.json"),
		`${JSON.stringify({ name: "skillzero-package-smoke", private: true }, null, 2)}\n`,
	);
	await run("aube", ["add", "--no-save", pathToFileURL(tarballPath).href], installRoot);

	const executableName = process.platform === "win32" ? "skillzero.cmd" : "skillzero";
	const executablePath = path.join(installRoot, "node_modules", ".bin", executableName);
	await access(executablePath);
	const help = await run(executablePath, ["--help"], installRoot);
	if (!help.stdout.includes("skillzero")) {
		throw new Error("Installed CLI help did not identify skillzero");
	}

	const packageManifest = JSON.parse(
		await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
	);
	const version = await run(executablePath, ["--version"], installRoot);
	if (!version.stdout.includes(packageManifest.version)) {
		throw new Error(`Installed CLI did not report version ${packageManifest.version}`);
	}

	const skillsRoot = path.join(temporaryRoot, "skills");
	const fixtureSkill = path.join(skillsRoot, "package-smoke");
	await mkdir(fixtureSkill, { recursive: true });
	await writeFile(
		path.join(fixtureSkill, "SKILL.md"),
		"---\ndescription: Verify the installed skillzero package.\n---\n",
	);
	await run(executablePath, [skillsRoot, "--dry-run", "--yes"], installRoot);

	console.log(`Verified ${packed.filename}: contents, install, help, version, and dry run.`);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
