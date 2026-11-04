import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Stop } from "./types.js";

const gitEnv = () => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[k];
  return env;
};

/** A read-only git question. --no-optional-locks: even `git status` leaves the index file alone. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", ...args], { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = process.platform === "darwin" ? spawnSync("cp", ["-cRp", src, dst]) : spawnSync("cp", ["-a", "--reflink=auto", src, dst]);
  if (r.status !== 0) {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  }
}

/** A cheap copy from the run's own store into a throwaway copy: a clone where the disk has them, else hard links. The
 * store is ours and the original is never linked, so nothing a test does can reach the developer's files. */
function linkTree(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  for (const args of process.platform === "darwin" ? [["-cRp"]] : [["-a", "--reflink=always"], ["-al"]]) {
    if (spawnSync("cp", [...args, src, dst]).status === 0) return;
    fs.rmSync(dst, { recursive: true, force: true });
  }
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

/** Throwaway copies under one temp folder. Each one is `git clone --shared`, not `git worktree add`: a clone has its own
 * refs and stash, so a test that runs git cannot reach the developer's branches or stash, it writes nothing into their
 * .git, runs none of their hooks, and a killed run leaves nothing behind in the repository. Its remote is removed, so a
 * test cannot push back. Every run gets a fresh copy at the same path. `carry` folders (node_modules, --copy) are copied
 * from the developer's tree once, into a store, and each run gets its own copy of the store, so one run's side effects
 * never reach the next: each bug starts from the same state. */
export class Workspace {
  readonly root: string;
  readonly wt: string;
  readonly src: string;
  private readonly store: string;
  private stored = false;

  constructor(private readonly repo: string, private readonly sha: string, private readonly carry: string[]) {
    this.root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "trenyx-"));
    this.wt = path.join(this.root, "wt");
    this.src = path.join(this.root, "src");
    this.store = path.join(this.root, "store");
  }

  private clone(dest: string): void {
    const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false", ...args], { cwd, env: gitEnv(), stdio: "pipe" });
    try {
      run(this.root, "clone", "--quiet", "--shared", "--no-checkout", this.repo, dest);
      run(dest, "checkout", "--quiet", "--detach", this.sha);
      run(dest, "remote", "remove", "origin");
    } catch (e) {
      throw new Stop(`Could not make a clean copy of the repository: ${String((e as { stderr?: Buffer }).stderr ?? e).trim().split("\n")[0]}`);
    }
  }

  /** The pristine copy: committed files only. The blind view is built from this, never from the working tree, so
   * untracked files such as .env can never reach the provider. */
  pristine(): string {
    if (!fs.existsSync(this.src)) this.clone(this.src);
    return this.src;
  }

  fresh(): string {
    fs.rmSync(this.wt, { recursive: true, force: true, maxRetries: 3 });
    this.clone(this.wt);
    this.carry.forEach((rel, i) => {
      const kept = path.join(this.store, String(i));
      if (!this.stored && fs.existsSync(path.join(this.repo, rel))) copyTree(path.join(this.repo, rel), kept);
      if (fs.existsSync(kept)) linkTree(kept, path.join(this.wt, rel));
    });
    this.stored = true;
    return this.wt;
  }

  destroy(): void {
    try { fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 3 }); } catch {
      spawnSync("chmod", ["-R", "u+w", this.root]);
      fs.rmSync(this.root, { recursive: true, force: true });
    }
  }
}
