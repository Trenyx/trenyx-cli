# trenyx run

**Early release.** Scores are self-run and can differ from Trenyx's independent runs.

Plants realistic bugs in a throwaway copy of your repo, runs your tests against each one, and tells you which got through.
Everything runs on your machine. Your code goes only to the AI provider you already use, through your own key. Nothing goes
to Trenyx: there is no telemetry, no upload and no Trenyx server in this version.

```sh
cd your-repo            # a git repo with passing tests
export ANTHROPIC_API_KEY=...
npx trenyx run
```

What you see: it runs your tests twice on a clean copy of your last commit, says which provider gets the code and how many
files, and asks before sending anything. Then it locks the bug list with a SHA-256 fingerprint, prints where the bugs went,
runs each bug alone, and prints the score and every bug that got through, with file and line. A markdown report goes to
`~/.trenyx/reports/` (or `--out`). The score is a self-run score, not an independent Trenyx result. AI output can be wrong, so
check the bugs and the score before you rely on them. For an independent measure, run by Trenyx and not by you, see
https://trenyx.io.

`trenyx run --help` lists the options. The useful ones: `--bugs N`, `--test-cmd`, `--path`, `--exclude`, `--copy`,
`--list-files`, `--bugs-file`, `--max-cost`, `--seed`.

## Where your code goes

| What | Where |
|---|---|
| Product source at your last commit, tests removed | Your provider, and only the files the bug writer chooses to open. `--list-files` shows every file it could open; `--path` and `--exclude` narrow that. |
| Tests, untracked files, `.env`, `.git` history | Nowhere. The view is built from a clean copy of committed files only, and links are never followed. |
| Your API key | The provider's client only. Tests and bugs run with it removed from their environment. |
| Anything, to Trenyx | Nothing. The code has no network calls of its own; the only package it uses is the provider's SDK. |

The bug writer is a small loop of our own over the plain Claude API (`src/loop.ts`), with three tools (`src/tools.ts`): list,
read and search, inside the view and nothing else. There is no write, shell, web or MCP tool to ask for. A check runs on every
call, and a file that isn't on the view's list reads exactly like one that doesn't exist. The only credential read is the chosen
provider's: the key is passed in code, and anything else an SDK would pick up by itself (an auth token, a subscription token, a
saved profile, custom headers, a log setting) is removed from the process first. A run makes the model call and nothing else, and
saves no session. If `ANTHROPIC_BASE_URL` is set, the screen names that host instead.

Behind a proxy, set `NODE_USE_ENV_PROXY=1` as well as `HTTPS_PROXY` (Node 22.21 or later): Node's own HTTP client ignores
`HTTPS_PROXY` without it.

**The tests run on your machine like any test run**, with the bugs in them. An AI wrote those bugs, so read them if your
tests can do real damage: `--bugs-file` runs a list you have checked. A bug that adds a process, a network call or a read
of credentials is dropped before it runs, but that filter is a check, not a sandbox.

## What it does to your repository

Nothing. Each run happens in a `git clone --shared` in the system temp folder, with its remote removed, so a test that runs
git cannot reach your branches or stash, your hooks do not run, and nothing is written into your `.git`. `node_modules` and
anything named by `--copy` are copied once into that folder, and every run gets its own copy of them, so each bug starts
from the same state. The temp folder is removed at the end, on Ctrl-C, on SIGTERM and on a crash. A `kill -9` leaves only
that folder behind.

## Where the bugs go

A score only means something if the bugs land where bugs land. Left alone, a writer picks small self-contained files, which
is where a good suite is strongest, so the spread is a rule the run enforces, not a request:

- **The plan comes first.** Files in the project's language are grouped by folder, and any folder with more than an eighth of
  the code is split into its subfolders. Each folder gets bugs in proportion to its code (one file counts for 1,500 lines at most).
- **Limits.** At most 2 bugs in a file, 30% of the bugs in a folder (more only where a folder holds more of the code, as in a
  flat package), and 25% of the bugs in files smaller than the project's median file. A project with few files loosens the file
  limit, because the bugs have nowhere else to go.
- **Kept out by name:** dot folders, generated code, type and config files, and support folders such as `scripts/`, `examples/`
  and `benchmarks/` above the source root.
- **Enforced.** A bug that breaks a limit is dropped and the report says why. A folder left short gets one narrow second pass,
  and if that fails too, the run says plainly which folders are short.
- **Blind.** The plan sees the view, the language and the bug count, nothing else: never a test, a test file, or which code is
  tested. Tests are gone from the sizes too.

The run output and the report show where the bugs went; the report adds what the tests did in each folder. A saved list
(`--bugs-file`) runs as written, and the limits are shown as not applied.

If your test command covers only part of the repository, use `--path` for that part: a bug in code your command never runs
will always read as got through. The run says so where it can tell, and prints the flag to use:

- a test command that names a folder gets `--path` for it;
- Go folders with their own `go.mod`, which a root `go test ./...` never reaches, get `--exclude`;
- when the clean runs fail on something the output names and a clean copy lacks, it prints `--copy` for that;
- when the root runs no tests but parts of the repository have their own project file, it prints the command for each part.

These read names and the test output only, never reach the bug writer, and change nothing by themselves. There is no coverage
check, so a folder your tests miss for any other reason is not flagged: it reads as bugs that got through.

## Which kinds of bug

The kinds bundled here are a small subset of the Trenyx bug catalogue: 63 kinds out of about 1,000, each with its name and a
one-line how-to, and no miss rates. The full catalogue grows with every independent Trenyx run and stays with the hosted service.

Each run gives the writer a random two-thirds of the bundled kinds for your language, so a suite can't be tuned to a fixed list.
The run prints its seed, and `--seed` draws the same kinds again. It does not repeat the bugs, because the AI writes those fresh
each time: to run the same bugs again, use `--bugs-file`.

## What it costs

16 bugs is the default and the most: US$0.64 to US$0.99 of AI cost on the two real projects measured so far. `--max-cost` (default US$5) covers the first list, its one retry and the second pass
together. Cost comes from the token counts the API returns, at Anthropic's list prices; on Bedrock and Vertex that is an
estimate, because they bill separately. Each reply is held to what the money left can buy, the run stops at 90% of your limit to
leave room for a last turn, and the second pass may use at most a third of it. A run that hits the limit before a bug list comes
back runs nothing and says what it spent.

## Bedrock and Vertex

Set `CLAUDE_CODE_USE_BEDROCK=1` with your AWS setup and `AWS_REGION`, or `CLAUDE_CODE_USE_VERTEX=1` with your Google Cloud setup,
`CLOUD_ML_REGION` and `ANTHROPIC_VERTEX_PROJECT_ID`. Their clients are large, so they stay out of the normal install:

```sh
npx --package=trenyx --package=@anthropic-ai/bedrock-sdk trenyx run      # or @anthropic-ai/vertex-sdk
```

## How bugs are scored

The same rules as the Trenyx engine, where they apply. Tests that fail on either clean run never count as a catch; tests that
fail on only one are flaky and left out. Caught means a new failing test, and each catch is re-run once and must fail one of
the same tests again. A hang counts as caught only on new failing tests that reproduce, otherwise it is left out. A broken
build, and a run that only crashes, are left out too. The score is caught over counted. When bugs are left out, the score shows
how far they could move it, for example "11 of 12 counted; 11 to 15 of 16 if those four count."
A test that fails both clean runs gets two more before the run stops, so one unstable test doesn't end the check: a test that
fails some clean runs but not all is left out. Only a test failing all four stops the run.

Two passing clean runs can't rule out a test that fails now and then, and such a test reads as a catch for any bug. So when
anything was caught, the suite runs clean three more times. A catch resting only on tests that went both ways on identical
code, in those runs or across a bug's own two runs, is not counted.

A second line says how far the score could move on another draw of bugs, an 80% Wilson interval on caught over counted, for
example "Likely between 4 and 8 of 15 if different bugs were drawn." The two ranges measure different things.

## Try it from this folder

```sh
npm ci && npx tsc -p . && npm pack          # needs Node 20.3 or later (22 for the tests)
cd your-repo && npx --package=/path/to/trenyx-0.0.1.tgz trenyx run
```

## Tests

```sh
npm test                                    # needs go, cargo, python3 and Node 22; a missing toolchain is skipped by name
```

Unit tests use a fake API client, the SDK tests run the real client against a fake provider on localhost, and a Trenyx-side tool replays an engine run's bug list through the spread rule (placement only,
never scores). End-to-end tests run a tiny repo in each language with canned bugs and hash every byte of it,
`.git` included, before and after, also after SIGINT and SIGTERM. On macOS a run also passes with every network call denied by
the OS. With pytest on the PATH the Python tests use pytest, otherwise unittest.

## What ships, and how it was chosen

`src/rules.gen.ts` is generated from the engine's blind view; `src/blind.ts` ports the logic, and the port is measured against
the engine on real checkouts. `catalogue/slice.json` is the bundled catalogue
(built by Trenyx's own tools, which aren't in this repository): for each language, the classes marked for every domain, ranked by how many repositories they were
planted in, never by whether they were caught, at most 36 per language, name and one-line how-to only.  Bug writing sits behind `BugWriter` (`src/writer.ts`) and the catalogue behind `CatalogueSource`
(`src/catalogue.ts`), so neither the run nor the report depends on where they come from.

## Trademarks

The code is Apache 2.0, which does not grant rights to the Trenyx name (Apache 2.0, section 6). You may say a project was checked with the trenyx CLI. Only results that Trenyx runs itself may be called a Trenyx result or a Trenyx score; a self-run score is not one. See [TRADEMARKS.md](TRADEMARKS.md).

## Licence

The code is Apache-2.0 (`LICENSE`); the bug catalogue in `catalogue/` has its own terms (`catalogue/LICENSE`): use it through this
package on your own code, including at work, but don't copy it out.
