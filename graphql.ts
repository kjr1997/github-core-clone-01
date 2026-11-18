// graphql.ts — GitHub GraphQL v4: a hand-written parser and executor over the same
// Store the REST and git surfaces use. No dependencies, no schema library: the
// documents the suite sends are the contract (see the kit's checks-graphql.ts),
// plus the introspection probes gh's feature detection sends.
//
// Wire rules (from graphql-client.ts):
//   - POST /api/graphql with {query, variables} or a JSON array of operations;
//     a batch is answered by an array of the usual per-operation bodies, in order.
//   - a GraphQL-level failure (an unknown field, a bad argument) is an HTTP 200
//     whose body carries `errors`; it is not an HTTP error.
//   - an unauthenticated request is a 401 (the app's auth gate enforces it).
//   - a body with neither `data` nor `errors` is a parse error to the client,
//     so every answer carries at least one of the two keys.
//   - unknown repositories read data.repository = null with no errors.
//   - global ids are opaque (type-prefixed base64) and stable across reads.

import { mergeBase } from './gitobj.ts';
import type { Ctx, Reply } from './http.ts';
import {
  VIEWER,
  decodeGlobalId,
  encodeGlobalId,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { pullFiles, pullMergeable, squashMergePull } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

class LexError extends Error {}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k += 1) {
      if (source[i] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      i += 1;
    }
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...', line: startLine, column: startColumn });
      advance(3);
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, line: startLine, column: startColumn });
      advance();
      continue;
    }
    if (ch === '"') {
      // A plain string ("...") — escapes \" \\ \/ \b \f \n \r \t \uXXXX.
      let value = '';
      advance();
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '"') {
          advance();
          closed = true;
          break;
        }
        if (c === '\\') {
          const esc = source[i + 1];
          if (esc === undefined) break;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new LexError(`invalid \\u escape at line ${line}`);
            value += String.fromCharCode(parseInt(hex, 16));
            advance(6);
          } else if (simple[esc] !== undefined) {
            value += simple[esc]!;
            advance(2);
          } else {
            throw new LexError(`invalid escape \\${esc} at line ${line}`);
          }
          continue;
        }
        if (c === '\n') throw new LexError(`unterminated string at line ${line}`);
        value += c;
        advance();
      }
      if (!closed) throw new LexError(`unterminated string at line ${startLine}`);
      tokens.push({ kind: 'string', value, line: startLine, column: startColumn });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let value = '';
      if (ch === '-') {
        value += '-';
        advance();
      }
      while (i < source.length && /[0-9]/.test(source[i]!)) {
        value += source[i];
        advance();
      }
      let isFloat = false;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        isFloat = true;
        value += '.';
        advance();
        while (i < source.length && /[0-9]/.test(source[i]!)) {
          value += source[i];
          advance();
        }
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        value += source[i];
        advance();
        if (source[i] === '+' || source[i] === '-') {
          value += source[i];
          advance();
        }
        while (i < source.length && /[0-9]/.test(source[i]!)) {
          value += source[i];
          advance();
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value, line: startLine, column: startColumn });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let value = '';
      while (i < source.length && /[_A-Za-z0-9]/.test(source[i]!)) {
        value += source[i];
        advance();
      }
      tokens.push({ kind: 'name', value, line: startLine, column: startColumn });
      continue;
    }
    throw new LexError(`unexpected character ${JSON.stringify(ch)} at line ${line}, column ${column}`);
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser — a recursive-descent parser for the GraphQL document grammar.
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface TypeNode {
  kind: 'named' | 'list' | 'nonNull';
  name?: string;
  ofType?: TypeNode;
}

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  arguments: ArgumentNode[];
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  arguments: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
  line: number;
  column: number;
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
  directives: DirectiveNode[];
  line: number;
  column: number;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
  line: number;
  column: number;
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDefinitionNode {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | null;
}

interface OperationDefinitionNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VariableDefinitionNode[];
  selectionSet: SelectionNode[];
}

interface FragmentDefinitionNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type DefinitionNode = OperationDefinitionNode | FragmentDefinitionNode;

class ParseError extends Error {}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): Token {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ParseError(`expected "${value}" at line ${token.line}, column ${token.column}, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private expectName(what = 'a name'): Token {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new ParseError(`expected ${what} at line ${token.line}, column ${token.column}, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName('a fragment name').value;
      const on = this.expectName('the "on" keyword');
      if (on.value !== 'on') throw new ParseError(`expected "on" at line ${on.line}, got ${JSON.stringify(on.value)}`);
      const typeCondition = this.expectName('a type condition').value;
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = token.value as 'query' | 'mutation' | 'subscription';
      this.next();
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
    }
    throw new ParseError(`unexpected ${token.kind} ${JSON.stringify(token.value)} at line ${token.line}, column ${token.column}`);
  }

  private parseVariableDefinitions(): VariableDefinitionNode[] {
    const definitions: VariableDefinitionNode[] = [];
    if (!this.matchPunct('(')) return definitions;
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name').value;
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue(true);
      definitions.push({ name, type, defaultValue });
    }
    return definitions;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.matchPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expectName('a type name').value };
    }
    if (this.matchPunct('!')) type = { kind: 'nonNull', ofType: type };
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      const spread = this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition').value;
        const directives = this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet(), line: spread.line, column: spread.column };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'fragmentSpread', name, directives, line: spread.line, column: spread.column };
      }
      const directives = this.parseDirectives();
      return { kind: 'inlineFragment', typeCondition: null, directives, selectionSet: this.parseSelectionSet(), line: spread.line, column: spread.column };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName('a field name').value;
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, arguments: args, directives, selectionSet, line: first.line, column: first.column };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.matchPunct('(')) return args;
    while (!this.matchPunct(')')) {
      const name = this.expectName('an argument name').value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName('a directive name').value;
      directives.push({ name, arguments: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new ParseError(`a variable is not allowed in a constant value at line ${token.line}`);
      return { kind: 'variable', name: this.expectName('a variable name').value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new ParseError('unterminated list value');
        values.push(this.parseValue(isConst));
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new ParseError('unterminated object value');
        const name = this.expectName('an object field name').value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError(`unexpected value ${token.kind} ${JSON.stringify(token.value)} at line ${token.line}, column ${token.column}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Values the executor hands around. Every object carries a __typename plus private
// fields (prefixed _) that its field resolvers read.
// ---------------------------------------------------------------------------------------------

type GqlValue = Record<string, unknown> | null;

interface GraphQLErrorEntry {
  message: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
}

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinitionNode>;
  errors: GraphQLErrorEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
      return parseInt(node.value, 10);
    case 'float':
      return parseFloat(node.value);
    case 'string':
    case 'enum':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

/** @skip(if:) / @include(if:) — every other directive is ignored. */
function skipSelection(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const args = argsOf({ kind: 'field', alias: null, name: directive.name, arguments: directive.arguments, directives: [], selectionSet: null, line: 0, column: 0 }, variables);
    if (directive.name === 'skip' && args.if === true) return true;
    if (directive.name === 'include' && args.if === false) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Cursors: base64("cursor:<index>") over the ordered list a connection pages.
// ---------------------------------------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return -1;
    return parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function paginate<T>(items: readonly T[], args: Record<string, unknown>): { slice: T[]; pageInfo: PageInfo; totalCount: number } {
  const after = decodeCursor(args.after);
  const start = after + 1;
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    slice,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length === 0 ? null : encodeCursor(start),
      endCursor: slice.length === 0 ? null : encodeCursor(endIndex),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Object wrappers
// ---------------------------------------------------------------------------------------------

function userValue(login: string, id: number): GqlValue {
  return { __typename: 'User', _login: login, _id: id };
}

function viewerValue(): GqlValue {
  return { __typename: 'Viewer', _login: VIEWER.login, _id: VIEWER.id, _name: VIEWER.name, _email: VIEWER.email };
}

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', _repo: repo };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentValue(repo: Repo, issue: Issue, comment: Comment): GqlValue {
  return { __typename: 'IssueComment', _repo: repo, _issue: issue, _comment: comment };
}

function refValue(name: string): GqlValue {
  return { __typename: 'Ref', _name: name };
}

function connectionValue(typename: string, nodes: unknown[], page: { pageInfo: PageInfo; totalCount: number }): GqlValue {
  return { __typename: typename, _nodes: nodes, _pageInfo: page.pageInfo, _totalCount: page.totalCount };
}

function typeValue(name: string, fields: string[], enumValues: string[]): GqlValue {
  return { __typename: '__Type', _name: name, _fields: fields, _enumValues: enumValues };
}

function fieldValue(name: string): GqlValue {
  return { __typename: '__Field', _name: name };
}

function enumValue(name: string): GqlValue {
  return { __typename: '__EnumValue', _name: name };
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'issue' || decoded.parts.length !== 2) return null;
  const repo = findRepoById(store, parseInt(decoded.parts[0]!, 10));
  if (repo === null) return null;
  const issue = repo.issues.find((entry) => entry.number === parseInt(decoded.parts[1]!, 10));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'pr' || decoded.parts.length !== 2) return null;
  const repo = findRepoById(store, parseInt(decoded.parts[0]!, 10));
  if (repo === null) return null;
  const pull = repo.pulls.find((entry) => entry.number === parseInt(decoded.parts[1]!, 10));
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------------------------------------
// Introspection data: the field and enum names gh's feature detection probes for.
// ---------------------------------------------------------------------------------------------

const ISSUE_FIELDS = [
  'id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt',
  'author', 'labels', 'comments', 'url',
];

const PULL_REQUEST_FIELDS = [
  'id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName',
  'headRef', 'baseRef', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files',
  'author', 'createdAt', 'updatedAt', 'url',
];

const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  'description', 'private', 'createdAt', 'updatedAt', 'url',
];

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'PACKAGE', 'MILESTONE', 'WIKI'];

// ---------------------------------------------------------------------------------------------
// Field resolvers. Each table maps a type name to its fields; a missing entry is an
// unknown field and becomes a GraphQL error (never an HTTP error).
// ---------------------------------------------------------------------------------------------

type Resolver = (parent: GqlValue, args: Record<string, unknown>, exec: Executor) => unknown;

function repoOf(parent: GqlValue): Repo {
  return (parent as Record<string, unknown>)._repo as Repo;
}

function issueOf(parent: GqlValue): Issue {
  return (parent as Record<string, unknown>)._issue as Issue;
}

function pullOf(parent: GqlValue): Pull {
  return (parent as Record<string, unknown>)._pull as Pull;
}

function commentOf(parent: GqlValue): Comment {
  return (parent as Record<string, unknown>)._comment as Comment;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return 'CLOSED';
}

function issuesConnection(exec: Executor, repo: Repo, args: Record<string, unknown>): GqlValue {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  const field = orderBy.field;
  if (field === 'CREATED_AT' || field === undefined) {
    list.sort((a, b) => (a.createdSeq - b.createdSeq) * direction);
  } else if (field === 'UPDATED_AT') {
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) * direction);
  } else if (field === 'COMMENTS') {
    list.sort((a, b) => (a.comments.length - b.comments.length) * direction);
  }
  const page = paginate(list, args);
  return connectionValue('IssueConnection', page.slice.map((issue) => issueValue(repo, issue)), page);
}

function pullsConnection(exec: Executor, repo: Repo, args: Record<string, unknown>): GqlValue {
  void exec;
  const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    const filtered = list.filter((pull) => wanted.has(pullState(pull)));
    const page = paginate(filtered, args);
    return connectionValue('PullRequestConnection', page.slice.map((pull) => pullValue(repo, pull)), page);
  }
  const page = paginate(list, args);
  return connectionValue('PullRequestConnection', page.slice.map((pull) => pullValue(repo, pull)), page);
}

const FIELD_TABLES: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerValue(),
    repository: (parent, args, exec) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (owner !== VIEWER.login) return null;
      const repo = exec.store.getRepo(owner, name);
      return repo === undefined ? null : repoValue(repo);
    },
    node: (parent, args, exec) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'repo' && decoded.parts.length === 1) {
        const repo = findRepoById(exec.store, parseInt(decoded.parts[0]!, 10));
        return repo === null ? null : repoValue(repo);
      }
      if (decoded.kind === 'issue') {
        const found = findIssueByGlobalId(exec.store, id);
        return found === null ? null : issueValue(found.repo, found.issue);
      }
      if (decoded.kind === 'pr') {
        const found = findPullByGlobalId(exec.store, id);
        return found === null ? null : pullValue(found.repo, found.pull);
      }
      if (decoded.kind === 'user') return userValue(VIEWER.login, VIEWER.id);
      return null;
    },
    __type: (parent, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      if (name === 'Issue') return typeValue('Issue', ISSUE_FIELDS, []);
      if (name === 'PullRequest') return typeValue('PullRequest', PULL_REQUEST_FIELDS, []);
      if (name === 'Repository') return typeValue('Repository', REPOSITORY_FIELDS, []);
      if (name === 'SearchType') return typeValue('SearchType', [], SEARCH_TYPE_VALUES);
      return null;
    },
  },
  Mutation: {
    createIssue: (parent, args, exec) => {
      const input = isRecord(args.input) ? args.input : {};
      const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (repoId === null || repoId.kind !== 'repo' || title === '') {
        exec.errors.push({ message: 'createIssue needs a repositoryId and a title' });
        return { __typename: 'CreateIssuePayload', _issue: null, _clientMutationId: input.clientMutationId ?? null };
      }
      const repo = findRepoById(exec.store, parseInt(repoId.parts[0]!, 10));
      if (repo === null) {
        exec.errors.push({ message: 'createIssue: the repository does not exist' });
        return { __typename: 'CreateIssuePayload', _issue: null, _clientMutationId: input.clientMutationId ?? null };
      }
      const issue = exec.store.createIssue(repo, { title, body, labels: [] });
      return { __typename: 'CreateIssuePayload', _issue: issueValue(repo, issue), _clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (parent, args, exec) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(exec.store, input.issueId) : null;
      if (found === null) {
        exec.errors.push({ message: 'closeIssue: the issue does not exist' });
        return { __typename: 'CloseIssuePayload', _issue: null, _clientMutationId: input.clientMutationId ?? null };
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = new Date().toISOString();
      return { __typename: 'CloseIssuePayload', _issue: issueValue(found.repo, found.issue), _clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (parent, args, exec) => {
      const input = isRecord(args.input) ? args.input : {};
      const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const title = typeof input.title === 'string' ? input.title : '';
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (repoId === null || repoId.kind !== 'repo' || title === '' || head === '') {
        exec.errors.push({ message: 'createPullRequest needs a repositoryId, a title and a headRefName' });
        return { __typename: 'CreatePullRequestPayload', _pull: null, _clientMutationId: input.clientMutationId ?? null };
      }
      const repo = findRepoById(exec.store, parseInt(repoId.parts[0]!, 10));
      if (repo === null) {
        exec.errors.push({ message: 'createPullRequest: the repository does not exist' });
        return { __typename: 'CreatePullRequestPayload', _pull: null, _clientMutationId: input.clientMutationId ?? null };
      }
      const headSha = exec.store.resolveRef(repo, head);
      const baseSha = exec.store.resolveRef(repo, base === '' ? repo.defaultBranch : base);
      if (headSha === null || baseSha === null) {
        exec.errors.push({ message: 'createPullRequest: the head or base branch does not exist' });
        return { __typename: 'CreatePullRequestPayload', _pull: null, _clientMutationId: input.clientMutationId ?? null };
      }
      const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === (base === '' ? repo.defaultBranch : base) && pull.state === 'open');
      if (existing !== undefined) {
        exec.errors.push({ message: 'A pull request already exists for this head and base' });
        return { __typename: 'CreatePullRequestPayload', _pull: null, _clientMutationId: input.clientMutationId ?? null };
      }
      const mergeBaseSha = mergeBase(exec.store.lookup(repo), headSha, baseSha);
      const pull = exec.store.createPull(repo, {
        title,
        body,
        headRef: head,
        baseRef: base === '' ? repo.defaultBranch : base,
        headSha,
        baseSha,
        mergeBaseSha,
      });
      return { __typename: 'CreatePullRequestPayload', _pull: pullValue(repo, pull), _clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (parent, args, exec) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(exec.store, input.pullRequestId) : null;
      if (found === null) {
        exec.errors.push({ message: 'mergePullRequest: the pull request does not exist' });
        return { __typename: 'MergePullRequestPayload', _pull: null, _clientMutationId: input.clientMutationId ?? null };
      }
      const result = squashMergePull(exec.store, found.repo, found.pull);
      if (!result.ok && result.reason === 'conflict') {
        exec.errors.push({ message: 'mergePullRequest: the pull request has a merge conflict' });
      }
      return { __typename: 'MergePullRequestPayload', _pull: pullValue(found.repo, found.pull), _clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (parent, args, exec) => {
      const input = isRecord(args.input) ? args.input : {};
      const body = typeof input.body === 'string' ? input.body : '';
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(exec.store, input.subjectId) : null;
      if (found === null || body === '') {
        exec.errors.push({ message: 'addComment needs a subjectId and a body' });
        return { __typename: 'AddCommentPayload', _comment: null, _clientMutationId: input.clientMutationId ?? null };
      }
      const comment: Comment = {
        id: exec.store.nextGlobalObjectId(),
        body,
        createdAt: new Date().toISOString(),
        createdSeq: exec.store.nextSequence(),
      };
      found.issue.comments.push(comment);
      return { __typename: 'AddCommentPayload', _comment: commentValue(found.repo, found.issue, comment), _clientMutationId: input.clientMutationId ?? null };
    },
  },
  Viewer: {
    login: (parent) => (parent as Record<string, unknown>)._login as string,
    id: (parent) => encodeGlobalId('user', (parent as Record<string, unknown>)._login as string),
    name: (parent) => (parent as Record<string, unknown>)._name as string,
    email: (parent) => (parent as Record<string, unknown>)._email as string,
  },
  User: {
    login: (parent) => (parent as Record<string, unknown>)._login as string,
    id: (parent) => encodeGlobalId('user', (parent as Record<string, unknown>)._login as string),
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (parent) => encodeGlobalId('repo', repoOf(parent).id),
    databaseId: (parent) => repoOf(parent).id,
    name: (parent) => repoOf(parent).name,
    nameWithOwner: (parent) => `${repoOf(parent).owner}/${repoOf(parent).name}`,
    owner: (parent) => userValue(repoOf(parent).owner, VIEWER.id),
    defaultBranchRef: (parent, args, exec) => {
      const repo = repoOf(parent);
      const tip = exec.store.defaultTip(repo);
      return tip === null ? null : refValue(repo.defaultBranch);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (parent) => repoOf(parent).description,
    private: (parent) => repoOf(parent).private,
    issue: (parent, args, exec) => {
      const repo = repoOf(parent);
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueValue(repo, issue);
    },
    issues: (parent, args, exec) => issuesConnection(exec, repoOf(parent), args),
    pullRequests: (parent, args, exec) => pullsConnection(exec, repoOf(parent), args),
    pullRequest: (parent, args) => {
      const repo = repoOf(parent);
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : pullValue(repo, pull);
    },
  },
  Issue: {
    id: (parent) => encodeGlobalId('issue', repoOf(parent).id, issueOf(parent).number),
    databaseId: (parent) => issueOf(parent).id,
    number: (parent) => issueOf(parent).number,
    title: (parent) => issueOf(parent).title,
    body: (parent) => issueOf(parent).body,
    state: (parent) => issueState(issueOf(parent)),
    createdAt: (parent) => issueOf(parent).createdAt,
    updatedAt: (parent) => issueOf(parent).updatedAt,
    author: () => userValue(VIEWER.login, VIEWER.id),
    labels: (parent, args) => {
      const nodes = issueOf(parent).labels.map((label) => ({ __typename: 'Label', _name: label.name, _color: label.color, _id: label.id }));
      const page = paginate(nodes, args);
      return connectionValue('LabelConnection', page.slice, page);
    },
    comments: (parent, args) => {
      const repo = repoOf(parent);
      const issue = issueOf(parent);
      const page = paginate(issue.comments, args);
      return connectionValue('IssueCommentConnection', page.slice.map((comment) => commentValue(repo, issue, comment)), page);
    },
    url: (parent) => `/${repoOf(parent).owner}/${repoOf(parent).name}/issues/${issueOf(parent).number}`,
  },
  PullRequest: {
    id: (parent) => encodeGlobalId('pr', repoOf(parent).id, pullOf(parent).number),
    databaseId: (parent) => pullOf(parent).id,
    number: (parent) => pullOf(parent).number,
    title: (parent) => pullOf(parent).title,
    body: (parent) => pullOf(parent).body,
    state: (parent) => pullState(pullOf(parent)),
    headRefName: (parent) => pullOf(parent).headRef,
    baseRefName: (parent) => pullOf(parent).baseRef,
    headRef: (parent) => refValue(pullOf(parent).headRef),
    baseRef: (parent) => refValue(pullOf(parent).baseRef),
    mergeable: (parent, args, exec) => pullMergeable(exec.store, repoOf(parent), pullOf(parent)),
    merged: (parent) => pullOf(parent).merged,
    mergedAt: (parent) => pullOf(parent).mergedAt,
    mergeCommit: (parent) => (pullOf(parent).mergeCommitSha === null ? null : { __typename: 'Commit', _oid: pullOf(parent).mergeCommitSha }),
    files: (parent, args, exec) => {
      const repo = repoOf(parent);
      const pull = pullOf(parent);
      const files = pullFiles(exec.store, repo, pull).map((file) => ({
        __typename: 'PullRequestChangedFile',
        _path: file.filename,
        _additions: file.additions,
        _deletions: file.deletions,
        _changes: file.changes,
      }));
      const page = paginate(files, args);
      return connectionValue('PullRequestChangedFileConnection', page.slice, page);
    },
    author: () => userValue(VIEWER.login, VIEWER.id),
    createdAt: (parent) => pullOf(parent).createdAt,
    updatedAt: (parent) => pullOf(parent).updatedAt,
    url: (parent) => `/${repoOf(parent).owner}/${repoOf(parent).name}/pull/${pullOf(parent).number}`,
  },
  IssueComment: {
    id: (parent) => encodeGlobalId('comment', repoOf(parent).id, issueOf(parent).number, commentOf(parent).id),
    databaseId: (parent) => commentOf(parent).id,
    body: (parent) => commentOf(parent).body,
    createdAt: (parent) => commentOf(parent).createdAt,
    author: () => userValue(VIEWER.login, VIEWER.id),
  },
  Ref: {
    name: (parent) => (parent as Record<string, unknown>)._name as string,
  },
  Label: {
    id: (parent) => encodeGlobalId('label', (parent as Record<string, unknown>)._id as number),
    name: (parent) => (parent as Record<string, unknown>)._name as string,
    color: (parent) => (parent as Record<string, unknown>)._color as string,
    description: () => '',
  },
  Commit: {
    oid: (parent) => (parent as Record<string, unknown>)._oid as string,
  },
  PullRequestChangedFile: {
    path: (parent) => (parent as Record<string, unknown>)._path as string,
    additions: (parent) => (parent as Record<string, unknown>)._additions as number,
    deletions: (parent) => (parent as Record<string, unknown>)._deletions as number,
    changes: (parent) => (parent as Record<string, unknown>)._changes as number,
  },
  IssueConnection: {
    nodes: (parent) => (parent as Record<string, unknown>)._nodes as unknown[],
    edges: (parent) => {
      const nodes = (parent as Record<string, unknown>)._nodes as unknown[];
      return nodes.map((node, index) => ({ __typename: 'IssueEdge', _node: node, _cursor: encodeCursor(index) }));
    },
    pageInfo: (parent) => ({ __typename: 'PageInfo', ...(parent as Record<string, unknown>)._pageInfo as PageInfo }),
    totalCount: (parent) => (parent as Record<string, unknown>)._totalCount as number,
  },
  PullRequestConnection: {
    nodes: (parent) => (parent as Record<string, unknown>)._nodes as unknown[],
    edges: (parent) => {
      const nodes = (parent as Record<string, unknown>)._nodes as unknown[];
      return nodes.map((node, index) => ({ __typename: 'PullRequestEdge', _node: node, _cursor: encodeCursor(index) }));
    },
    pageInfo: (parent) => ({ __typename: 'PageInfo', ...(parent as Record<string, unknown>)._pageInfo as PageInfo }),
    totalCount: (parent) => (parent as Record<string, unknown>)._totalCount as number,
  },
  IssueCommentConnection: {
    nodes: (parent) => (parent as Record<string, unknown>)._nodes as unknown[],
    edges: (parent) => {
      const nodes = (parent as Record<string, unknown>)._nodes as unknown[];
      return nodes.map((node, index) => ({ __typename: 'IssueCommentEdge', _node: node, _cursor: encodeCursor(index) }));
    },
    pageInfo: (parent) => ({ __typename: 'PageInfo', ...(parent as Record<string, unknown>)._pageInfo as PageInfo }),
    totalCount: (parent) => (parent as Record<string, unknown>)._totalCount as number,
  },
  LabelConnection: {
    nodes: (parent) => (parent as Record<string, unknown>)._nodes as unknown[],
    edges: (parent) => {
      const nodes = (parent as Record<string, unknown>)._nodes as unknown[];
      return nodes.map((node, index) => ({ __typename: 'LabelEdge', _node: node, _cursor: encodeCursor(index) }));
    },
    pageInfo: (parent) => ({ __typename: 'PageInfo', ...(parent as Record<string, unknown>)._pageInfo as PageInfo }),
    totalCount: (parent) => (parent as Record<string, unknown>)._totalCount as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => (parent as Record<string, unknown>)._nodes as unknown[],
    edges: (parent) => {
      const nodes = (parent as Record<string, unknown>)._nodes as unknown[];
      return nodes.map((node, index) => ({ __typename: 'PullRequestChangedFileEdge', _node: node, _cursor: encodeCursor(index) }));
    },
    pageInfo: (parent) => ({ __typename: 'PageInfo', ...(parent as Record<string, unknown>)._pageInfo as PageInfo }),
    totalCount: (parent) => (parent as Record<string, unknown>)._totalCount as number,
  },
  IssueEdge: {
    node: (parent) => (parent as Record<string, unknown>)._node as GqlValue,
    cursor: (parent) => (parent as Record<string, unknown>)._cursor as string,
  },
  PullRequestEdge: {
    node: (parent) => (parent as Record<string, unknown>)._node as GqlValue,
    cursor: (parent) => (parent as Record<string, unknown>)._cursor as string,
  },
  IssueCommentEdge: {
    node: (parent) => (parent as Record<string, unknown>)._node as GqlValue,
    cursor: (parent) => (parent as Record<string, unknown>)._cursor as string,
  },
  LabelEdge: {
    node: (parent) => (parent as Record<string, unknown>)._node as GqlValue,
    cursor: (parent) => (parent as Record<string, unknown>)._cursor as string,
  },
  PullRequestChangedFileEdge: {
    node: (parent) => (parent as Record<string, unknown>)._node as GqlValue,
    cursor: (parent) => (parent as Record<string, unknown>)._cursor as string,
  },
  PageInfo: {
    hasNextPage: (parent) => (parent as Record<string, unknown>).hasNextPage as boolean,
    hasPreviousPage: (parent) => (parent as Record<string, unknown>).hasPreviousPage as boolean,
    startCursor: (parent) => (parent as Record<string, unknown>).startCursor as string | null,
    endCursor: (parent) => (parent as Record<string, unknown>).endCursor as string | null,
  },
  __Type: {
    name: (parent) => (parent as Record<string, unknown>)._name as string,
    kind: (parent) => {
      const fields = (parent as Record<string, unknown>)._fields as string[];
      const enums = (parent as Record<string, unknown>)._enumValues as string[];
      return enums.length > 0 ? 'ENUM' : 'OBJECT';
    },
    fields: (parent) => ((parent as Record<string, unknown>)._fields as string[]).map((name) => fieldValue(name)),
    enumValues: (parent) => ((parent as Record<string, unknown>)._enumValues as string[]).map((name) => enumValue(name)),
  },
  __Field: {
    name: (parent) => (parent as Record<string, unknown>)._name as string,
    description: () => null,
  },
  __EnumValue: {
    name: (parent) => (parent as Record<string, unknown>)._name as string,
    description: () => null,
  },
  CreateIssuePayload: {
    issue: (parent) => (parent as Record<string, unknown>)._issue as GqlValue,
    clientMutationId: (parent) => (parent as Record<string, unknown>)._clientMutationId as string | null,
  },
  CloseIssuePayload: {
    issue: (parent) => (parent as Record<string, unknown>)._issue as GqlValue,
    clientMutationId: (parent) => (parent as Record<string, unknown>)._clientMutationId as string | null,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => (parent as Record<string, unknown>)._pull as GqlValue,
    clientMutationId: (parent) => (parent as Record<string, unknown>)._clientMutationId as string | null,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => (parent as Record<string, unknown>)._pull as GqlValue,
    clientMutationId: (parent) => (parent as Record<string, unknown>)._clientMutationId as string | null,
  },
  AddCommentPayload: {
    commentEdge: (parent) => {
      const comment = (parent as Record<string, unknown>)._comment as GqlValue;
      if (comment === null) return null;
      return { __typename: 'IssueCommentEdge', _node: comment, _cursor: encodeCursor(0) };
    },
    clientMutationId: (parent) => (parent as Record<string, unknown>)._clientMutationId as string | null,
  },
};

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

function typenameOf(value: GqlValue): string {
  if (value === null) return '';
  return (value.__typename as string | undefined) ?? '';
}

function completeValue(exec: Executor, value: unknown, field: FieldNode, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => completeValue(exec, entry, field, [...path, index]));
  }
  if (isRecord(value) && typeof value.__typename === 'string') {
    if (field.selectionSet === null) return value;
    return executeSelectionSet(exec, field.selectionSet, value.__typename, value, path);
  }
  return value;
}

function executeSelectionSet(
  exec: Executor,
  selections: SelectionNode[],
  parentType: string,
  parentValue: GqlValue,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment === undefined) {
        exec.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (skipSelection(selection.directives, exec.variables)) continue;
      if (fragment.typeCondition !== parentType && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(exec, fragment.selectionSet, parentType, parentValue, path));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (skipSelection(selection.directives, exec.variables)) continue;
      if (selection.typeCondition !== null && selection.typeCondition !== parentType && selection.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(exec, selection.selectionSet, parentType, parentValue, path));
      continue;
    }
    if (skipSelection(selection.directives, exec.variables)) continue;
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const table = FIELD_TABLES[parentType];
    const resolver = table?.[selection.name];
    if (resolver === undefined) {
      exec.errors.push({
        message: `Cannot query field "${selection.name}" on type "${parentType}".`,
        path: fieldPath,
        locations: [{ line: selection.line, column: selection.column }],
      });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(parentValue, argsOf(selection, exec.variables), exec);
    } catch (err) {
      exec.errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: fieldPath,
        locations: [{ line: selection.line, column: selection.column }],
      });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(exec, value, selection, fieldPath);
  }
  return out;
}

interface OperationResult {
  data: Record<string, unknown> | null;
  errors: GraphQLErrorEntry[];
}

/** Run one parsed operation against the store. */
function executeOperation(store: Store, operation: OperationDefinitionNode, fragments: Map<string, FragmentDefinitionNode>, variables: Record<string, unknown>): OperationResult {
  const exec: Executor = { store, variables, fragments, errors: [] };
  // Variable defaults fill in values the caller did not send.
  for (const definition of operation.variableDefinitions) {
    if (!(definition.name in exec.variables) || exec.variables[definition.name] === undefined) {
      exec.variables[definition.name] = definition.defaultValue === null ? null : valueOf(definition.defaultValue, exec.variables);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(exec, operation.selectionSet, rootType, {}, []);
  return { data, errors: exec.errors };
}

/** Run one operation document ({query, variables, operationName}). */
function runOperation(store: Store, body: unknown): OperationResult {
  if (!isRecord(body)) {
    return { data: null, errors: [{ message: 'The request body must be a JSON object with a "query" string.' }] };
  }
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'The request body must carry a "query" string.' }] };
  }
  const variables = isRecord(body.variables) ? { ...body.variables } : {};
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? `Syntax Error: ${err.message}` : String(err) }] };
  }
  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'The document holds no operation.' }] };
  }
  let operation: OperationDefinitionNode | undefined;
  if (typeof body.operationName === 'string') {
    operation = operations.find((entry) => entry.name === body.operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${body.operationName}".` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { data: null, errors: [{ message: 'The document holds several operations; name one with operationName.' }] };
  }
  return executeOperation(store, operation, fragments, variables);
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

/**
 * Handle POST /api/graphql. Returns true when the path is the GraphQL endpoint
 * (handled); false otherwise. Auth is enforced by the caller (app.ts).
 */
export function handleGraphql(ctx: Ctx, store: Store, reply: Reply): boolean {
  if (ctx.path !== '/api/graphql') return false;
  if (ctx.method !== 'POST') {
    reply.json(404, { message: 'Not Found' });
    return true;
  }
  if (ctx.jsonError) {
    reply.json(400, { errors: [{ message: 'Malformed JSON in request body' }] });
    return true;
  }
  const body = ctx.json;
  if (Array.isArray(body)) {
    // Operation batching: one answer per operation, in request order.
    const results = body.map((entry) => {
      const result = runOperation(store, entry);
      return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
    });
    reply.json(200, results);
    return true;
  }
  const result = runOperation(store, body);
  if (result.errors.length > 0) reply.json(200, { data: result.data, errors: result.errors });
  else reply.json(200, { data: result.data });
  return true;
}
