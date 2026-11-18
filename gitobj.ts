// gitobj.ts — git object store primitives: SHA-1 objects, trees/commits/tags,
// pkt-line framing, packfile read/write (with delta resolution), reachability.
// Standard git formats (public spec); written for this forge, stdlib only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 id of an object: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = buf.subarray(offset, space).toString('utf8');
    const nul = buf.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL after name');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > buf.length) throw new Error('malformed tree: truncated oid');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directories as if the name ended with '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = a.name + (a.mode === '40000' ? '/' : '');
  const kb = b.name + (b.mode === '40000' ? '/' : '');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${message}`, 'utf8');
}

/** Peel a tag object (possibly nested) to its commit, or the oid itself when it is not a tag. */
export function peelToCommit(lookup: ObjectLookup, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error(`pkt-line payload of ${data.length} bytes exceeds the limit`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktItem = string | Uint8Array | 'flush' | 'delim' | 'response-end';

export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode every complete pkt-line in a buffer; throws on a malformed length prefix. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`bad pkt-line length prefix ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line payload');
    const raw = buf.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw: Buffer.from(raw) });
    offset += length;
  }
  return packets;
}

/** A streaming pkt-line decoder for request bodies arriving in chunks. */
export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Uint8Array): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.buffered += buf.length;
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const need = n - filled;
      if (first.length <= need) {
        first.copy(out, filled);
        filled += first.length;
        this.chunks.shift();
      } else {
        first.copy(out, filled, 0, need);
        this.chunks[0] = first.subarray(need);
        filled += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      if (filled >= n) break;
      const take = Math.min(n - filled, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  /** The next complete packet, or null when more bytes are needed. Throws on malformed input. */
  next(): GitPacket | null {
    const head = this.peek(4);
    if (head === null) return null;
    const text = head.toString('ascii');
    if (!HEX4.test(text)) throw new Error(`bad pkt-line length prefix ${JSON.stringify(text)}`);
    const length = parseInt(text, 16);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end' };
    }
    if (length < 4) throw new Error(`bad pkt-line length ${length}`);
    if (this.buffered < length) return null;
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }

  /** Bytes still buffered (a caller may treat leftovers as the raw pack after the flush). */
  remainingBytes(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  hasBuffered(): boolean {
    return this.buffered > 0;
  }
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = Buffer.isBuffer(buffer) ? buffer.subarray(offset) : Buffer.from(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
  checksumOk: boolean;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies a base object a thin pack leaves out. Every object's
 * SHA-1 is recomputed from its resolved bytes, so corruption cannot pass as a clone.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount, checksumOk };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** True when a pack's 20-byte trailer matches its bytes. */
export function verifyPackChecksum(pack: Uint8Array): boolean {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 20) return false;
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
  return actual === expected;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export interface ReachResult {
  /** Every object in the closure (commits, trees, blobs, tags). */
  objects: Map<string, GitObject>;
  /** Commits at exactly the depth limit (the shallow boundary), when a depth was given. */
  boundary: string[];
}

/**
 * The closure of `roots`: commits (with parents), tags (with targets), trees and blobs.
 * `depth` limits how many commit generations from the roots are included (1 = the roots only);
 * the commits at exactly that depth are reported as `boundary`. `cutAt` names commits that are
 * included with their trees but whose parents are not traversed (a client's shallow boundary:
 * the client holds the commit but not its history). Missing objects are skipped when
 * `allowMissing` is set, otherwise they throw.
 */
export function collectReachable(
  lookup: ObjectLookup,
  roots: Iterable<string>,
  options: { depth?: number; cutAt?: ReadonlySet<string>; allowMissing?: boolean } = {},
): ReachResult {
  const objects = new Map<string, GitObject>();
  const boundary: string[] = [];
  const depthLimit = options.depth;
  // commit oid -> generation from a root (0 = a root)
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) {
    if (!isObjectId(root) || root === ZERO_OID) continue;
    queue.push({ oid: root, depth: 0 });
  }
  const visitObject = (oid: string): GitObject | undefined => {
    if (objects.has(oid)) return objects.get(oid);
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) return undefined;
      throw new Error(`object ${oid} is missing from the store`);
    }
    objects.set(oid, object);
    return object;
  };
  const visitedTrees = new Set<string>();
  const visitTree = (oid: string): void => {
    if (visitedTrees.has(oid)) return;
    visitedTrees.add(oid);
    const object = visitObject(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const child = visitObject(entry.oid);
      if (child !== undefined && child.type === 'tree') visitTree(entry.oid);
    }
  };
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    const known = commitDepth.get(oid);
    if (known !== undefined && known <= depth) continue;
    commitDepth.set(oid, depth);
    const object = visitObject(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth });
      continue;
    }
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    visitTree(commit.tree);
    const atLimit = depthLimit !== undefined && depth >= depthLimit - 1;
    if (atLimit) {
      boundary.push(oid);
      continue;
    }
    if (options.cutAt !== undefined && options.cutAt.has(oid)) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return { objects, boundary };
}

/** True when `ancestor` is reachable from `descendant` by parent links (or they are equal). */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** A merge base of two commits: the first common ancestor found walking from `a` then `b`. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const seen = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (ancestorsOfA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// tree editing (the contents API and merges build trees through these)
// ---------------------------------------------------------------------------------------------

export interface TreeEdit {
  /** The new root tree oid. */
  rootOid: string;
  /** Every new tree/blob object created by the edit (to store). */
  created: GitObject[];
}

/**
 * Set (or delete, when `blobOid` is null) the blob at `segments` below `rootOid`
 * (null = an empty tree). Returns the new root tree and every object it created.
 * Empty directories left behind are pruned; an emptied root becomes the empty tree.
 */
export function updateTree(
  lookup: ObjectLookup,
  rootOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
): TreeEdit {
  const created: GitObject[] = [];
  const put = (data: Buffer, type: GitObjectType): string => {
    const oid = hashObject(type, data);
    if (lookup(oid) === undefined && !created.some((entry) => hashObject(entry.type, entry.data) === oid)) {
      created.push({ type, data });
    }
    return oid;
  };
  const edit = (treeOid: string | null, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = lookup(treeOid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth]!;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const childOid = child !== undefined && child.mode === '40000' ? child.oid : null;
      const next = edit(childOid, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    return put(buildTree([...entries.values()]), 'tree');
  };
  const root = edit(rootOid, 0);
  if (root === null) {
    const empty = buildTree([]);
    if (lookup(EMPTY_TREE_OID) === undefined) created.push({ type: 'tree', data: empty });
    return { rootOid: EMPTY_TREE_OID, created };
  }
  return { rootOid: root, created };
}

/** The object id at a path below a root tree, or null when the path does not exist. */
export function treeLookup(lookup: ObjectLookup, rootOid: string | null, segments: readonly string[]): string | null {
  let current = rootOid;
  for (const segment of segments) {
    if (current === null) return null;
    const object = lookup(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

/** Every path -> blob oid below a root tree (recursive). */
export function flattenTree(lookup: ObjectLookup, rootOid: string | null, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (treeOid: string, base: string): void => {
    const object = lookup(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  if (rootOid !== null) walk(rootOid, prefix);
  return out;
}
