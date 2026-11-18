// rest.ts — GitHub REST v3: repositories, branches, commits, contents, issues,
// comments, labels, pull requests, files and merges. Every reply is JSON and
// carries X-GitHub-Request-Id (the reply layer adds it); unknown routes are a
// JSON 404, malformed JSON bodies are a 400, missing tokens are a 401 and a
// repository under another login is a 404 (never 403).

import {
  buildCommit,
  flattenTree,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  treeLookup,
  type GitObject,
} from './gitobj.ts';
import type { Ctx, Reply } from './http.ts';
import {
  VIEWER,
  encodeGlobalId,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

const INSTALLED_VERSION = '1.0.0';

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyOf(ctx: Ctx): Record<string, unknown> {
  return isRecord(ctx.json) ? ctx.json : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function intQuery(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Split a path into segments, decoding each one. */
function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function originOf(ctx: Ctx): string {
  return `http://${ctx.host}`;
}

/** GitHub-style pagination: slice + a Link header (absolute, same origin). */
function paginate<T>(ctx: Ctx, reply: Reply, items: readonly T[], basePath: string): T[] {
  const perPage = Math.min(100, Math.max(1, intQuery(ctx, 'per_page', 30)));
  const page = Math.max(1, intQuery(ctx, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const links: string[] = [];
  const url = (p: number): string => `${originOf(ctx)}${basePath}${basePath.includes('?') ? '&' : '?'}per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  if (links.length > 0) replyLink = links.join(', ');
  return items.slice(start, start + perPage);
}

// The Link header is attached by the caller through this slot (paginate runs before reply.json).
let replyLink = '';

function linkHeader(): Record<string, string> {
  const link = replyLink;
  replyLink = '';
  return link === '' ? {} : { link };
}

// ---------------------------------------------------------------------------------------------
// serializers (extra fields are allowed by the checks' shapes; these mirror GitHub's)
// ---------------------------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: encodeGlobalId('user', login), type: 'User', site_admin: false };
}

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: encodeGlobalId('repo', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.private,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: encodeGlobalId('label', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGlobalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(VIEWER.login, VIEWER.id),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: encodeGlobalId('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: encodeGlobalId('comment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function identParts(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: new Date().toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]!) * 1000).toISOString() };
}

function historyEntryJson(repo: Repo, entry: { sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }): Record<string, unknown> {
  const author = identParts(entry.author);
  const committer = identParts(entry.committer);
  return {
    sha: entry.sha,
    node_id: encodeGlobalId('commit', repo.id, entry.sha),
    commit: {
      // GitHub's API returns the message without the raw object's trailing newline.
      message: entry.message.replace(/\n+$/, ''),
      author,
      committer,
      tree: { sha: entry.tree },
    },
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: entry.parents.map((sha) => ({ sha })),
  };
}

// ---------------------------------------------------------------------------------------------
// repository lookup
// ---------------------------------------------------------------------------------------------

/** The repository for an owner/name pair, or null (a foreign owner is a 404, never a 403). */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function findIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

function findPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function fileEntryJson(ctx: Ctx, repo: Repo, path: string, blob: GitObject, sha: string): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path,
    content: blob.data.toString('base64'),
    sha,
    url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
    download_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
  };
}

/** Resolve a ?ref= (branch, ref or commit id) to a tip commit, or null. */
function resolveTip(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return store.defaultTip(repo);
  const resolved = store.resolveRef(repo, ref);
  if (resolved !== null) return resolved;
  // A raw commit id (possibly shortened) is accepted as a ref too.
  if (/^[0-9a-f]{4,40}$/.test(ref)) {
    for (const oid of repo.objects.keys()) if (oid.startsWith(ref)) return oid;
  }
  return null;
}

/** A line diff between two texts: added/deleted line counts (multiset difference). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function pullFiles(store: Store, repo: Repo, pull: Pull): PullFile[] {
  const lookup = store.lookup(repo);
  const baseTree = pull.mergeBaseSha === null ? null : parseCommit(repo.objects.get(pull.mergeBaseSha)!.data).tree;
  const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
  const baseFiles = flattenTree(lookup, baseTree);
  const headFiles = flattenTree(lookup, headTree);
  const out: PullFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const baseOid = baseFiles.get(path);
    const headOid = headFiles.get(path);
    if (baseOid === headOid) continue;
    if (baseOid === undefined && headOid !== undefined) {
      const blob = repo.objects.get(headOid);
      const text = blob === undefined ? '' : blob.data.toString('utf8');
      const lines = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (headOid === undefined && baseOid !== undefined) {
      const blob = repo.objects.get(baseOid);
      const text = blob === undefined ? '' : blob.data.toString('utf8');
      const lines = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else {
      const oldBlob = repo.objects.get(baseOid!);
      const newBlob = repo.objects.get(headOid!);
      const diff = lineDiff(oldBlob?.data.toString('utf8') ?? '', newBlob?.data.toString('utf8') ?? '');
      out.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
    }
  }
  return out;
}

/** Whether merging `head` into `base` conflicts (three-way, against the merge base). */
export function mergeConflicts(store: Store, repo: Repo, pull: Pull): boolean {
  const lookup = store.lookup(repo);
  const baseTip = store.resolveRef(repo, pull.baseRef);
  if (baseTip === null) return false;
  const mergeBaseSha = pull.mergeBaseSha;
  const baseTree = mergeBaseSha === null ? null : parseCommit(repo.objects.get(mergeBaseSha)!.data).tree;
  const baseNowTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
  const ancestor = flattenTree(lookup, baseTree);
  const now = flattenTree(lookup, baseNowTree);
  const head = flattenTree(lookup, headTree);
  const paths = new Set([...ancestor.keys(), ...now.keys(), ...head.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const n = now.get(path);
    const h = head.get(path);
    const baseChanged = a !== n;
    const headChanged = a !== h;
    if (baseChanged && headChanged && n !== h) return true;
  }
  return false;
}

/** 'MERGEABLE' when the squash merge would apply cleanly, 'CONFLICTING' otherwise. */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.state !== 'open' || pull.merged) return 'MERGEABLE';
  return mergeConflicts(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

export type SquashMergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'already-merged' | 'closed' | 'conflict' | 'no-base' | 'no-head' };

/**
 * Squash-merge an open pull request onto its base branch: the merge commit's
 * tree is the head tree and its parent is the base tip. Shared by the REST
 * merge endpoint and the GraphQL mergePullRequest mutation.
 */
export function squashMergePull(store: Store, repo: Repo, pull: Pull): SquashMergeResult {
  if (pull.merged) return { ok: false, reason: 'already-merged' };
  if (pull.state !== 'open') return { ok: false, reason: 'closed' };
  if (mergeConflicts(store, repo, pull)) return { ok: false, reason: 'conflict' };
  const baseTip = store.resolveRef(repo, pull.baseRef);
  if (baseTip === null) return { ok: false, reason: 'no-base' };
  const headObject = repo.objects.get(pull.headSha);
  if (headObject === undefined || headObject.type !== 'commit') return { ok: false, reason: 'no-head' };
  const headTree = parseCommit(headObject.data).tree;
  const identity = store.commitIdentity();
  const message = `${pull.title} (#${pull.number})`;
  const mergeSha = store.storeObject(repo, {
    type: 'commit',
    data: buildCommit({ tree: headTree, parents: [baseTip], author: identity, committer: identity, message }),
  });
  store.setRef(repo, `refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  pull.updatedAt = new Date().toISOString();
  return { ok: true, sha: mergeSha };
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/**
 * Handle a REST v3 request. Returns true when the path is under /api/v3 (handled);
 * false otherwise. Auth is enforced by the caller (app.ts) before this runs.
 */
export function handleRest(ctx: Ctx, store: Store, reply: Reply): boolean {
  if (!ctx.path.startsWith('/api/v3')) return false;
  const parts = segments(ctx.path);
  // parts[0] === 'api', parts[1] === 'v3'
  const rest = parts.slice(2);
  const method = ctx.method;

  // A malformed JSON body is a 400 on every route that takes one.
  if (ctx.jsonError && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    reply.json(400, { message: 'Malformed JSON in request body' });
    return true;
  }

  // API root.
  if (rest.length === 0) {
    if (method === 'GET') {
      reply.json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    } else {
      reply.json(404, { message: 'Not Found' });
    }
    return true;
  }

  // meta.
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method === 'GET') reply.json(200, { installed_version: INSTALLED_VERSION });
    else reply.json(404, { message: 'Not Found' });
    return true;
  }

  // rate_limit.
  if (rest.length === 1 && rest[0] === 'rate_limit') {
    if (method === 'GET') {
      const reset = Math.floor(Date.now() / 1000) + 3600;
      reply.json(200, { resources: { core: { limit: 5000, remaining: 4999, reset }, search: { limit: 30, remaining: 30, reset } }, rate: { limit: 5000, remaining: 4999, reset } });
    } else reply.json(404, { message: 'Not Found' });
    return true;
  }

  // The token's own user.
  if (rest.length === 1 && rest[0] === 'user') {
    if (method === 'GET') {
      reply.json(200, { ...userJson(VIEWER.login, VIEWER.id), name: VIEWER.name, email: VIEWER.email, html_url: `${originOf(ctx)}/${VIEWER.login}` });
    } else reply.json(404, { message: 'Not Found' });
    return true;
  }

  // /user/repos: list + create.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const page = paginate(ctx, reply, store.listRepos(VIEWER.login), '/api/v3/user/repos');
      reply.json(200, page.map((repo) => repoJson(ctx, repo)), linkHeader());
      return true;
    }
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const name = str(body.name);
      if (name === '' || name.includes('/')) {
        reply.json(422, { message: 'Repository name is required' });
        return true;
      }
      const created = store.createRepo(VIEWER.login, name, { private: bool(body.private, false), description: str(body.description) });
      if (created === null) {
        reply.json(422, { message: 'Repository already exists' });
        return true;
      }
      reply.json(201, repoJson(ctx, created));
      return true;
    }
    reply.json(404, { message: 'Not Found' });
    return true;
  }

  // /repos/{owner}/{name}[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = findRepo(store, owner, name);
    const tail = rest.slice(3);

    // The repository itself.
    if (tail.length === 0) {
      if (repo === null) {
        reply.json(404, { message: 'Not Found' });
        return true;
      }
      if (method === 'GET') {
        reply.json(200, repoJson(ctx, repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = bodyOf(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && store.resolveRef(repo, body.default_branch) !== null) {
          repo.defaultBranch = body.default_branch;
        }
        reply.json(200, repoJson(ctx, repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        reply.empty(204);
        return true;
      }
      reply.json(404, { message: 'Not Found' });
      return true;
    }

    if (repo === null) {
      reply.json(404, { message: 'Not Found' });
      return true;
    }

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches: Array<Record<string, unknown>> = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
        }
        reply.json(200, branches);
        return true;
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).join('/');
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (oid === undefined) {
          reply.json(404, { message: 'Branch not found' });
          return true;
        }
        reply.json(200, { name: branch, commit: { sha: oid }, protected: false });
        return true;
      }
      reply.json(404, { message: 'Not Found' });
      return true;
    }

    // commits
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const tip = resolveTip(store, repo, ctx.query.get('sha'));
        if (tip === null) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        const entries = store.history(repo, tip).map((entry) => historyEntryJson(repo, entry));
        reply.json(200, entries);
        return true;
      }
      reply.json(404, { message: 'Not Found' });
      return true;
    }

    // git data: refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const body = bodyOf(ctx);
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !isObjectId(sha)) {
          reply.json(422, { message: 'Invalid ref or sha' });
          return true;
        }
        const target = repo.objects.get(sha);
        if (target === undefined) {
          reply.json(422, { message: 'Object does not exist' });
          return true;
        }
        if (repo.refs.has(ref)) {
          reply.json(422, { message: 'Reference already exists' });
          return true;
        }
        store.setRef(repo, ref, sha);
        reply.json(201, { ref, object: { sha, type: target.type }, url: `${originOf(ctx)}/api/v3/repos/${owner}/${name}/git/refs/${ref}` });
        return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = tail.slice(2).join('/');
        const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const oid = repo.refs.get(full);
        if (oid === undefined) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        const target = repo.objects.get(oid);
        reply.json(200, { ref: full, object: { sha: oid, type: target?.type ?? 'commit' } });
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const refs: Array<Record<string, unknown>> = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          const target = repo.objects.get(oid);
          refs.push({ ref, object: { sha: oid, type: target?.type ?? 'commit' } });
        }
        reply.json(200, refs);
        return true;
      }
      reply.json(404, { message: 'Not Found' });
      return true;
    }

    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') {
        const body = bodyOf(ctx);
        const content = str(body.content);
        const message = str(body.message, `Update ${filePath}`);
        const branch = str(body.branch, repo.defaultBranch);
        if (content === '') {
          reply.json(400, { message: 'content is required' });
          return true;
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          reply.json(400, { message: 'content is not valid base64' });
          return true;
        }
        const tip = store.resolveRef(repo, branch);
        const currentTree = tip === null ? null : parseCommit(repo.objects.get(tip)!.data).tree;
        const currentOid = currentTree === null ? null : treeLookup(store.lookup(repo), currentTree, filePath.split('/').filter((p) => p !== ''));
        const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
        if (givenSha !== undefined) {
          if (currentOid === null || givenSha.toLowerCase() !== currentOid.toLowerCase()) {
            reply.json(409, { message: 'sha does not match the current file' });
            return true;
          }
        } else if (currentOid !== null) {
          reply.json(422, { message: "sha wasn't supplied" });
          return true;
        }
        const isUpdate = currentOid !== null;
        const { commitSha, blobSha } = store.commitFile(repo, { branch, path: filePath, content: bytes, message });
        reply.json(isUpdate ? 200 : 201, {
          content: fileEntryJson(ctx, repo, filePath, { type: 'blob', data: bytes }, blobSha),
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'GET') {
        const tip = resolveTip(store, repo, ctx.query.get('ref'));
        if (tip === null) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        const tree = parseCommit(repo.objects.get(tip)!.data).tree;
        const lookup = store.lookup(repo);
        if (filePath === '') {
          const entries = parseTree(repo.objects.get(tree)!.data).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: entry.name,
            sha: entry.oid,
          }));
          reply.json(200, entries);
          return true;
        }
        const oid = treeLookup(lookup, tree, filePath.split('/').filter((p) => p !== ''));
        if (oid === null) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        const object = repo.objects.get(oid)!;
        if (object.type === 'tree') {
          const entries = parseTree(object.data).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: `${filePath}/${entry.name}`,
            sha: entry.oid,
            ...(entry.mode === '40000' ? {} : { size: repo.objects.get(entry.oid)?.data.length ?? 0 }),
          }));
          reply.json(200, entries);
          return true;
        }
        reply.json(200, fileEntryJson(ctx, repo, filePath, object, oid));
        return true;
      }
      if (method === 'DELETE') {
        const body = bodyOf(ctx);
        const message = str(body.message, `Delete ${filePath}`);
        const branch = str(body.branch, repo.defaultBranch);
        const tip = store.resolveRef(repo, branch);
        if (tip === null) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        const tree = parseCommit(repo.objects.get(tip)!.data).tree;
        const currentOid = treeLookup(store.lookup(repo), tree, filePath.split('/').filter((p) => p !== ''));
        if (currentOid === null) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
        if (givenSha !== undefined && givenSha.toLowerCase() !== currentOid.toLowerCase()) {
          reply.json(409, { message: 'sha does not match the current file' });
          return true;
        }
        const deleted = store.deleteFile(repo, { branch, path: filePath, message });
        if (deleted === null) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        reply.json(200, { commit: { sha: deleted.commitSha, message }, content: null });
        return true;
      }
      reply.json(404, { message: 'Not Found' });
      return true;
    }

    // labels
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        reply.json(200, repo.labels.map(labelJson));
        return true;
      }
      if (tail.length === 1 && method === 'POST') {
        const body = bodyOf(ctx);
        const name = str(body.name);
        if (name === '') {
          reply.json(422, { message: 'Label name is required' });
          return true;
        }
        const label = store.createLabel(repo, name, str(body.color, 'ededed'));
        reply.json(201, labelJson(label));
        return true;
      }
      reply.json(404, { message: 'Not Found' });
      return true;
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'POST') {
        const body = bodyOf(ctx);
        const title = str(body.title);
        if (title === '') {
          reply.json(422, { message: 'Title is required' });
          return true;
        }
        const wanted = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const labels: Label[] = [];
        for (const name of wanted) {
          const label = repo.labels.find((entry) => entry.name === name);
          if (label === undefined) {
            reply.json(422, { message: `Label '${name}' does not exist` });
            return true;
          }
          labels.push(label);
        }
        const issue = store.createIssue(repo, { title, body: str(body.body), labels });
        reply.json(201, issueJson(ctx, repo, issue));
        return true;
      }
      if (tail.length === 1 && method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        const dir = direction === 'asc' ? 1 : -1;
        if (sort === 'created' || sort === 'updated') list.sort((a, b) => (a.createdSeq - b.createdSeq) * dir);
        const page = paginate(ctx, reply, list, `/api/v3/repos/${owner}/${name}/issues`);
        reply.json(200, page.map((issue) => issueJson(ctx, repo, issue)), linkHeader());
        return true;
      }
      if (tail.length >= 2) {
        const number = parseInt(tail[1]!, 10);
        const issue = Number.isFinite(number) ? findIssue(repo, number) : undefined;
        if (issue === undefined) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        if (tail.length === 2 && method === 'GET') {
          reply.json(200, issueJson(ctx, repo, issue));
          return true;
        }
        if (tail.length === 2 && method === 'PATCH') {
          const body = bodyOf(ctx);
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          issue.updatedAt = new Date().toISOString();
          reply.json(200, issueJson(ctx, repo, issue));
          return true;
        }
        if (tail[2] === 'comments' && tail.length === 3 && method === 'POST') {
          const body = bodyOf(ctx);
          const text = str(body.body);
          if (text === '') {
            reply.json(422, { message: 'Comment body is required' });
            return true;
          }
          const comment: Comment = { id: store.nextGlobalObjectId(), body: text, createdAt: new Date().toISOString(), createdSeq: store.nextSequence() };
          issue.comments.push(comment);
          reply.json(201, commentJson(repo, issue, comment));
          return true;
        }
        if (tail[2] === 'comments' && tail.length === 3 && method === 'GET') {
          reply.json(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
          return true;
        }
      }
      reply.json(404, { message: 'Not Found' });
      return true;
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'POST') {
        const body = bodyOf(ctx);
        const title = str(body.title);
        const head = str(body.head);
        const base = str(body.base, repo.defaultBranch);
        if (title === '' || head === '') {
          reply.json(422, { message: 'Title and head are required' });
          return true;
        }
        const headSha = store.resolveRef(repo, head);
        const baseSha = store.resolveRef(repo, base);
        if (headSha === null || baseSha === null) {
          reply.json(422, { message: 'Head or base branch does not exist' });
          return true;
        }
        const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
        if (existing !== undefined) {
          reply.json(422, { message: 'A pull request already exists for this head and base' });
          return true;
        }
        const mergeBaseSha = mergeBase(store.lookup(repo), headSha, baseSha);
        const pull = store.createPull(repo, { title, body: str(body.body), headRef: head, baseRef: base, headSha, baseSha, mergeBaseSha });
        reply.json(201, pullJson(ctx, repo, pull));
        return true;
      }
      if (tail.length === 1 && method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const page = paginate(ctx, reply, list, `/api/v3/repos/${owner}/${name}/pulls`);
        reply.json(200, page.map((pull) => pullJson(ctx, repo, pull)), linkHeader());
        return true;
      }
      if (tail.length >= 2) {
        const number = parseInt(tail[1]!, 10);
        const pull = Number.isFinite(number) ? findPull(repo, number) : undefined;
        if (pull === undefined) {
          reply.json(404, { message: 'Not Found' });
          return true;
        }
        if (tail.length === 2 && method === 'GET') {
          reply.json(200, pullJson(ctx, repo, pull));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          reply.json(200, pullFiles(store, repo, pull));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          const merged = squashMergePull(store, repo, pull);
          if (!merged.ok) {
            const message =
              merged.reason === 'already-merged'
                ? 'Pull request is already merged'
                : merged.reason === 'closed'
                  ? 'Pull request is closed'
                  : merged.reason === 'conflict'
                    ? 'Merge conflict'
                    : merged.reason === 'no-base'
                      ? 'Base branch has no commits'
                      : 'Head commit is missing';
            reply.json(405, { message });
            return true;
          }
          reply.json(200, { sha: merged.sha, merged: true, message: `${pull.title} (#${pull.number})` });
          return true;
        }
      }
      reply.json(404, { message: 'Not Found' });
      return true;
    }
  }

  reply.json(404, { message: 'Not Found' });
  return true;
}
