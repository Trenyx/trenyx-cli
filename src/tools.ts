/**
 * The only things the bug writer can do: list, read and search the blind view. No tool writes, runs anything or reaches a
 * network, so none of that can be asked for. Every call is checked first, every file comes from the view's own list, and
 * what comes back is the repository's text: data for the writer to read, never instructions to it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import type Anthropic from "@anthropic-ai/sdk";
import type { View } from "./blind.js";

const READ_LINES = 2000;        // one read_file call, by default and at most
const READ_CHARS = 100_000;     // the same limit in characters, so a file of very long lines cannot fill the context
const LINE_CHARS = 2000;        // one line in a read_file result
const LIST_MAX = 1000;
const SEARCH_MAX = 100;         // matches shown; all of them are still counted
const SEARCH_LINE = 300;
const SEARCH_MS = 5000;         // a search stops here, so a pattern that backtracks badly cannot hang the run
const PATTERN_MAX = 500;

/** Sorted, and never built from the repository, so the start of every request stays the same and caches. */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: 'List the files in this folder, as paths relative to it. A glob with no slash, such as "*.py", matches file names anywhere; "src/**/*.ts" matches paths.',
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "A subfolder. Leave it out for the whole folder." },
        pattern: { type: "string", description: "A glob." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: `Read one file. Each line comes back as its number, a tab, then its text: the number and the tab are not in the file, so never copy them into "old". At most ${READ_LINES} lines at a time; use offset and limit for more.`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, relative to this folder." },
        offset: { type: "integer", description: "The line to start from, counted from 1." },
        limit: { type: "integer", description: "How many lines to read." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Search file contents with a regular expression in JavaScript syntax. Returns path:line:text for each match and how many there were, so it shows whether a text occurs exactly once. A pattern can span lines with \\n.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression." },
        path: { type: "string", description: "A subfolder or file. Leave it out for the whole folder." },
        glob: { type: "string", description: 'Only files matching this glob, such as "*.py".' },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];

const OPEN = TOOLS.map((t) => t.name);

/** Whether one tool call may run: only these three tools, and only on paths inside the view. */
export function toolDecision(name: string, args: unknown, view: string): [boolean, string] {
  if (!OPEN.includes(name)) return [false, `only ${OPEN.slice(0, -1).join(", ")} and ${OPEN[OPEN.length - 1]} are open`];
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const globs = name === "search" ? [a.glob] : [a.pattern];     // search's own pattern is about text, not paths
  for (const g of globs) {
    if (g !== undefined && (typeof g !== "string" || path.isAbsolute(g) || g.split(/[/\\]/).includes(".."))) return [false, "a pattern stays inside this folder"];
  }
  if (name === "search" && typeof a.pattern !== "string") return [false, "search needs a pattern"];
  if (name === "read_file" && typeof a.path !== "string") return [false, "read_file needs a path"];
  const v = a.path;
  if (v === undefined || v === null) return [true, ""];
  if (typeof v !== "string") return [false, "a path must be text"];
  let real = path.resolve(view, v);
  try { real = fs.realpathSync(real); } catch { /* a path that does not exist reads nothing */ }
  return real === view || real.startsWith(view + path.sep) ? [true, ""] : [false, "outside this folder"];
}

const relative = (view: string, p: string) => path.relative(view, path.resolve(view, p)).split(path.sep).join("/");

/** One file from the view's list, opened only if it really is a plain file inside the view. */
function readInside(view: View, rel: string): string {
  const real = fs.realpathSync(path.join(view.dir, rel));
  if (!real.startsWith(view.dir + path.sep) || !fs.statSync(real).isFile()) throw new Error("outside this folder");
  return fs.readFileSync(real, "utf8");
}

function globRe(glob: string): RegExp {
  let out = "", depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (glob.startsWith("**/", i)) { out += "(?:.*/)?"; i += 2; } else if (glob.startsWith("**", i)) { out += ".*"; i++; } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") { out += "(?:"; depth++; } else if (c === "}" && depth) { out += ")"; depth--; } else if (c === "," && depth) out += "|";
    else out += c.replace(/[.+^$()|[\]{}\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function chosen(view: View, a: Record<string, unknown>, glob: unknown): string[] {
  const dir = typeof a.path === "string" ? relative(view.dir, a.path) : "";
  let files = dir ? view.files.filter((f) => f === dir || f.startsWith(`${dir}/`)) : view.files;
  if (typeof glob === "string") {
    const re = globRe(glob), base = !glob.includes("/");
    files = files.filter((f) => re.test(base ? path.posix.basename(f) : f));
  }
  return files;
}

function listFiles(view: View, a: Record<string, unknown>): string {
  const files = chosen(view, a, a.pattern);
  if (!files.length) return "No files match.";
  const shown = files.slice(0, LIST_MAX).join("\n");
  return files.length > LIST_MAX ? `${shown}\n${files.length} files; the first ${LIST_MAX} are shown. Narrow with path or pattern.` : shown;
}

function readFile(view: View, a: Record<string, unknown>): string {
  const rel = relative(view.dir, a.path as string);
  if (!view.files.includes(rel)) return "";
  const lines = readInside(view, rel).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return "(this file is empty)";
  const from = Math.max(1, typeof a.offset === "number" ? Math.floor(a.offset) : 1);
  const limit = Math.min(READ_LINES, Math.max(1, typeof a.limit === "number" ? Math.floor(a.limit) : READ_LINES));
  if (from > lines.length) return `This file has ${lines.length} lines.`;
  let out = "", n = from - 1;
  for (; n < lines.length && n < from - 1 + limit; n++) {
    const line = lines[n]!;
    const row = `${String(n + 1).padStart(6)}\t${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)} ...(this line is cut here)` : line}\n`;
    if (out && out.length + row.length > READ_CHARS) break;
    out += row;
  }
  return n < lines.length ? `${out}Lines ${from} to ${n} of ${lines.length}. Use offset to read on.` : out.trimEnd();
}

function search(view: View, a: Record<string, unknown>): string {
  const pattern = a.pattern as string;
  if (pattern.length > PATTERN_MAX) throw new Error(`a pattern can be at most ${PATTERN_MAX} characters`);
  let re: RegExp;
  try { re = new RegExp(pattern, a.ignore_case === true ? "gmi" : "gm"); } catch { throw new Error("that is not a valid regular expression"); }
  const rows: string[] = [];
  let total = 0, inFiles = 0;
  const scan = () => {
    for (const rel of chosen(view, a, a.glob)) {
      let text: string;
      try { text = readInside(view, rel); } catch { continue; }
      let hit = false, line = 1, at = 0;
      for (const m of text.matchAll(re)) {
        hit = true;
        total++;
        for (let i = text.indexOf("\n", at); i >= 0 && i < m.index; i = text.indexOf("\n", i + 1)) line++;
        at = m.index;
        if (rows.length < SEARCH_MAX) {
          const end = text.indexOf("\n", m.index), start = text.lastIndexOf("\n", m.index - 1) + 1;
          rows.push(`${rel}:${line}:${text.slice(start, end < 0 ? text.length : end).slice(0, SEARCH_LINE)}`);
        }
      }
      if (hit) inFiles++;
    }
  };
  // the time limit runs the scan through vm because a regular expression cannot be interrupted any other way
  try { vm.runInNewContext("scan()", { scan }, { timeout: SEARCH_MS }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new Error("that pattern took too long: use a simpler one, or narrow with path or glob");
    throw e;
  }
  if (!total) return "No matches.";
  const summary = `${total} ${total === 1 ? "match" : "matches"} in ${inFiles} ${inFiles === 1 ? "file" : "files"}`;
  return `${rows.join("\n")}\n${total > SEARCH_MAX ? `${summary}; the first ${SEARCH_MAX} are shown. Narrow with path or glob.` : `${summary}.`}`;
}

export interface ToolResult { text: string; isError: boolean }

/** Runs one call. A refused or failed call comes back as text for the writer, never as a crash. */
export function runTool(name: string, args: unknown, view: View): ToolResult {
  const [ok, why] = toolDecision(name, args, view.dir);
  if (!ok) return { text: why, isError: true };
  const a = args as Record<string, unknown>;
  try {
    if (name === "list_files") return { text: listFiles(view, a), isError: false };
    if (name === "search") return { text: search(view, a), isError: false };
    const text = readFile(view, a);       // the same answer for a test file and for a file that was never there
    return text ? { text, isError: false } : { text: "No such file in this folder.", isError: true };
  } catch (e) {
    return { text: `That did not work: ${(e as Error).message}.`, isError: true };
  }
}
