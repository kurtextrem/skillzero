import { AutocompletePrompt, getRows, isCancel, wrapTextWithPrefix } from "@clack/core";
import { pathToFileURL } from "node:url";

import { estimateSkillMetadataTokens } from "./tokens.js";
import { accent, bold, dim, terminalLink } from "./ui.js";

export interface VisibleMultiselectOption {
  value: string;
  label: string;
  hint?: string;
  description?: string;
  source?: string;
}

export type VisibleMultiselectResult =
  | { status: "ok"; selectedIds: string[] }
  | { status: "cancelled" };

interface VisibleMultiselectOptions {
  message: string;
  options: VisibleMultiselectOption[];
  initialValues?: string[];
  required?: boolean;
}

const MAX_DETAIL_LINES = 8;
const RESERVED_DETAIL_ROWS = MAX_DETAIL_LINES + 4;

function matchesSearch(search: string, option: VisibleMultiselectOption): boolean {
  const normalizedSearch = search.toLowerCase();
  return (
    option.label.toLowerCase().includes(normalizedSearch) ||
    option.hint?.toLowerCase().includes(normalizedSearch) === true ||
    option.description?.toLowerCase().includes(normalizedSearch) === true ||
    option.value.toLowerCase().includes(normalizedSearch)
  );
}

function formatOption(
  option: VisibleMultiselectOption,
  active: boolean,
  selectedValues: readonly string[],
): string {
  const pointer = active ? accent(">") : " ";
  const checkbox = selectedValues.includes(option.value) ? "[x]" : "[ ]";
  const label = active ? bold(option.label) : dim(option.label);
  const hideSelectedStateHint =
    selectedValues.includes(option.value) &&
    (option.hint === "managed" || option.hint === "manual-only");
  const hint = option.hint && !hideSelectedStateHint ? ` ${dim(`(${option.hint})`)}` : "";

  return `${pointer} ${checkbox} ${label}${hint}`;
}

export function formatSourceLink(source: string): string {
  return terminalLink(source, pathToFileURL(source).href);
}

function formatDescription(
  name: string | undefined,
  description: string | undefined,
  source: string | undefined,
): string[] {
  const normalizedDescription = description?.trim();
  const sourceLine = source ? [`    ${dim("Source:")} ${formatSourceLink(source)}`] : [];
  if (!normalizedDescription) {
    return name
      ? [
          dim(`The agent sees these ${estimateSkillMetadataTokens(name, "")} tokens:`),
          ...sourceLine,
        ]
      : sourceLine;
  }

  const wrappedLines = wrapTextWithPrefix(process.stdout, normalizedDescription, "    ").split(
    "\n",
  );
  const maxLines = Math.max(2, Math.min(MAX_DETAIL_LINES, getRows(process.stdout) - 9));
  const descriptionHeader = name
    ? dim(
        `The agent sees these ${estimateSkillMetadataTokens(name, normalizedDescription)} tokens:`,
      )
    : null;
  if (wrappedLines.length <= maxLines) {
    const detailLines = descriptionHeader ? [descriptionHeader, ...wrappedLines] : wrappedLines;
    return sourceLine.length > 0 ? [...detailLines, "", ...sourceLine] : detailLines;
  }

  const truncatedLines = [
    ...wrappedLines.slice(0, maxLines - 1),
    `    ${dim("[description truncated]")}`,
  ];
  const detailLines = descriptionHeader ? [descriptionHeader, ...truncatedLines] : truncatedLines;
  return sourceLine.length > 0 ? [...detailLines, "", ...sourceLine] : detailLines;
}

export function formatVisibleOptions(
  options: VisibleMultiselectOption[],
  cursor: number,
  selectedValues: readonly string[],
  maxRows: number,
): string[] {
  const visibleCount = Math.max(1, Math.min(maxRows, options.length));
  const maxStart = Math.max(0, options.length - visibleCount);
  const start = Math.max(0, Math.min(cursor - Math.floor(visibleCount / 2), maxStart));
  const end = start + visibleCount;
  const rows: string[] = [];

  if (start > 0) {
    rows.push(dim(`  ↑ ${start} more skills`));
  }

  for (let index = start; index < end; index += 1) {
    const option = options[index];
    if (!option) {
      continue;
    }

    rows.push(`  ${formatOption(option, index === cursor, selectedValues)}`);
  }

  if (end < options.length) {
    rows.push(dim(`  ↓ ${options.length - end} more skills`));
  }

  return rows;
}

// Clack's styled multiselect can lose its active-row distinction when terminal
// colors are unavailable, so reuse its keyboard state with a stable ASCII pointer.
export async function promptVisibleMultiselect(
  options: VisibleMultiselectOptions,
): Promise<VisibleMultiselectResult> {
  const prompt = new AutocompletePrompt<VisibleMultiselectOption>({
    options: options.options,
    multiple: true,
    initialValue: options.initialValues,
    filter: matchesSearch,
    validate: (value) => {
      if (options.required !== true || (Array.isArray(value) && value.length > 0)) {
        return undefined;
      }

      return "Please select at least one item.";
    },
    render() {
      const selectedValues = this.selectedValues;
      const matchCount =
        this.filteredOptions.length === this.options.length
          ? ""
          : ` ${dim(`(${this.filteredOptions.length} matches)`)}`;
      const search = this.userInput.length > 0 ? this.userInputWithCursor : dim("type to filter");
      const focusedOption = this.filteredOptions[this.cursor];
      const details = formatDescription(
        focusedOption?.label,
        focusedOption?.description,
        focusedOption?.source,
      );
      const detailBlock = details.length > 0 ? ["", ...details] : [];
      const header = [
        `${accent("?")}  ${options.message}`,
        `${dim("↑/↓")} navigate ${dim("•")} ${dim("Space/Tab")} toggle ${dim("•")} ${dim("Enter")} confirm`,
        `${dim("Search:")} ${search}${matchCount}`,
      ];
      // Paginate only compact skill rows; wrapped descriptions belong to the
      // focused detail block and must not affect which skills are visible.
      const maxRows = Math.max(
        1,
        getRows(process.stdout) - header.length - RESERVED_DETAIL_ROWS - 3,
      );
      const rows = formatVisibleOptions(this.filteredOptions, this.cursor, selectedValues, maxRows);

      if (rows.length === 0) {
        rows.push(`  ${dim("No matching options.")}`);
      }

      const error = this.state === "error" ? ["", dim(this.error)] : [];
      return [...header, ...rows, ...detailBlock, ...error].join("\n");
    },
  });

  const selectedIds = await prompt.prompt();
  if (isCancel(selectedIds)) {
    return { status: "cancelled" };
  }

  // AutocompletePrompt's shared type permits a scalar for single-select mode;
  // this helper always enables multiple mode, so normalize the broader type here.
  return {
    status: "ok",
    selectedIds:
      selectedIds === undefined ? [] : Array.isArray(selectedIds) ? selectedIds : [selectedIds],
  };
}
