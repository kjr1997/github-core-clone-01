// store.ts — the forge's in-memory state: repositories, git objects and refs,
// issues, pull requests, labels and comments. No disk, no external service.
// One process, one store; a fresh server starts empty (as every trial expects).

import {
  EMPTY_TREE_OID,
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  updateTree,
  type GitObject,
} from './gitobj.ts';

/** The token owner: the scenario's viewer (wire.ts buildScenario, fixed seed). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string | null;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** oid -> object. Objects live per repository, never shared across repos. */
  objects: Map<string, GitObject>;
  /** ref name (refs/heads/..., refs/tags/...) -> oid. */
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  /** Shared issue + pull-request numbering, starting at 1 (GitHub's sequence). */
  nextNumber: number;
  nextLabelId: number;
  /** Fetch plan cache, keyed by the fetch's parameters; cleared on any mutation. */
  packCache: Map<string, { pack: Buffer; shallowOut: string[]; unshallowOut: string[] }>;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq++,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
      nextLabelId: 1,
      packCache: new Map(),
    };
    // The empty tree exists from the start, so an emptied root tree always resolves.
    repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: buildTree([]) });
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  nextGlobalObjectId(): number {
    return this.nextObjectId++;
  }

  nextSequence(): number {
    return this.nextSeq++;
  }

  // -- objects and refs -------------------------------------------------------

  storeObject(repo: Repo, object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, object);
      repo.packCache.clear();
    }
    return oid;
  }

  storeObjects(repo: Repo, objects: Iterable<GitObject>): void {
    let changed = false;
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        changed = true;
      }
    }
    if (changed) repo.packCache.clear();
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.packCache.clear();
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const deleted = repo.refs.delete(ref);
    if (deleted) repo.packCache.clear();
    return deleted;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Resolve a branch name, a full ref, or a 40-hex commit id to a commit oid (or null). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === '') return null;
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      return object !== undefined && object.type === 'commit' ? ref : null;
    }
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    return oid ?? null;
  }

  /** The tip of the default branch, or null when the repository has no commits yet. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  // -- contents commits -------------------------------------------------------

  /** The identity line contents commits carry (author and committer). */
  commitIdentity(): string {
    const ts = Math.floor(Date.now() / 1000);
    return `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  }

  /**
   * Commit a file write on `branch` (created from the default tip when it does not
   * exist yet). Returns the commit and blob ids. `content` is the file's raw bytes.
   */
  commitFile(
    repo: Repo,
    options: { branch: string; path: string; content: Buffer; message: string },
  ): { commitSha: string; blobSha: string } {
    const branch = options.branch === '' ? repo.defaultBranch : options.branch;
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined) {
      // A new branch starts at the default branch's tip (or at nothing, unborn).
      parent = branch === repo.defaultBranch ? undefined : this.defaultTip(repo) ?? undefined;
    }
    const parentTree = parent !== undefined ? parseCommit(repo.objects.get(parent)!.data).tree : null;
    const blobSha = this.storeObject(repo, { type: 'blob', data: options.content });
    const segments = options.path.split('/').filter((part) => part !== '');
    const edited = updateTree(this.lookup(repo), parentTree, segments, blobSha);
    this.storeObjects(repo, edited.created);
    const identity = this.commitIdentity();
    const commit = buildCommit({
      tree: edited.rootOid,
      parents: parent !== undefined ? [parent] : [],
      author: identity,
      committer: identity,
      message: options.message,
    });
    const commitSha = this.storeObject(repo, { type: 'commit', data: commit });
    this.setRef(repo, ref, commitSha);
    return { commitSha, blobSha };
  }

  /**
   * Commit a file deletion on `branch`. Returns the commit id, or null when the
   * path does not exist at the branch tip.
   */
  deleteFile(
    repo: Repo,
    options: { branch: string; path: string; message: string },
  ): { commitSha: string } | null {
    const branch = options.branch === '' ? repo.defaultBranch : options.branch;
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    if (parent === undefined) return null;
    const parentObject = repo.objects.get(parent);
    if (parentObject === undefined) return null;
    const parentTree = parseCommit(parentObject.data).tree;
    const segments = options.path.split('/').filter((part) => part !== '');
    const edited = updateTree(this.lookup(repo), parentTree, segments, null);
    // Nothing to delete when the tree did not change.
    if (edited.rootOid === parentTree) return null;
    this.storeObjects(repo, edited.created);
    const identity = this.commitIdentity();
    const commit = buildCommit({
      tree: edited.rootOid,
      parents: [parent],
      author: identity,
      committer: identity,
      message: options.message,
    });
    const commitSha = this.storeObject(repo, { type: 'commit', data: commit });
    this.setRef(repo, ref, commitSha);
    return { commitSha };
  }

  /** The commit history from a tip, newest first. */
  history(repo: Repo, tip: string | null): Array<{ sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }> = [];
    const seen = new Set<string>();
    const queue: string[] = tip === null ? [] : [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, tree: commit.tree, parents: commit.parents });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // -- issues, pulls, labels ---------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.find((label) => label.name === name);
    if (existing !== undefined) return existing;
    const label: Label = { id: repo.nextLabelId++, name, color, description: '' };
    repo.labels.push(label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body: string; labels: Label[] }): Issue {
    const now = new Date().toISOString();
    const issue: Issue = {
      id: this.nextGlobalObjectId(),
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: input.labels,
      createdAt: now,
      updatedAt: now,
      createdSeq: this.nextSequence(),
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(
    repo: Repo,
    input: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string; mergeBaseSha: string | null },
  ): Pull {
    const now = new Date().toISOString();
    const pull: Pull = {
      id: this.nextGlobalObjectId(),
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      headSha: input.headSha,
      baseSha: input.baseSha,
      mergeBaseSha: input.mergeBaseSha,
      createdAt: now,
      updatedAt: now,
      createdSeq: this.nextSequence(),
    };
    repo.pulls.push(pull);
    return pull;
  }
}

// ---------------------------------------------------------------------------------------------
// Relay global ids (GraphQL): opaque, stable, type-prefixed base64.
// ---------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const kind = text.slice(0, colon);
    const rest = text.slice(colon + 1);
    if (rest === '') return null;
    // The encoding must round-trip: reject strings that are not our base64.
    if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
    return { kind, parts: rest.split(':') };
  } catch {
    return null;
  }
}
