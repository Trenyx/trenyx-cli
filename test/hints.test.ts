import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { copyHint, coverageNote, nestedModulesHint, partsHint, runScope, scopeHint } from "../src/hints.js";
import { cli, makeRepo, tempDir } from "./helpers.js";

function repoWith(files: Record<string, string>): string {
  const repo = tempDir();
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...a], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "first");
  return repo;
}

describe("a test command that names only part of the repository", () => {
  const files = ["services/api/a.py", "services/web/b.py", "lib/c.py"];
  for (const [command, flags] of [
    ["pytest services/api/tests", "--path services/api"], ["go test ./services/api/...", "--path services/api"], ["cd services/api && npm test", "--path services/api"],
    ["npm test --workspace=services/web", "--path services/web"], ["npm test -w services/web", "--path services/web"], ["vitest run services/api services/web", "--path services/api --path services/web"],
    ["\"pytest\" './lib/'", "--path lib"],
  ] as const) {
    it(`${command} gets ${flags}`, () => assert.ok(scopeHint(command, files).endsWith(`add: ${flags}`), scopeHint(command, files)));
  }
  for (const command of ["pytest", "pytest tests/unit", "npm test", "go test ./...", "node --test", "make test", "vitest run lib/c.test.ts", "cargo test -p core", "pytest -m slow", undefined]) {
    it(`${command} gets no note`, () => assert.equal(scopeHint(command, files), ""));
  }
  it("no note when --path is already there, or the command covers all the code", () => {
    assert.equal(scopeHint("pytest lib", files, ["lib"]), "");
    assert.equal(scopeHint("vitest run src", ["src/a.ts", "src/x/b.ts"]), "");
  });
});

describe("the part of the code a test command runs", () => {
  const files = ["services/api/a.py", "services/web/b.py", "lib/c.py"];
  it("keeps the bugs in the folders a command names", () => {
    const s = runScope("pnpm exec vitest run services/api", "python", files, repoWith({ "x": "x\n" }))!;
    assert.deepEqual(files.filter(s.keep), ["services/api/a.py"]);
    assert.match(s.note, /runs only services\/api\/, so the bugs go only there/);
  });
  it("says nothing when the command runs everything or names nothing", () => {
    const repo = repoWith({ "x": "x\n" });
    for (const c of ["pytest", "pytest tests/unit", "npm test", "vitest run lib services", undefined]) assert.equal(runScope(c, "python", files, repo), null, String(c));
  });
  const go = { "go.mod": "module m\n", "a.go": "package m\n", "router/r.go": "package router\n", "router/gin/g.go": "package gin\n", "proxy/p.go": "package proxy\n", "proxy/sub/s.go": "package sub\n", "plugins/x/go.mod": "module x\n", "plugins/x/x.go": "package x\n" };
  const gofiles = ["a.go", "router/r.go", "router/gin/g.go", "proxy/p.go", "proxy/sub/s.go", "plugins/x/x.go"];
  it("Go: ./x/... is x and below, ./x only the files directly in x", () => {
    const s = runScope("go test -race -count=1 ./proxy/... ./router", "go", gofiles, repoWith(go))!;
    assert.deepEqual(gofiles.filter(s.keep), ["router/r.go", "proxy/p.go", "proxy/sub/s.go"]);
    assert.match(s.note, /runs only proxy\/, router\/ \(its own files\) and not plugins\/x \(own go\.mod\)/);
  });
  it("Go: a folder with its own go.mod is never reached from the root, unless a go.work joins it", () => {
    const s = runScope("go test ./...", "go", gofiles, repoWith(go))!;
    assert.deepEqual(gofiles.filter(s.keep), gofiles.slice(0, 5));
    assert.match(s.note, /never reaches plugins\/x, which has its own go\.mod, so no bugs go there/);
    assert.equal(runScope("go test ./...", "go", gofiles, repoWith({ ...go, "go.work": "go 1.22\n" })), null);
    assert.equal(runScope("go test -skip '^TestX$' ./...", "go", gofiles.slice(0, 5), repoWith(go)), null);
    const many = { ...go, ...Object.fromEntries(["a", "b", "c", "d"].map((n) => [`mods/${n}/go.mod`, "module x\n"])), "examples/e/go.mod": "module e\n" };
    const more = [...gofiles, ...["a", "b", "c", "d"].map((n) => `mods/${n}/m.go`), "examples/e/e.go"];
    assert.match(runScope("go test ./...", "go", more, repoWith(many))!.note, /never reaches mods\/a, mods\/b, mods\/c and 2 more, which have/);
    assert.equal(runScope("go test ./...", "go", [...gofiles.slice(0, 5), "examples/e/e.go"], repoWith(many)), null, "an examples module gets no bugs anyway");
  });
});

describe("how much of the code the test command runs", () => {
  const big = (n: number) => "x = 1\n".repeat(n);
  const repo = () => repoWith({ "api/a.py": big(40), "web/b.py": big(30), "cli/c.py": big(20), "lib/d.py": big(5), "top.py": big(5) });
  const files = ["api/a.py", "web/b.py", "cli/c.py", "lib/d.py", "top.py"];
  it("names the share by size and the biggest folders left out, at most three", () => {
    const note = coverageNote({ keep: (f) => f.startsWith("api/"), note: "" }, files, repo());
    assert.equal(note, "Your test command runs about 40% of the code (by size); bugs are planted only there, so the score speaks for that part. Left out, biggest first: web/, cli/ and lib/.");
  });
  it("says nothing at 80% or more, or when the command runs everything", () => {
    assert.equal(coverageNote({ keep: (f) => !f.startsWith("cli/"), note: "" }, files, repo()), "");
    assert.equal(coverageNote({ keep: (f) => f !== "top.py", note: "" }, files, repo()), "");
    assert.equal(coverageNote(null, files, repo()), "");
  });
  it("comes from runScope's own answer, so where bugs go is unchanged", () => {
    const r = repo(), scope = runScope("python -m pytest api", "python", files, r);
    assert.ok(scope);
    assert.match(coverageNote(scope, files, r), /about 40% of the code/);
  });
});

describe("Go modules a root go test never reaches", () => {
  const go = { "go.mod": "module m\n", "a.go": "package m\n", "plugins/x/go.mod": "module x\n", "plugins/x/x.go": "package x\n" };
  it("names the folder and the exact flags", () => {
    const h = nestedModulesHint(repoWith(go), ["a.go", "plugins/x/x.go"]);
    assert.match(h, /never runs plugins\/x/);
    assert.match(h, /--exclude plugins\/x/);
    assert.match(h, /--path plugins\/x --test-cmd "cd plugins\/x && go test \.\/\.\.\."/);
  });
  it("says nothing when a go.work joins them, or no bug could land there", () => {
    assert.equal(nestedModulesHint(repoWith({ ...go, "go.work": "go 1.22\n" }), ["a.go", "plugins/x/x.go"]), "");
    assert.equal(nestedModulesHint(repoWith(go), ["a.go"]), "");
  });
});

describe("a file the tests need that a clean copy lacks", () => {
  const log = (text: string) => { const f = path.join(tempDir(), "1.log"); fs.writeFileSync(f, text); return f; };
  const setup = () => {
    const repo = repoWith({ "a.py": "x\n", "packages/core/a.py": "x\n", ".gitignore": "dist/\n.env.test\n" });
    fs.writeFileSync(path.join(repo, ".env.test"), "S=1\n");
    fs.mkdirSync(path.join(repo, "packages/core/dist"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages/core/dist/index.js"), "x\n");
    fs.mkdirSync(path.join(repo, "dist"));
    fs.writeFileSync(path.join(repo, "dist/x"), "x\n");
    fs.mkdirSync(path.join(repo, "node_modules/p"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules/p/i.js"), "x\n");
    return repo;
  };
  it("names what the output names, with the exact flag", () => {
    const repo = setup();
    assert.match(copyHint(repo, "/tmp/w/wt", [log("Error: ENOENT: no such file or directory, open '.env.test'\n")]), /Try: --copy \.env\.test$/);
    assert.match(copyHint(repo, "/tmp/w/wt", [log("Cannot find module '/tmp/w/wt/packages/core/dist/index.js'\n")]), /Try: --copy packages\/core\/dist$/);
    assert.match(copyHint(repo, "/tmp/w/wt", [log("open ./dist/x: no such file\n")]), /Try: --copy dist$/);
    assert.match(copyHint(repo, "/tmp/w/wt", [log("nothing here\n"), log("missing: '.env.test'\n"), path.join(repo, "no-such-log")]), /--copy \.env\.test/);
  });
  it("stays quiet on a look-alike, and never offers node_modules", () => {
    const repo = setup();
    for (const text of ["/usr/lib/node/dist/x failed", "the distance is wrong", "my.env.test.bak", "'node_modules' missing", "/tmp/w/wt/node_modules/p/i.js"]) assert.equal(copyHint(repo, "/tmp/w/wt", [log(`${text}\n`)]), "", text);
  });
  it("a real run prints the exact flag for the missing file", { timeout: 60_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    fs.appendFileSync(path.join(repo, "tests", "test_pricing.py"), "\n    def test_env_file(self):\n        self.assertIn('SECRET', open('.env').read())\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "more"], { cwd: repo });
    const list = path.join(base, "one.json");
    fs.writeFileSync(list, JSON.stringify({ bugs: [{ id: "x", title: "t", file: "pricing.py", old: "total * 0.9", new: "total * 0.8" }] }));
    const r = await cli(repo, ["--bugs-file", list], { tmp });
    assert.equal(r.code, 1);
    assert.match(r.err, /Try: --copy \.env\n?/);
  });
});

describe("a repository whose root runs no tests", () => {
  const pkg = (scripts: object) => JSON.stringify({ name: "x", scripts });
  it("gives the exact command for each part that has its own tests", () => {
    const repo = repoWith({
      "package.json": pkg({}), "packages/a/package.json": pkg({ test: "vitest run" }), "packages/b/package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }), "packages/c/package.json": pkg({}),
      "examples/demo/package.json": pkg({ test: "vitest" }), "tests/helper/package.json": pkg({ test: "vitest" }),
    });
    assert.equal(partsHint(repo, "typescript"), 'This repository has separate parts, so test one at a time:\n  trenyx run --path packages/a --test-cmd "cd packages/a && npm test"');
  });
  it("uses the project's own package manager, stops at three, and covers the other languages", () => {
    const three = Object.fromEntries(["a", "b", "c", "d"].map((n) => [`p/${n}/package.json`, pkg({ test: "jest" })]));
    const h = partsHint(repoWith({ ...three, "pnpm-lock.yaml": "x\n" }), "typescript");
    assert.equal(h.split("\n").length, 4);
    assert.match(h, /cd p\/a && pnpm test/);
    assert.match(partsHint(repoWith({ "svc/a/go.mod": "module a\n" }), "go"), /--path svc\/a --test-cmd "cd svc\/a && go test \.\/\.\.\."/);
    assert.match(partsHint(repoWith({ "crates/a/Cargo.toml": "[package]\n" }), "rust"), /cd crates\/a && cargo test/);
    assert.match(partsHint(repoWith({ "svc/a/pyproject.toml": "[project]\n" }), "python"), /cd svc\/a && python3 -m pytest/);
  });
  it("says nothing with no parts", () => assert.equal(partsHint(repoWith({ "go.mod": "module a\n" }), "go"), ""));
  it("a Node monorepo with no root test script gets the command, not just a refusal", { timeout: 30_000 }, async () => {
    const repo = repoWith({ "package.json": pkg({}), "packages/a/package.json": pkg({ test: "jest" }) }), tmp = tempDir();
    const r = await cli(repo, ["--bugs-file", "x"], { tmp });
    assert.equal(r.code, 1);
    assert.match(r.err, /No test script found/);
    assert.match(r.err, /trenyx run --path packages\/a --test-cmd "cd packages\/a && npm test"/);
  });
});
