// git.ts — git smart HTTP: info/refs (v0 + v2), upload-pack (v2 fetch, v0 fetch,
// v2 ls-refs) and receive-pack (v0, report-status, side-band-64k).
// Wire format as the harness's git-client expects it; objects live in the store.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitobj.ts';
import { VIEWER, type Repo, type Store } from './store.ts';

export interface GitCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  requestId: string;
}

export type SendFn = (status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>) => void;
export type SendJsonFn = (status: number, body: unknown, extraHeaders?: Record<string, string>) => void;

const AGENT = 'github-forge/1.0.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function headerOf(ctx: GitCtx, name: string): string {
  const value = ctx.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** The <owner>/<repo> of a `/*.git/...` path, or null when it is not a git path. */
export function parseGitPath(path: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  return { owner: match[1]!, repo: match[2]!, rest: match[3] ?? '' };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** The advertisement lines for one service, v0 style (refs + capabilities on the first line). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`
      : `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const tip = defaultTip(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = tip !== null ? `${tip} HEAD\0${caps}\n` : `${refs[0]!.oid} HEAD\0${caps}\n`;
    lines.push(headLine);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object !== undefined && object.type === 'tag') {
          const peeled = peelToCommit((oid) => repo.objects.get(oid), ref.oid);
          if (peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
        }
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// fetch pack computation (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

export interface FetchParams {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export interface FetchPlan {
  pack: Buffer;
  shallowOut: string[];
  unshallowOut: string[];
}

export function computeFetch(repo: Repo, params: FetchParams): FetchPlan {
  const key = JSON.stringify({
    w: [...params.wants].sort(),
    h: [...params.haves].sort(),
    s: [...params.shallow].sort(),
    d: params.depth,
  });
  const cached = repo.packCache.get(key);
  // A cache hit answers the whole plan: no closure walk at all.
  if (cached !== undefined) {
    return { pack: cached.pack, shallowOut: cached.shallowOut, unshallowOut: cached.unshallowOut };
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const held = new Set<string>();
  if (params.haves.length > 0) {
    const heldResult = collectReachable(lookup, params.haves, {
      cutAt: new Set(params.shallow),
      allowMissing: true,
    });
    for (const oid of heldResult.objects.keys()) held.add(oid);
  }
  const wanted = collectReachable(lookup, params.wants, { depth: params.depth ?? undefined, allowMissing: true });
  const toSend: GitObject[] = [];
  for (const [oid, object] of wanted.objects) {
    if (!held.has(oid)) toSend.push(object);
  }
  const pack = writePack(toSend);
  let shallowOut: string[] = [];
  let unshallowOut: string[] = [];
  if (params.depth !== null) {
    shallowOut = wanted.boundary;
    const boundarySet = new Set(shallowOut);
    for (const old of params.shallow) {
      if (wanted.objects.has(old) && !boundarySet.has(old)) unshallowOut.push(old);
    }
  }
  repo.packCache.set(key, { pack, shallowOut, unshallowOut });
  return { pack, shallowOut, unshallowOut };
}

/** Split pack bytes into sideband band-1 pkt-lines (each payload <= 65516 bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) {
    parts.push(encodePktLine(Buffer.from([1])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else {
    if (tip !== null && keep('HEAD')) {
      lines.push(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object !== undefined && object.type === 'tag') {
          const peeled = peelToCommit((oid) => repo.objects.get(oid), ref.oid);
          if (peeled !== ref.oid) line += ` peeled:${peeled}`;
        }
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0 || !lines[0]!.startsWith('command=')) throw new Error('missing command line');
  const command = lines[0]!.slice('command='.length).replace(/\n$/, '');
  const args = lines.slice(1).map((line) => line.replace(/\n$/, ''));
  void seenDelim;
  return { command, args };
}

function parseV2FetchArgs(args: string[]): FetchParams {
  const params: FetchParams = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) params.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) params.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) params.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n)) params.depth = n;
    }
  }
  return params;
}

function handleUploadPackV2(repo: Repo, ctx: GitCtx, send: SendFn): void {
  let parsed: { command: string; args: string[] };
  try {
    parsed = parseV2Command(ctx.body);
  } catch (err) {
    send(400, Buffer.from(JSON.stringify({ message: `malformed git request: ${(err as Error).message}` }), 'utf8'), 'application/json; charset=utf-8');
    return;
  }
  if (parsed.command === 'ls-refs') {
    send(200, handleLsRefs(repo, parsed.args), UPLOAD_RESULT);
    return;
  }
  if (parsed.command !== 'fetch') {
    send(400, Buffer.from(JSON.stringify({ message: `unknown command ${parsed.command}` }), 'utf8'), 'application/json; charset=utf-8');
    return;
  }
  const params = parseV2FetchArgs(parsed.args);
  const plan = computeFetch(repo, params);
  const parts: Buffer[] = [];
  if (params.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), Buffer.from('0001', 'ascii'));
  }
  if (params.depth !== null) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(Buffer.from('0000', 'ascii'));
  send(200, Buffer.concat(parts), UPLOAD_RESULT);
}

function handleUploadPackV0(repo: Repo, ctx: GitCtx, send: SendFn): void {
  let packets: GitPacket[];
  try {
    packets = decodePktLines(ctx.body);
  } catch (err) {
    send(400, Buffer.from(JSON.stringify({ message: `malformed git request: ${(err as Error).message}` }), 'utf8'), 'application/json; charset=utf-8');
    return;
  }
  const params: FetchParams = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      params.wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
    } else if (line.startsWith('have ')) params.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) params.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) params.depth = n;
    }
    void section;
  }
  if (params.wants.length === 0) {
    send(400, Buffer.from(JSON.stringify({ message: 'fetch needs at least one want' }), 'utf8'), 'application/json; charset=utf-8');
    return;
  }
  const plan = computeFetch(repo, params);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(Buffer.from('0000', 'ascii'));
  send(200, Buffer.concat(parts), UPLOAD_RESULT);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, store: Store, ctx: GitCtx, send: SendFn): void {
  const commands: PushCommand[] = [];
  let capabilities = '';
  let packStart = -1;
  // Walk the raw bytes: command pkt-lines up to the first flush, then the pack.
  const body = ctx.body;
  let cursor = 0;
  const readLine = (): { text: string; next: number } | null => {
    if (cursor + 4 > body.length) return null;
    const head = body.subarray(cursor, cursor + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = parseInt(head, 16);
    if (length === 0) return { text: '', next: cursor + 4 };
    if (cursor + length > body.length) return null;
    return { text: body.subarray(cursor + 4, cursor + length).toString('utf8'), next: cursor + length };
  };
  let first = true;
  for (;;) {
    const line = readLine();
    if (line === null) {
      send(400, Buffer.from(JSON.stringify({ message: 'malformed push command list' }), 'utf8'), 'application/json; charset=utf-8');
      return;
    }
    cursor = line.next;
    if (line.text === '') break; // flush: the pack follows
    let text = line.text.replace(/\n$/, '');
    if (first) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
      first = false;
    }
    const parts = text.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      send(400, Buffer.from(JSON.stringify({ message: `bad push command ${JSON.stringify(text)}` }), 'utf8'), 'application/json; charset=utf-8');
      return;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  packStart = cursor;
  const packBytes = body.subarray(packStart);

  const reportLines: string[] = [];
  const sideband = capabilities.split(' ').includes('side-band-64k');
  const failUnpack = (detail: string): void => {
    reportLines.push(`unpack ${detail}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  };

  let unpackOk = true;
  if (commands.some((command) => command.newOid !== ZERO_OID)) {
    if (packBytes.length === 0) {
      unpackOk = false;
      failUnpack('error: no packfile was sent');
    } else {
      try {
        const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
        if (!read.checksumOk) {
          unpackOk = false;
          failUnpack('error: pack checksum mismatch');
        } else {
          // Store every unpacked object (git unpacks before it judges the refs).
          for (const object of read.objects.values()) {
            const oid = hashObject(object.type, object.data);
            if (!repo.objects.has(oid)) {
              repo.objects.set(oid, object);
              repo.packCache.clear();
            }
          }
        }
      } catch (err) {
        unpackOk = false;
        failUnpack(`error: ${(err as Error).message}`);
      }
    }
  }

  if (unpackOk) {
    reportLines.push('unpack ok\n');
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reportLines.push(`ng ${command.ref} ref does not exist\n`);
        else if (current !== command.oldOid) reportLines.push(`ng ${command.ref} old value mismatch\n`);
        else {
          store.deleteRef(repo, command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (target === undefined) {
        reportLines.push(`ng ${command.ref} missing object\n`);
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
        reportLines.push(`ng ${command.ref} not a commit\n`);
        continue;
      }
      if (command.ref.startsWith('refs/tags/') && target.type !== 'commit' && target.type !== 'tag') {
        reportLines.push(`ng ${command.ref} not a commit or tag\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) reportLines.push(`ng ${command.ref} already exists\n`);
        else {
          store.setRef(repo, command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} ref does not exist\n`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} old value mismatch\n`);
        continue;
      }
      if (command.oldOid !== command.newOid && !isAncestor(lookup, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      store.setRef(repo, command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }

  const inner = encodePktLines([...reportLines, 'flush']);
  let out: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let off = 0; off < inner.length; off += CHUNK) {
      const chunk = inner.subarray(off, Math.min(inner.length, off + CHUNK));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    out = Buffer.concat(parts);
  } else {
    out = inner;
  }
  send(200, out, RECEIVE_RESULT);
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns true when the path is a git path
 * (handled, even on 404); false when it is not one at all.
 */
export function handleGit(ctx: GitCtx, store: Store, send: SendFn, sendJson: SendJsonFn): boolean {
  const parsed = parseGitPath(ctx.path);
  if (parsed === null) return false;
  const { owner, repo: repoName, rest } = parsed;
  if (owner !== VIEWER.login) {
    sendJson(404, { message: 'Not Found' });
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(404, { message: 'Not Found' });
    return true;
  }
  if (ctx.method === 'GET' && rest === '/info/refs') {
    const service = ctx.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if (headerOf(ctx, 'git-protocol') === 'version=2') send(200, v2Advertisement(), UPLOAD_AD);
      else send(200, v0Advertisement(repo, 'git-upload-pack'), UPLOAD_AD);
      return true;
    }
    if (service === 'git-receive-pack') {
      send(200, v0Advertisement(repo, 'git-receive-pack'), RECEIVE_AD);
      return true;
    }
    sendJson(404, { message: 'Not Found' });
    return true;
  }
  if (ctx.method === 'POST' && rest === '/git-upload-pack') {
    if (headerOf(ctx, 'git-protocol') === 'version=2') handleUploadPackV2(repo, ctx, send);
    else handleUploadPackV0(repo, ctx, send);
    return true;
  }
  if (ctx.method === 'POST' && rest === '/git-receive-pack') {
    handleReceivePack(repo, store, ctx, send);
    return true;
  }
  sendJson(404, { message: 'Not Found' });
  return true;
}
