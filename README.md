# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kjr1997/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kjr1997/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library
only, with its own in-memory storage: git smart HTTP (clone/fetch/push,
protocol v0 and v2, shallow clones, annotated tags), REST v3 (repositories,
branches, commits, contents, issues, labels, comments, pull requests,
squash merges), GraphQL v4 (queries, mutations, Relay node ids, cursor
pagination, introspection) and MCP over streamable HTTP (server/discover,
initialize, six tools). No UI, no database, no network at runtime, no model
calls — the entry is a scripted program.

## Run it

Prerequisite: Node 22.18+ (the trial runs `node /bot/main.ts`; locally
`node --experimental-strip-types main.ts` works on Node 24 too). No
dependencies to install, nothing to build.

```sh
npm start
```

`main.ts` is the trial lifecycle (kept as the kit shipped it): it binds an
ephemeral port (never 8080), registers it at `$MAKEFUN_ENV_URL/register`,
answers `GET /healthz`, then polls `$MAKEFUN_ENV_URL/done` until the trial
ends and exits 0. Without `MAKEFUN_ENV_URL` it exits 1 at once — that
variable is the trial environment's, not something to set by hand.

The server itself is `app.ts`: one `Store` for the process's whole life,
four surfaces on one port.

| Surface | Path | Auth |
| --- | --- | --- |
| Health | `GET /healthz` | none |
| Git smart HTTP | `/:owner/:repo.git/info/refs`, `/git-upload-pack`, `/git-receive-pack` | none (the git wire) |
| REST v3 | `/api/v3/*` | `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` |
| GraphQL v4 | `POST /api/graphql` | bearer token |
| MCP | `POST /mcp` | bearer token |

Every API reply is JSON and carries `X-GitHub-Request-Id`. A missing or
wrong token is 401; an unknown route is a JSON 404 `{"message":"Not Found"}`;
a malformed JSON body is 400 (on `/mcp` it is JSON-RPC `-32700`).

## Layout

- `main.ts` — trial lifecycle only (unchanged from the kit starter).
- `app.ts` — HTTP server: routing, auth gate, JSON body parsing.
- `http.ts` — request context, replies, token check.
- `store.ts` — the in-memory store: repositories, git objects, refs, issues,
  pull requests, labels, comments, and the opaque Relay global ids.
- `gitobj.ts` — SHA-1 git objects (commit/tree/blob/tag), pkt-lines, pack
  read/write (OFS/REF deltas, thin packs), reachability, tree editing.
- `git.ts` — smart HTTP: v0/v2 advertisements, ls-refs, fetch (v0 + v2,
  shallow/deepen, held-set cut at shallow boundaries), receive-pack with
  per-ref `ok`/`ng` report-status (`non-fast-forward` is the exact reason).
- `rest.ts` — REST v3: repos, branches, commits, contents, git refs, labels,
  issues, comments, pull requests, files, squash merge with three-way
  conflict detection.
- `graphql.ts` — hand-written GraphQL lexer, parser and executor over the
  same store; batched operations; `__type` introspection for `Issue`,
  `PullRequest`, `Repository` and `SearchType`.
- `mcp.ts` — MCP 2026-07-28 (`server/discover`) and the legacy
  `initialize` handshake; six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`. Tool results carry both text JSON and
  `structuredContent`; unknown tools are JSON-RPC `-32602`, never HTTP 500.

## Design notes

- One store, four surfaces: a repository or issue created over MCP is the
  same object over REST and GraphQL, with the same stable numeric `id` and
  the same opaque global id.
- Everything is in-memory `Map`s; no filesystem writes in request paths.
  Fetch packs are cached per `(wants, haves, shallow, depth)` and the cache
  is cleared on any mutation, so repeated clones are near-free.
- Git packs carry full objects only; deltas are never emitted, only resolved
  when a client sends them (thin-pack `resolveBase`).
- The viewer is the seeded scenario user (`adaiversen`, id 1000); a
  repository under any other login is a 404, never a 403.

## Verify

```sh
node --experimental-strip-types /tmp/smoke.ts   # 87 checks: REST + GraphQL + MCP + real git
```

Local grading (from the kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process --worktree
```

Local grade-local runs on this machine: **961–987/1000** across runs
(feature 600/600, agent 200/200 in every run; perf 161–187 — the spread is
host CPU noise on this shared VM, not the code: identical code scored 187,
then 161, then 175 in three consecutive runs). The reference forge scored
120/120 conformance and 100/200 perf.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=151n8e75&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
