// JSON and YAML readers share this guard so they agree on what counts as a record.
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
