import { CLI_NAME, CLI_VERSION } from "./constants.js";

type Color = "cyan" | "green" | "yellow" | "gray" | "white";

// Keep semantic markers consistent so the CLI feels lively without turning
// every line into decoration.
export const EMOJI = {
	active: "🟢",
	apply: "🚀",
	cancel: "❌",
	// Use a variation-selector-free glyph so Clack's preview borders stay aligned
	// in terminals that measure 🗂️ as one cell.
	collection: "📚",
	folder: "📁",
	ghost: "👻",
	// Use a stable two-cell emoji here; some terminals render the text/emoji
	// presentation of ℹ️ at one cell while Clack reserves two.
	info: "💡",
	index: "📝",
	link: "🔗",
	lock: "🔒",
	managed: "📦",
	new: "✨",
	plan: "📋",
	// Clack and terminals can disagree on variation-selector emoji width. These
	// actions use unambiguous one-cell symbols so every note keeps one border.
	remove: "×",
	redo: "↪",
	restore: "↩",
	success: "✅",
	keep: "📌",
	unlock: "🔓",
	update: "🔄",
	// Avoid emoji presentation: terminal and Clack width calculations can
	// disagree on U+FE0F and shift the right edge of titled note borders.
	warning: "⚠",
} as const;

// Keep the CLI readable in pipes and CI, while still honoring an explicit color override.
const useColor =
	"FORCE_COLOR" in process.env || (!("NO_COLOR" in process.env) && process.stdout.isTTY);

const colorCodes: Record<Color, number> = {
	cyan: 36,
	green: 32,
	yellow: 33,
	gray: 240,
	white: 97,
};

function color(value: string, shade: Color): string {
	if (!useColor) {
		return value;
	}

	// Extended gray gives metadata a lower visual weight than actions and names.
	const code = shade === "gray" ? `38;5;${colorCodes[shade]}` : String(colorCodes[shade]);
	return `\u001B[${code}m${value}\u001B[39m`;
}

export function bold(value: string): string {
	return useColor ? `\u001B[1m${value}\u001B[22m` : value;
}

export function accent(value: string): string {
	return color(value, "cyan");
}

export function success(value: string): string {
	return color(value, "green");
}

export function warning(value: string): string {
	return color(value, "yellow");
}

export function dim(value: string): string {
	return color(value, "gray");
}

export function text(value: string): string {
	return color(value, "white");
}

// OSC 8 makes filesystem sources clickable in terminals without coupling the
// CLI to a platform-specific opener command.
export function terminalLink(label: string, target: string): string {
	return `\u001B]8;;${target}\u0007${label}\u001B]8;;\u0007`;
}

export function printBanner(): void {
	if (!process.stdout.isTTY) {
		return;
	}

	// A small, static banner establishes hierarchy without adding startup delay or terminal animation.
	console.log();
	console.log(`   ${accent("◆")} ${bold(text(CLI_NAME))} ${dim(`v${CLI_VERSION}`)}`);
	console.log(`     ${dim("Keep skill context light. Keep every skill reachable.")}`);
	console.log();
}
