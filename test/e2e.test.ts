import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { FIXTURES, LANGS, TOOL, cli, hasTool, makeRepo, treeHash } from "./helpers.js";

const LIMIT = { go: "30", python: "15", typescript: "15", rust: "60" };

for (const lang of LANGS) {
  describe(`end to end: ${lang}`, { skip: hasTool(TOOL[lang]) ? false : `${TOOL[lang]} not installed` }, () => {
    const bugs = path.join(FIXTURES, `${lang}.bugs.json`);

    it("scores the canned bugs and leaves the repository byte-identical", { timeout: 180_000 }, async () => {
      const { repo, tmp, base } = makeRepo(lang), before = treeHash(repo), out = path.join(base, "report.md");
      const r = await cli(repo, ["--bugs-file", bugs, "--timeout", LIMIT[lang], "--out", out], { tmp });
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /Bug list fingerprint \(SHA-256\): [0-9a-f]{64}/);
      assert.ok(r.out.indexOf("fingerprint") < r.out.indexOf("[1/4]"), "the fingerprint prints before any bug runs");
      assert.match(r.out, /B01 .*caught \(1 test\)/);
      assert.match(r.out, /B02 .*got through/);
      assert.match(r.out, /B03 .*did not build/);
      assert.match(r.out, /B04 .*hung the tests/);
      assert.match(r.out, /Score: 1 of 2 counted; 1 to 3 of 4 if those two count\./);
      assert.match(r.out, /self-run score, not an independent Trenyx result/);
      assert.match(r.out, /AI output can be wrong/);
      assert.match(r.out, /No code was sent anywhere\./);
      assert.doesNotMatch(r.out, /seed/i, "a saved list draws no kinds");
      assert.match(r.out, /Before anything runs:\n  Your tests \(.+\) will run 6 to 15 times, in a temporary copy: .*trenyx-.*\n  Each bug is written only into that copy\. Your repository is never changed\.\n  Your tests can still reach what they normally reach/);
      assert.ok(r.out.indexOf("Before anything runs") < r.out.indexOf("Clean run 1"), "the notice prints before any test runs");
      assert.doesNotMatch(r.out + fs.readFileSync(out, "utf8"), /WARNING/);
      const md = fs.readFileSync(out, "utf8");
      assert.match(md, /self-run score, not an independent Trenyx result/);
      assert.match(md, /AI output can be wrong/);
      assert.match(md, /\*\*Score: 1 of 2 counted; 1 to 3 of 4 if those two count\.\*\*/);
      assert.match(md, /an order of exactly 100 pays full price/);
      assert.match(md, /\.(py|go|ts|rs):\d+/);
      assert.equal(treeHash(repo), before, "the repository changed");
      assert.deepEqual(fs.readdirSync(tmp), [], "the temp folder was not cleaned");
      assert.ok(!fs.existsSync(path.join(base, "hook-ran")), "a hook of the developer's ran");
    });

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      it(`cleans up and leaves the repository byte-identical after ${sig}`, { timeout: 120_000 }, async () => {
        const { repo, tmp } = makeRepo(lang), before = treeHash(repo);
        const list = path.join(tmp, "..", "hang.json");
        const all = JSON.parse(fs.readFileSync(bugs, "utf8")) as { bugs: { id: string }[] };
        fs.writeFileSync(list, JSON.stringify({ bugs: [all.bugs[3], all.bugs[0]] }));
        let sent = false;
        const r = await cli(repo, ["--bugs-file", list, "--timeout", "60", "--out", path.join(tmp, "..", "x.md")], {
          tmp, onOutput: (text, kill) => { if (!sent && text.includes("[1/2]")) { sent = true; setTimeout(() => kill(sig), 400); } },
        });
        assert.ok(sent, r.out + r.err);
        assert.equal(r.code, sig === "SIGINT" ? 130 : 143, r.out + r.err);
        assert.equal(treeHash(repo), before, "the repository changed");
        assert.deepEqual(fs.readdirSync(tmp), [], "the temp folder was not cleaned");
      });
    }
  });
}

describe("end to end: refusals", () => {
  it("refuses with no key, before any test runs", async () => {
    const { repo, tmp } = makeRepo("python");
    const r = await cli(repo, [], { tmp });
    assert.equal(r.code, 1);
    assert.match(r.err, /No AI key found/);
    assert.doesNotMatch(r.out, /Clean run/);
  });

  for (const file of ["../outside.py", "/etc/hosts"]) {
    it(`stops a bug list naming ${file} before any test runs`, async () => {
      const { repo, tmp, base } = makeRepo("python"), before = treeHash(repo);
      fs.writeFileSync(path.join(base, "outside.py"), "x = 1\n");
      const list = path.join(base, "out.json");
      fs.writeFileSync(list, JSON.stringify({ bugs: [{ id: "a", title: "t", file: "pricing.py", old: "if total >= 100:", new: "if total > 100:" }, { id: "b", title: "t", file, old: "x = 1", new: "x = 2" }] }));
      const r = await cli(repo, ["--bugs-file", list], { tmp });
      assert.equal(r.code, 1, r.out + r.err);
      assert.match(r.err, /outside the temporary copy\. No bug ran/);
      assert.doesNotMatch(r.out, /Clean run|Before anything runs/);
      assert.equal(fs.readFileSync(path.join(base, "outside.py"), "utf8"), "x = 1\n");
      assert.equal(treeHash(repo), before);
      assert.deepEqual(fs.readdirSync(tmp), []);
    });
  }

  it("says loudly when the repository changed during the run", { timeout: 60_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    fs.appendFileSync(path.join(repo, "tests", "test_pricing.py"), `
    def test_writes_home(self):
        open(${JSON.stringify(path.join(repo, "left-behind.txt"))}, "w").write("x")
`);
    const git = (await import("node:child_process")).execFileSync;
    git("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "writes"], { cwd: repo });
    const list = path.join(base, "one.json"), out = path.join(base, "r.md");
    fs.writeFileSync(list, JSON.stringify({ bugs: [{ id: "x", title: "t", file: "pricing.py", old: "if total >= 100:", new: "if total > 100:" }] }));
    const r = await cli(repo, ["--bugs-file", list, "--out", out], { tmp });
    assert.match(r.out, /WARNING: your repository changed while this ran/);
    assert.match(fs.readFileSync(out, "utf8"), /\*\*WARNING: your repository changed/);
  });

  it("refuses outside a git repository", async () => {
    const { tmp } = makeRepo("python");
    const r = await cli(tmp, ["--bugs-file", "x"], { tmp });
    assert.equal(r.code, 1);
    assert.match(r.err, /inside a git repository/);
  });

  it("refuses a dirty baseline and names the failing test", async () => {
    const { repo, tmp } = makeRepo("python");
    fs.appendFileSync(path.join(repo, "tests", "test_pricing.py"), "\n    def test_always_broken(self):\n        self.fail('no')\n");
    const git = (await import("node:child_process")).execFileSync;
    git("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "broken"], { cwd: repo });
    const r = await cli(repo, ["--bugs-file", path.join(FIXTURES, "python.bugs.json")], { tmp });
    assert.equal(r.code, 1);
    assert.match(r.err, /do not pass on a clean copy/);
    assert.match(r.err, /test_always_broken/);
    assert.match(r.err, /This test fails on all \d+ clean runs, which usually means it depends on your setup/);
    assert.match(r.err, /To set it aside and continue:\n  trenyx run --allow-failing\n\nOther options:/, "the exact next step comes first, the other options after it");
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("subtracts a flaky test: a bug failing only that test is never a catch", { timeout: 60_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python"), state = path.join(base, "flaky-state");
    // fails on the second run of the suite only, and on every run from the fourth on
    fs.appendFileSync(path.join(repo, "tests", "test_pricing.py"), `
    def test_flaky(self):
        import os
        p = ${JSON.stringify(state)}
        n = int(open(p).read()) + 1 if os.path.exists(p) else 1
        open(p, "w").write(str(n))
        self.assertTrue(n != 2 and n < 3)
`);
    const git = (await import("node:child_process")).execFileSync;
    git("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "flaky"], { cwd: repo });
    const list = path.join(base, "one.json");
    fs.writeFileSync(list, JSON.stringify({ bugs: [{ id: "x", title: "an order of exactly 100 pays full price", file: "pricing.py", old: "if total >= 100:", new: "if total > 100:" }] }));
    const r = await cli(repo, ["--bugs-file", list, "--out", path.join(base, "r.md")], { tmp });
    assert.match(r.out, /1 flaky test left out/);
    assert.match(r.out, /B01 .*unclear, not counted/);
    assert.match(r.out, /Score: 0 of 0/);
  });

  it("a test failing the first two clean runs, then passing, is flaky and doesn't stop the run", { timeout: 60_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python"), state = path.join(base, "twice-state");
    fs.appendFileSync(path.join(repo, "tests", "test_pricing.py"), `
    def test_twice(self):
        import os
        p = ${JSON.stringify(state)}
        n = int(open(p).read()) + 1 if os.path.exists(p) else 1
        open(p, "w").write(str(n))
        self.assertTrue(n > 2)
`);
    const git = (await import("node:child_process")).execFileSync;
    git("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "twice"], { cwd: repo });
    const list = path.join(base, "one.json");
    fs.writeFileSync(list, JSON.stringify({ bugs: [{ id: "x", title: "an order of exactly 100 pays full price", file: "pricing.py", old: "if total >= 100:", new: "if total > 100:" }] }));
    const r = await cli(repo, ["--bugs-file", list, "--out", path.join(base, "r.md")], { tmp });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Clean run 3 of 4/);
    assert.doesNotMatch(r.out, /Clean run 4 of 4/);
    assert.match(r.out, /1 flaky test left out/);
    assert.doesNotMatch(r.err, /do not pass/);
  });

  it("a test that passes both clean runs, then fails without the bug, loses its catch", { timeout: 60_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python"), state = path.join(base, "unstable-state");
    // passes the two clean runs, fails both runs of the bug, and fails again on the first clean check
    fs.appendFileSync(path.join(repo, "tests", "test_pricing.py"), `
    def test_unstable(self):
        import os
        p = ${JSON.stringify(state)}
        n = int(open(p).read()) + 1 if os.path.exists(p) else 1
        open(p, "w").write(str(n))
        self.assertFalse(3 <= n <= 5)
`);
    const git = (await import("node:child_process")).execFileSync;
    git("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "unstable"], { cwd: repo });
    const list = path.join(base, "one.json");
    fs.writeFileSync(list, JSON.stringify({ bugs: [{ id: "x", title: "an order of exactly 100 pays full price", file: "pricing.py", old: "if total >= 100:", new: "if total > 100:" }] }));
    const r = await cli(repo, ["--bugs-file", list, "--out", path.join(base, "r.md")], { tmp });
    assert.match(r.out, /Checking the catches, clean run 3 of 3/);
    assert.match(r.out, /B01: caught only by a test that also fails without the bug/);
    assert.match(r.out, /Score: 0 of 0/);
  });

  it("--list-files shows what could be sent, without tests or untracked files, and sends nothing", async () => {
    const { repo, tmp } = makeRepo("python");
    const r = await cli(repo, ["--list-files"], { tmp });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /pricing\.py/);
    assert.doesNotMatch(r.out, /test_pricing|\.env|notes\.txt/);
    assert.match(r.out, /Nothing was sent/);
    const skip = await cli(repo, ["--list-files", "--exclude", "pricing.py"], { tmp });
    assert.equal(skip.code, 1);
    assert.match(skip.err, /No product source files/);
  });
});

describe("end to end: what a real project needs", () => {
  const one = (base: string, bug: object) => { const f = path.join(base, "one.json"); fs.writeFileSync(f, JSON.stringify({ bugs: [bug] })); return f; };
  const bug = { id: "x", title: "large orders get 20% off", file: "pricing.py", old: "total * 0.9", new: "total * 0.8" };
  const commit = async (repo: string) => { (await import("node:child_process")).execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "more"], { cwd: repo }); };

  it("--copy brings an untracked file the tests need, into the copy only", { timeout: 60_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    fs.appendFileSync(path.join(repo, "tests", "test_pricing.py"), "\n    def test_env_file(self):\n        self.assertIn('SECRET', open('.env').read())\n");
    await commit(repo);
    const before = treeHash(repo), list = one(base, bug);
    const no = await cli(repo, ["--bugs-file", list], { tmp });
    assert.equal(no.code, 1);
    assert.match(no.err, /do not pass on a clean copy|--copy/);
    const yes = await cli(repo, ["--bugs-file", list, "--copy", ".env", "--out", path.join(base, "r.md")], { tmp });
    assert.equal(yes.code, 0, yes.out + yes.err);
    assert.match(yes.out, /Score: 1 of 1/);
    assert.equal(treeHash(repo), before);
  });

  it("carries node_modules into the copy and never touches the original", { timeout: 60_000, skip: hasTool("node") ? false : "no node" }, async () => {
    const { repo, tmp, base } = makeRepo("typescript");
    fs.mkdirSync(path.join(repo, "node_modules", "fake-dep"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "fake-dep", "index.js"), "export const rate = 0.9;\n");
    fs.writeFileSync(path.join(repo, "node_modules", "fake-dep", "package.json"), JSON.stringify({ name: "fake-dep", version: "1.0.0", type: "module", main: "index.js" }));
    fs.appendFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ ...pkg, dependencies: { "fake-dep": "1.0.0" } }));
    fs.appendFileSync(path.join(repo, "src", "pricing.test.ts"), 'import { rate } from "fake-dep";\ntest("dep loads", () => assert.equal(rate, 0.9));\n');
    await commit(repo);
    const before = treeHash(repo);
    const r = await cli(repo, ["--bugs-file", one(base, { id: "x", title: "t", file: "src/pricing.ts", old: "total * 0.9", new: "total * 0.8" }), "--out", path.join(base, "r.md")], { tmp });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Score: 1 of 1/);
    assert.equal(treeHash(repo), before);
  });

  it("one run's side effects never reach the next: a suite that deletes node_modules still runs every bug", { timeout: 90_000 }, async () => {
    const { repo, tmp, base } = makeRepo("typescript");
    fs.mkdirSync(path.join(repo, "node_modules", "fake-dep"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "fake-dep", "index.js"), "export const rate = 0.9;\n");
    fs.writeFileSync(path.join(repo, "node_modules", "fake-dep", "package.json"), JSON.stringify({ name: "fake-dep", version: "1.0.0", type: "module", main: "index.js" }));
    fs.appendFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ ...pkg, dependencies: { "fake-dep": "1.0.0" } }));
    fs.appendFileSync(path.join(repo, "src", "pricing.test.ts"), 'import { rmSync } from "node:fs";\nimport { rate } from "fake-dep";\ntest("dep loads, then the suite wipes its node_modules", () => { assert.equal(rate, 0.9); rmSync("node_modules", { recursive: true }); });\n');
    await commit(repo);
    const before = treeHash(repo), list = path.join(base, "two.json");
    fs.writeFileSync(list, JSON.stringify({ bugs: [{ id: "x", title: "t", file: "src/pricing.ts", old: "total * 0.9", new: "total * 0.8" }, { id: "y", title: "u", file: "src/pricing.ts", old: "if (total >= 100) {", new: "if (total > 100) {" }] }));
    const r = await cli(repo, ["--bugs-file", list, "--out", path.join(base, "r.md")], { tmp });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /2 bugs locked/);
    assert.match(r.out, /Score: 1 of 2/);
    assert.equal(treeHash(repo), before);
  });

  it("works from a shallow clone", { timeout: 60_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python"), shallow = path.join(base, "shallow");
    (await import("node:child_process")).execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow]);
    const before = treeHash(shallow);
    const r = await cli(shallow, ["--bugs-file", one(base, bug), "--out", path.join(base, "r.md")], { tmp });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Score: 1 of 1/);
    assert.equal(treeHash(shallow), before);
  });
});

describe("end to end: no network at all", { skip: process.platform === "darwin" ? false : "uses macOS sandbox-exec" }, () => {
  for (const lang of LANGS) {
    it(`a whole run passes with every network call denied by the OS: ${lang}`, { skip: hasTool(TOOL[lang]) ? false : "not installed", timeout: 120_000 }, async () => {
      const { repo, tmp, base } = makeRepo(lang);
      const all = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${lang}.bugs.json`), "utf8")) as { bugs: unknown[] };
      const list = path.join(base, "two.json");
      fs.writeFileSync(list, JSON.stringify({ bugs: all.bugs.slice(0, 2) }));
      const r = await cli(repo, ["--bugs-file", list, "--out", path.join(base, "r.md")], { tmp, prefix: ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"] });
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /Score: 1 of 2/);
    });
  }
});
