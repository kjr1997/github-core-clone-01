// mcp.ts — Model Context Protocol over streamable HTTP at POST /mcp, plain JSON
// answers (no SSE). Two protocol eras are served, matching the kit's client:
//   - modern 2026-07-28: `server/discover` returns the server's identity,
//     capabilities and supported versions; every request carries `_meta` and the
//     `MCP-Protocol-Version` header (the server ignores both, it never refuses
//     on them);
//   - legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// Notifications (no id) are answered HTTP 202 with an empty body. A body that
// is not JSON is HTTP 400 with JSON-RPC -32700. An unknown tool is -32602 (never
// HTTP 500). Missing required arguments are isError:true. Auth is enforced by
// the caller (app.ts): a tools/call without Authorization is HTTP 401.
//
// The six tools are the same objects the REST and GraphQL surfaces serve, so
// MCP-created repositories and issues are the same objects over REST, with
// stable ids (the rest-parity check).

import { mergeBase } from './gitobj.ts';
import type { Ctx, Reply } from './http.ts';
import { VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { squashMergePull } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------------------------

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const KNOWN_REVISIONS = new Set(SUPPORTED_VERSIONS);

function serverInfo(): Record<string, string> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

// ---------------------------------------------------------------------------------------------
// Tool catalogue — one constant, so tools/list is byte-for-byte idempotent.
// ---------------------------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Serializers (the REST shapes, without an origin — MCP has none)
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The first present argument under any of the given names. */
function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return undefined;
}

function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

interface ToolOutcome {
  /** When set, the call failed with this tool-level error (isError:true). */
  error?: string;
  /** The result object, carried as both text JSON and structuredContent. */
  value: Record<string, unknown>;
}

function toolResult(outcome: ToolOutcome): Record<string, unknown> {
  if (outcome.error !== undefined) {
    return { content: [{ type: 'text', text: outcome.error }], isError: true };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.value, null, 2) }],
    structuredContent: outcome.value,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(pick(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name'));
      if (repoName === undefined) return { error: 'Missing required argument: name', value: {} };
      const description = asString(pick(args, 'description', 'about', 'summary', 'body')) ?? '';
      const isPrivate = pick(args, 'private', 'is_private') === true;
      const repo = store.createRepo(VIEWER.login, repoName, { private: isPrivate, description });
      if (repo === null) return { error: `Repository ${VIEWER.login}/${repoName} already exists`, value: {} };
      return { value: repoJson(repo) };
    }
    case 'get_repo': {
      const owner = asString(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace'));
      const repoName = asString(pick(args, 'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name', 'name'));
      if (owner === undefined || repoName === undefined) return { error: 'Missing required argument: owner and repo', value: {} };
      const repo = findRepo(store, owner, repoName);
      if (repo === null) return { error: `Repository ${owner}/${repoName} not found`, value: {} };
      return { value: repoJson(repo) };
    }
    case 'create_issue': {
      const owner = asString(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace'));
      const repoName = asString(pick(args, 'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'));
      const title = asString(pick(args, 'title', 'issue_title', 'subject'));
      if (owner === undefined || repoName === undefined || title === undefined) {
        return { error: 'Missing required argument: owner, repo and title', value: {} };
      }
      const repo = findRepo(store, owner, repoName);
      if (repo === null) return { error: `Repository ${owner}/${repoName} not found`, value: {} };
      const body = asString(pick(args, 'body', 'issue_body', 'description', 'content', 'text', 'comment')) ?? '';
      const issue = store.createIssue(repo, { title, body, labels: [] });
      return { value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const owner = asString(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace'));
      const repoName = asString(pick(args, 'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'));
      if (owner === undefined || repoName === undefined) return { error: 'Missing required argument: owner and repo', value: {} };
      const repo = findRepo(store, owner, repoName);
      if (repo === null) return { error: `Repository ${owner}/${repoName} not found`, value: {} };
      const state = asString(pick(args, 'state', 'status')) ?? 'open';
      const list = state === 'all' ? [...repo.issues] : repo.issues.filter((issue) => issue.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return { value: { issues: list.map((issue) => issueJson(repo, issue)) } };
    }
    case 'create_pull_request': {
      const owner = asString(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace'));
      const repoName = asString(pick(args, 'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'));
      const title = asString(pick(args, 'title', 'pr_title', 'pull_request_title', 'subject'));
      const head = asString(pick(args, 'head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'));
      const base = asString(pick(args, 'base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'));
      if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
        return { error: 'Missing required argument: owner, repo, title, head and base', value: {} };
      }
      const repo = findRepo(store, owner, repoName);
      if (repo === null) return { error: `Repository ${owner}/${repoName} not found`, value: {} };
      const body = asString(pick(args, 'body', 'description', 'content', 'text')) ?? '';
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (headSha === null || baseSha === null) return { error: 'The head or base branch does not exist', value: {} };
      const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
      if (existing !== undefined) return { error: 'A pull request already exists for this head and base', value: {} };
      const mergeBaseSha = mergeBase(store.lookup(repo), headSha, baseSha);
      const pull = store.createPull(repo, { title, body, headRef: head, baseRef: base, headSha, baseSha, mergeBaseSha });
      return { value: pullJson(repo, pull) };
    }
    case 'merge_pull_request': {
      const owner = asString(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace'));
      const repoName = asString(pick(args, 'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'));
      const number = asNumber(pick(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'));
      if (owner === undefined || repoName === undefined || number === undefined) {
        return { error: 'Missing required argument: owner, repo and pull_number', value: {} };
      }
      const repo = findRepo(store, owner, repoName);
      if (repo === null) return { error: `Repository ${owner}/${repoName} not found`, value: {} };
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { error: `Pull request #${number} not found`, value: {} };
      const result = squashMergePull(store, repo, pull);
      if (!result.ok) {
        const reason =
          result.reason === 'already-merged'
            ? 'Pull request is already merged'
            : result.reason === 'closed'
              ? 'Pull request is closed'
              : result.reason === 'conflict'
                ? 'Merge conflict'
                : result.reason === 'no-base'
                  ? 'Base branch has no commits'
                  : 'Head commit is missing';
        return { error: reason, value: {} };
      }
      return { value: { ...pullJson(repo, pull), sha: result.sha, merged: true } };
    }
    default:
      return { error: `Unknown tool: ${name}`, value: {} };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** The tools/list answer, built from the one constant so it never varies. */
function toolsListResult(): Record<string, unknown> {
  return { tools: TOOLS };
}

/**
 * Handle one JSON-RPC request object. Returns null for a notification (the
 * caller answers HTTP 202 with an empty body); otherwise the response object.
 */
function handleRpc(store: Store, body: Record<string, unknown>): Record<string, unknown> | null {
  const hasId = 'id' in body && body.id !== undefined;
  const id: JsonRpcId = hasId ? (body.id as JsonRpcId) : null;
  const method = body.method;
  if (typeof method !== 'string' || method === '') {
    if (!hasId) return null;
    return rpcError(id, -32600, 'Invalid Request: a method string is required');
  }
  // Notifications (no id) never carry a response — 202 empty.
  if (!hasId) return null;
  const params = isRecord(body.params) ? body.params : {};

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      });
    }
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && KNOWN_REVISIONS.has(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, toolsListResult());
    }
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const known = TOOLS.some((tool) => tool.name === name);
      if (!known) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      const outcome = callTool(store, name, args);
      return rpcResult(id, toolResult(outcome));
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

/**
 * Handle /mcp. Returns true when the path is the MCP endpoint (handled);
 * false otherwise. Auth is enforced by the caller (app.ts).
 */
export function handleMcp(ctx: Ctx, store: Store, reply: Reply): boolean {
  if (ctx.path !== '/mcp') return false;
  // A legacy session's goodbye: nothing is held server-side.
  if (ctx.method === 'DELETE') {
    reply.empty(204);
    return true;
  }
  if (ctx.method !== 'POST') {
    reply.json(404, { message: 'Not Found' });
    return true;
  }
  if (ctx.jsonError) {
    reply.json(400, rpcError(null, -32700, 'Parse error: the request body is not valid JSON'));
    return true;
  }
  const body = ctx.json;
  if (!isRecord(body)) {
    reply.json(400, rpcError(null, -32600, 'Invalid Request: the body must be a JSON-RPC object'));
    return true;
  }
  const answer = handleRpc(store, body);
  if (answer === null) {
    // A notification: HTTP 202 with an empty body.
    reply.empty(202);
    return true;
  }
  reply.json(200, answer);
  return true;
}
