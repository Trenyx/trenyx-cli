# Security

## What `trenyx run` does and never does

- It copies your last commit into a temporary folder and plants each bug only there. It refuses any bug that points outside
  that copy (absolute paths, `..`, links), and checks afterwards that your repository is unchanged.
- It runs your own test command in that copy, so your tests can reach whatever they normally reach: the network, databases,
  environment variables. Run it where you would run your tests anyway.
- It sends source files only to the AI provider you configure, through your own key, and only files the bug writer chooses to
  open from a view with tests, untracked files, `.env` and `.git` history removed. `--list-files` shows every file it could open.
- It never sends anything to Trenyx. There is no telemetry, no upload and no Trenyx server. Your API key stays in the
  provider's client and is removed from the environment your tests run in.

## Reporting a problem

If you find a security problem in this tool, please email sk@trenyx.io with "trenyx-cli security" in the subject, rather than
opening a public issue. You'll get a reply within three working days. Please include the version (`trenyx run --version` or the
package version) and the steps to reproduce.
