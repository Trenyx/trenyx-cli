/**
 * The blind view: a copy of the product code with the tests taken out, so bugs are written without seeing what the
 * tests check. The view is also the whole of what the AI provider can read, and it is built only from committed files.
 * File and folder rules are generated from the engine's (rules.gen.ts); test/view-parity measures what this port misses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  COMPOUND_TEST_DIR, C_NOISE, GO_ANY_DEF, GO_BUILD, GO_FUNC, GO_MOCKGEN, GO_PKG_TEST, GO_PRAGMA, GO_TB_INLINE, GO_TB_TYPE,
  GO_TEST_FUNC, GO_TEST_NAMED, GO_TEST_TAG, GO_TESTING_IMPORT, GO_TESTISH, HASH_PRAGMA, JS_PRAGMA, META, NAMES_TESTS, PY_ANY_DEF,
  PY_FACTORY, PY_FACTORY_USE, PY_TEST_DEF, PY_TEST_SUPPORT, PY_TESTCASE, PY_TESTCASE_FROM, RS_ANY_FN, RS_TEST_FN, RUST_PRAGMA,
  SKIP_DIRS, SKIP_FILE, SPEC_DATA_DIR, SRC_EXT, TEST_COMPANION, TEST_DIR, TEST_FEATURE, TEST_PHRASE, VITEST_IN_SOURCE,
} from "./rules.gen.js";

const NEVER_DIRS = new Set(["vendor", "third_party", ".github", ".git"]);   // not product code, or not ours to send
const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".svelte", ".vue"];
const DOC_EXT = [".md", ".mdx", ".txt", ".rst", ".adoc"];
const MAX_FILE = 1024 * 1024;

const all = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
const firstGroups = (re: RegExp, text: string) => [...text.matchAll(all(re))].map((m) => m[1] ?? m[2]).filter(Boolean) as string[];

function supportDir(parent: string, d: string): boolean {
  const p = path.basename(parent).toLowerCase(), low = d.toLowerCase();
  return TEST_DIR.test(low) || (["spec", "specs"].includes(p) && ["support", "helpers"].includes(low)) || (p === "cypress" && low === "support");
}

export function nameStripped(parent: string, d: string): boolean {
  const low = d.toLowerCase();
  return SKIP_DIRS.has(low) || NEVER_DIRS.has(low) || low.endsWith("testdata") || low.endsWith("fakes") || /^mock_\w+$/.test(low)
    || (low.endsWith("test") && d.length > 4 && low !== "latest" && low !== "contest")
    || supportDir(parent, d) || COMPOUND_TEST_DIR.test(d) || SPEC_DATA_DIR.test(d);
}

export function isTestPath(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1]!;
  return SKIP_FILE.test(base) || parts.slice(0, -1).some((d, i) => nameStripped(parts.slice(0, i).join("/") || ".", d));
}

function goBuildRequiresTest(text: string): boolean {
  const m = GO_BUILD.exec(text);
  if (!m || m[1]!.includes("||")) return false;
  return m[1]!.split("&&").map((t) => t.replace(/[() ]/g, "")).some((t) => !t.startsWith("!") && GO_TEST_TAG.test(t));
}

function goTestSupport(text: string): boolean {
  if (goBuildRequiresTest(text) || GO_MOCKGEN.test(text.slice(0, 2048))) return true;
  const alias = new Set(["testing"]);
  for (const m of text.matchAll(/^[ \t]*(?:import[ \t]+)?(\w+)[ \t]+"testing"/gm)) if (m[1] !== "_" && m[1] !== "import") alias.add(m[1]!);
  const tparam = new RegExp(`\\b(?:(?:${[...alias].sort().join("|")})\\.(?:TB|T|B|F|M)|(?:assert|require|mock)\\.TestingT)\\b`);
  const tbparam = new RegExp(GO_TB_INLINE.source + firstGroups(GO_TB_TYPE, text).map((t) => `|\\b${t}\\b`).join(""));
  const funcs: [string, boolean][] = [];
  for (const m of text.matchAll(all(GO_FUNC))) {
    let i = m.index! + m[0].length, depth = 1;
    const start = i;
    while (i < text.length && depth) { depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0; i++; }
    const params = text.slice(start, i - 1);
    if (tparam.test(params)) return true;
    funcs.push([m[1]!, tbparam.test(params)]);
  }
  return funcs.some(([n, t]) => t || /For(Test|Testing|Tests)$/.test(n)) && funcs.every(([n, t]) => t || GO_TESTISH.test(n));
}

function testSupportCode(fn: string, text: string): boolean {
  if (fn.endsWith(".go")) return goTestSupport(text) || (GO_TEST_NAMED.test(fn) && (GO_PKG_TEST.test(text) || GO_TESTING_IMPORT.test(text)));
  if (fn.endsWith(".py")) return PY_TEST_SUPPORT.test(text) || (PY_TESTCASE.test(text) && PY_TESTCASE_FROM.test(text)) || (PY_FACTORY.test(text) && PY_FACTORY_USE.test(text));
  return false;
}

/* Rust: test modules and test-only items are cut with a small lexer that skips strings, chars and comments. */
function rustSkip(code: string, i: number): number {
  const c = code[i];
  if (code.startsWith("//", i)) { const j = code.indexOf("\n", i); return j < 0 ? code.length : j; }
  if (code.startsWith("/*", i)) {
    let d = 1, j = i + 2;
    while (j < code.length && d) {
      if (code.startsWith("/*", j)) { d++; j += 2; } else if (code.startsWith("*/", j)) { d--; j += 2; } else j++;
    }
    return j;
  }
  const raw = /^(?:b|c)?r(#*)"/.exec(code.slice(i, i + 40));
  if (raw && !/\w/.test(code[i - 1] ?? "")) {
    const j = code.indexOf('"' + raw[1], i + raw[0].length);
    return j < 0 ? code.length : j + 1 + raw[1]!.length;
  }
  if (c === '"') {
    let j = i + 1;
    while (j < code.length && code[j] !== '"') j += code[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "'") {
    const m = /^'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/.exec(code.slice(i, i + 14));
    if (m) return i + m[0].length;
  }
  return -1;
}

function rustClose(code: string, i: number): number {     // i is just past the opening bracket
  let d = 1;
  while (i < code.length) {
    const s = rustSkip(code, i);
    if (s >= 0) { i = s; continue; }
    if ("([{".includes(code[i]!)) d++;
    else if (")]}".includes(code[i]!)) { d--; if (d === 0) return i + 1; }
    i++;
  }
  return code.length;
}

function members(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = "", quoted = false;
  for (const ch of inner) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "(" || ch === ")")) depth += ch === "(" ? 1 : -1;
    if (ch === "," && depth === 0 && !quoted) { parts.push(cur); cur = ""; } else cur += ch;
  }
  return [...parts, cur].map((p) => p.trim()).filter(Boolean);
}

const atStart = (re: RegExp, s: string) => new RegExp(`^(?:${re.source})`, re.flags).test(s);

/** Whether a cfg predicate holds only under test: `test` or a feature naming test support, all(...) with such a member,
 * any(...) whose members are all such beside companions like loom; never not(...). */
function requiresTest(pred: string): boolean {
  const e = pred.trim().replace(/\s+/g, " ");
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/.exec(e);
  if (!m) return e === "test" || atStart(TEST_FEATURE, e);
  const parts = members(m[2]!);
  if (m[1] === "all") return parts.some(requiresTest);
  if (m[1] === "any") {
    const need = parts.filter((p) => !atStart(TEST_COMPANION, p));
    return need.length > 0 && need.every(requiresTest);
  }
  return false;
}

function cfgRequiresTest(attr: string): boolean {
  const m = /^#!?\[\s*cfg\s*\(/.exec(attr);
  if (!m) return false;
  let i = m[0].length, depth = 1;
  while (i < attr.length && depth) { depth += attr[i] === "(" ? 1 : attr[i] === ")" ? -1 : 0; i++; }
  return requiresTest(attr.slice(m[0].length, i - 1).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " "));
}

const RUST_ITEM = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|default|extern\s+"C")\s+)*(?:fn|impl|struct|enum|union|const|static|use|type|trait|mod|extern|macro_rules!|\w+!)(?=\W)/;
const BARE_TEST = /^#\[\s*(?:[\w:]+::)?(?:test|rstest|test_case)\b/;

/** Removes test modules and test-only items. mods: the `#[cfg(test)] mod x;` names, whose files must go too. */
export function stripRust(code: string): { text: string; mods: string[]; testOnly: boolean } {
  const head = code.replace(/^﻿/, "");
  const inner = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|#!\[(?!cfg)[^\]]*\])*(#!\[[^\]]*\])/.exec(head);
  if (inner && cfgRequiresTest(inner[1]!)) return { text: "", mods: [], testOnly: true };
  const cuts: [number, number][] = [], mods: string[] = [];
  let i = 0;
  while (i < code.length) {
    const s = rustSkip(code, i);
    if (s >= 0) { i = s; continue; }
    if (!code.startsWith("#[", i)) { i++; continue; }
    const start = i;
    let isTest = false;
    for (;;) {                                            // the whole run of attributes
      while (/\s/.test(code[i] ?? "")) i++;
      const c = rustSkip(code, i);
      if (c >= 0 && (code.startsWith("//", i) || code.startsWith("/*", i))) { i = c; continue; }
      if (!code.startsWith("#[", i)) break;
      const end = rustClose(code, i + 2);
      const attr = code.slice(i, end);
      isTest ||= cfgRequiresTest(attr) || BARE_TEST.test(attr);
      i = end;
    }
    if (!isTest) continue;
    let j = i;
    const item = RUST_ITEM.test(code.slice(i, i + 200));    // else a field, variant, match arm or statement: it can end at a comma
    let angle = 0;
    for (;;) {                                              // the item's end: its first ';' or its closing '}'
      if (j >= code.length) break;
      const c = rustSkip(code, j);
      if (c >= 0) { j = c; continue; }
      const ch = code[j]!;
      if (ch === "(" || ch === "[") { j = rustClose(code, j + 1); continue; }
      if (ch === ";") { j++; break; }
      if (ch === "}") break;
      if (!item && ch === "<") angle++;
      if (!item && ch === ">" && !"-=".includes(code[j - 1]!) && angle) angle--;
      if (!item && ch === "," && !angle) { j++; break; }
      if (ch === "{") {
        j = rustClose(code, j + 1);
        const tail = /^\s*[;,]/.exec(code.slice(j, j + 40));
        if (tail) j += tail[0].length;
        break;
      }
      j++;
    }
    const mod = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/.exec(code.slice(i, j));
    if (mod) mods.push(mod[1]!);
    let from = start;                                       // the docs and comments attached to it go with it
    for (;;) {
      const ls = code.lastIndexOf("\n", from - 1) + 1, prev = code.lastIndexOf("\n", ls - 2) + 1;
      if (ls === 0 || !code.slice(ls, from).trim() === false || !code.slice(prev, ls).trim().startsWith("//")) { from = code.slice(ls, from).trim() ? from : ls; break; }
      from = prev;
    }
    cuts.push([from, j]);
    i = j;
  }
  let text = code;
  for (const [a, b] of cuts.reverse()) text = text.slice(0, a) + text.slice(b);
  return { text, mods, testOnly: false };
}

function stripPragmas(fn: string, text: string): string {
  if (fn.endsWith(".py")) {
    if (!HASH_PRAGMA.test(text)) return text;
    const g = all(HASH_PRAGMA);
    for (const [s, e] of pySpans(text).filter((x) => x[2] === "line").reverse()) {
      const seg = text.slice(s, e);
      if (!HASH_PRAGMA.test(seg)) continue;
      const tail = seg.replace(g, "");
      text = (["", "#"].includes(tail.trim()) ? text.slice(0, s).replace(/[ \t]+$/, "") : text.slice(0, s) + tail) + text.slice(e);
    }
    return text;
  }
  const pat = JS_EXT.some((e) => fn.endsWith(e)) ? JS_PRAGMA : fn.endsWith(".go") ? GO_PRAGMA : fn.endsWith(".rs") ? RUST_PRAGMA : null;
  if (!pat || !pat.test(text)) return text;
  const g = all(pat), out: string[] = [];
  for (const line of text.split("\n")) {
    const next = line.replace(g, "");
    if (next === line) out.push(line);
    else if (next.trim()) out.push(next.trimEnd());
  }
  return out.join("\n");
}

function jsBlockEnd(text: string, i: number): number {
  let depth = 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      i = j + 1;
    } else if (c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") {
        if (text[j] === "\\") j += 2;
        else if (text.startsWith("${", j)) { j = jsBlockEnd(text, j + 2); if (j < 0) return -1; } else j++;
      }
      i = j + 1;
    } else if (text.startsWith("//", i)) { const j = text.indexOf("\n", i); i = j < 0 ? text.length : j; }
    else if (text.startsWith("/*", i)) { const j = text.indexOf("*/", i + 2); i = j < 0 ? text.length : j + 2; }
    else {
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i + 1;
      i++;
    }
  }
  return -1;
}

function stripVitest(text: string): string {
  for (;;) {
    const m = VITEST_IN_SOURCE.exec(text);
    if (!m) return text;
    const end = jsBlockEnd(text, m.index + m[0].length);
    if (end < 0) return text;
    text = text.slice(0, m.index) + text.slice(end).replace(/^[ \t]*;?[ \t]*\n?/, "");
  }
}

type Span = [number, number, "line" | "block" | "doc"];

function pySpans(text: string): Span[] {
  const out: Span[] = [];
  let i = 0, fresh = true;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") { const j = text.indexOf("\n", i); const e = j < 0 ? text.length : j; out.push([i, e, "line"]); i = e; continue; }
    if (c === "\n") { fresh = true; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const q = /^[rRbBuUfF]{0,2}("""|'''|"|')/.exec(text.slice(i, i + 5));
    if (q && !/\w/.test(text[i - 1] ?? "")) {
      const d = q[1]!;
      let j = i + q[0].length;
      while (j < text.length && !text.startsWith(d, j) && (d.length === 3 || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      j += d.length;
      if (fresh) out.push([i, j, "doc"]);
      i = j; fresh = false; continue;
    }
    fresh = false; i++;
  }
  return out;
}

function commentSpans(fn: string, text: string): Span[] {
  if (fn.endsWith(".py")) return pySpans(text);
  if (![".go", ".rs", ...JS_EXT].some((e) => fn.endsWith(e))) return [];
  const out: Span[] = [];
  for (const m of text.matchAll(all(C_NOISE))) {
    if (m[0].startsWith("//")) out.push([m.index!, m.index! + m[0].length, "line"]);
    else if (m[0].startsWith("/*")) out.push([m.index!, m.index! + m[0].length, "block"]);
  }
  return out;
}

export interface TestIndex { names: Set<string>; files: Set<string> }

function mentionsTest(line: string, ix: TestIndex): boolean {
  return (line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some((w) => ix.names.has(w))
    || (line.match(/[\w.-]+/g) ?? []).some((t) => ix.files.has(t.replace(/^[.-]+|[.-]+$/g, "")))
    || TEST_PHRASE.test(line);
}

/** Comment and docstring lines that name a test or say what the tests pin. The code on those lines stays. */
function stripMentions(fn: string, text: string, ix: TestIndex): string {
  const cuts: [number, number][] = [];
  for (const [s, e, kind] of commentSpans(fn, text)) {
    const lines = text.slice(s, e).split("\n");
    let pos = s;
    lines.forEach((line, k) => {
      const a = pos, b = pos + line.length;
      pos = b + 1;
      if (!mentionsTest(line, ix)) return;
      if (lines.length === 1 && kind !== "doc") cuts.push([a, b]);
      else if (lines.length === 1) {
        const q = /^[rRbBuUfF]*("""|'''|"|')/.exec(line);
        if (q) cuts.push([a + q[0].length, b - q[1]!.length]);
      } else if (k === 0) {
        const q = /^[rRbBuUfF]*("""|'''|"|')|^\/\*+!?/.exec(line);
        cuts.push([a + (q ? q[0].length : 0), b]);
      } else if (k === lines.length - 1) {
        const q = /("""|'''|"|'|\*+\/)$/.exec(line);
        cuts.push([a + line.length - line.trimStart().length, b - (q ? q[0].length : 0)]);
      } else cuts.push([a, text[b] === "\n" ? b + 1 : b]);
    });
  }
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) {
    const ls = text.lastIndexOf("\n", a - 1) + 1;
    let le = text.indexOf("\n", b);
    if (le < 0) le = text.length;
    if (text.slice(a, b).endsWith("\n")) text = text.slice(0, a) + text.slice(b);
    else if (!text.slice(ls, a).trim() && !text.slice(b, le).trim()) text = text.slice(0, ls) + text.slice(le + 1);
    else text = text.slice(0, a).trimEnd() + text.slice(b);
  }
  return text;
}

function walkFiles(repo: string): string[] {
  const out: string[] = [];
  const go = (rel: string) => {
    for (const e of fs.readdirSync(path.join(repo, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (![".git", "node_modules", "vendor", "target", "dist"].includes(e.name)) go(r); } else if (e.isFile()) out.push(r);
    }
  };
  go("");
  return out;
}

/** The test names and test file names of a checkout, so comments that mention them can go. */
export function testIndex(repo: string): TestIndex {
  const names = new Set<string>(), files = new Set<string>(), product = new Set<string>(), productFiles = new Set<string>();
  for (const rel of walkFiles(repo)) {
    const fn = path.basename(rel), test = isTestPath(rel);
    if (test && fn.length >= 8 && SRC_EXT.some((e) => fn.endsWith(e))) files.add(fn);
    else if (!test) productFiles.add(fn);
    if (![".go", ".py", ".rs"].some((e) => fn.endsWith(e))) continue;
    const t = fs.readFileSync(path.join(repo, rel), "utf8");
    if (fn.endsWith(".go")) {
      if (fn.endsWith("_test.go")) firstGroups(GO_TEST_FUNC, t).forEach((n) => names.add(n));
      if (!test) firstGroups(GO_ANY_DEF, t).forEach((n) => product.add(n));
    } else if (fn.endsWith(".py")) {
      if (test) firstGroups(PY_TEST_DEF, t).forEach((n) => names.add(n));
      else firstGroups(PY_ANY_DEF, t).forEach((n) => product.add(n));
    } else {
      const tests = new Map<string, number>(), defs = new Map<string, number>();
      for (const n of firstGroups(RS_TEST_FN, t)) { tests.set(n, (tests.get(n) ?? 0) + 1); names.add(n); }
      for (const n of firstGroups(RS_ANY_FN, t)) defs.set(n, (defs.get(n) ?? 0) + 1);
      for (const [n, k] of defs) if (k > (tests.get(n) ?? 0)) product.add(n);     // also a real function, so the name stays in comments
    }
  }
  const good = (n: string) => n.length >= 8 && (n.replace(/^_+|_+$/g, "").includes("_") || /^(Test|Benchmark|Fuzz|Example)[A-Z_]/.test(n)) && !product.has(n);
  return { names: new Set([...names].filter(good)), files: new Set([...files].filter((f) => !productFiles.has(f))) };
}

function redactBuildFile(fn: string, text: string): string {
  if (fn === "package.json") {
    try {
      const doc = JSON.parse(text) as Record<string, unknown>;
      for (const k of ["jest", "vitest", "nyc", "c8", "mocha", "ava"]) delete doc[k];
      const scripts = doc.scripts as Record<string, string> | undefined;
      if (scripts) for (const k of Object.keys(scripts)) if (/test|coverage|e2e|spec/i.test(k)) delete scripts[k];
      return JSON.stringify(doc, null, 2) + "\n";
    } catch { return text; }
  }
  if (fn !== "Cargo.toml" && fn !== "pyproject.toml") return text;
  const out: string[] = [];
  let drop = false;
  for (const line of text.split("\n")) {
    const h = /^\s*(\[\[?[^\]]+\]\]?)/.exec(line);
    if (h) drop = /^\[\[(test|bench)\]\]$|^\[tool\.(pytest|coverage|tox|hatch\.envs)/.test(h[1]!.replace(/\s/g, ""));
    if (!drop) out.push(line);
  }
  return out.join("\n");
}

export interface View {
  dir: string;
  files: string[];          // everything the provider can read, sorted
  sourceFiles: string[];    // the files a bug may go in
}

export function buildView(repo: string, out: string, opts: { paths?: string[]; exclude?: string[] } = {}): View {
  const excluded = (rel: string) => (opts.exclude ?? []).some((x) => { const p = x.replace(/\/+$/, ""); return rel === p || rel.startsWith(p + "/"); });
  const ix = testIndex(repo);
  const files: string[] = [], sourceFiles: string[] = [], rustTestMods = new Set<string>();
  const put = (rel: string, text: string) => {
    const dst = path.join(out, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, text);
    files.push(rel);
  };
  // first pass over Rust files: what `#[cfg(test)] mod x;` declares is dropped wherever it is met
  for (const rel of walkFiles(repo)) {
    if (!rel.endsWith(".rs") || isTestPath(rel)) continue;
    const dir = path.dirname(rel), base = path.basename(rel, ".rs");
    const here = ["lib", "main", "mod"].includes(base) ? dir : path.join(dir, base);
    for (const m of stripRust(fs.readFileSync(path.join(repo, rel), "utf8")).mods) {
      rustTestMods.add(path.normalize(path.join(here, `${m}.rs`)));
      rustTestMods.add(path.normalize(path.join(here, m)));
    }
  }
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(repo, rel || "."), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (excluded(r) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!nameStripped(rel || ".", e.name) && !rustTestMods.has(r)) walk(r);
        continue;
      }
      if (!e.isFile() || fs.statSync(path.join(repo, r)).size > MAX_FILE) continue;
      const fn = e.name;
      if (META.includes(fn)) {
        const text = fs.readFileSync(path.join(repo, r), "utf8");
        if (!NAMES_TESTS.test(text) || fn !== "README.md") put(r, redactBuildFile(fn, text));
        continue;
      }
      if (!SRC_EXT.some((x) => fn.endsWith(x)) || SKIP_FILE.test(fn) || /\.min\.[cm]?js$/.test(fn) || rustTestMods.has(r)) continue;
      let text = fs.readFileSync(path.join(repo, r), "utf8");
      if (testSupportCode(fn, text)) continue;
      if (fn.endsWith(".rs")) {
        const st = stripRust(text);
        if (st.testOnly) continue;
        text = st.text;
      }
      text = stripPragmas(fn, text);
      if (JS_EXT.some((x) => fn.endsWith(x))) text = stripVitest(text);
      put(r, stripMentions(fn, text, ix));
      sourceFiles.push(r);
    }
  };
  fs.mkdirSync(out, { recursive: true });
  for (const p of opts.paths?.length ? opts.paths : ["."]) {
    const rel = path.normalize(p).replace(/\/+$/, "");
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`--path must be inside the repository: ${p}`);
    if (rel === ".") walk("");
    else if (fs.statSync(path.join(repo, rel)).isDirectory()) walk(rel);
  }
  const docs = path.join(repo, "docs");
  const addDoc = (rel: string) => {
    const fn = path.basename(rel);
    if (!files.includes(rel) && !excluded(rel) && DOC_EXT.some((x) => fn.endsWith(x)) && !SKIP_FILE.test(fn) && !/test/i.test(fn)) {
      const text = fs.readFileSync(path.join(repo, rel), "utf8");
      if (!NAMES_TESTS.test(text)) put(rel, text);
    }
  };
  if (fs.existsSync(path.join(repo, "README.md")) && !fs.lstatSync(path.join(repo, "README.md")).isSymbolicLink()) addDoc("README.md");
  if (fs.existsSync(docs) && fs.lstatSync(docs).isDirectory()) {
    const go = (rel: string) => {
      for (const e of fs.readdirSync(path.join(repo, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (!nameStripped(rel, e.name)) go(r); } else if (e.isFile()) addDoc(r);
      }
    };
    go("docs");
  }
  return { dir: out, files: [...files].sort(), sourceFiles: [...sourceFiles].sort() };
}
