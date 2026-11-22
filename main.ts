// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves an edit performed, as [old, new] pairs, for the R lines of the output. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A line of O or N: `ctx` marks a context line, written as the file's own matched line. */
interface Seg {
  text: string;
  ctx: boolean;
}

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text at its own line break, keeping whether it ends with one. */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text.endsWith(br)) return { lines: text.slice(0, -br.length).split(br), br, final: true };
  return { lines: text.split(br), br, final: false };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

const leadingWs = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in `file` at `tier`. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== on[j]) { ok = false; break; }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs, with all its positions, or null. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(file, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Replace file[at .. at+o.length) with N: context lines as the file's own, tier-2 re-indent for the rest. */
function applyReplace(file: string[], at: number, o: Seg[], n: Seg[], tier: number): string[] {
  const f = leadingWs(file[at] ?? '');
  const p = o.length > 0 ? leadingWs(o[0]!.text) : '';
  const ctxIdx: number[] = [];
  o.forEach((s, i) => { if (s.ctx) ctxIdx.push(i); });
  let ci = 0;
  const out: string[] = [];
  for (const s of n) {
    if (s.ctx) {
      out.push(file[at + ctxIdx[ci]!]!);
      ci++;
    } else {
      let t = s.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return [...file.slice(0, at), ...out, ...file.slice(at + o.length)];
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = splitFile(text);
  let lines = parts.lines;
  const br = parts.br;
  let fin = parts.final;
  let d = 0;
  for (const h of hunks) {
    const oText = h.o.map((s) => s.text);
    if (oText.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const ins = h.n.map((s) => s.text);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) fin = !h.noNl;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, oText, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const touchesEnd = best + oText.length === lines.length;
    lines = applyReplace(lines, best, h.o, h.n, found.tier);
    if (touchesEnd) fin = !h.noNl;
    d += h.n.length - oText.length;
  }
  return joinFile(lines, br, fin);
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface Hunk {
  a: number;
  o: Seg[];
  n: Seg[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noNlPlus: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  rFrom: string | null;
  rTo: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function parseGitDiff(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  return [rest.slice(0, sep).trim(), rest.slice(sep + 3).trim()];
}

function parseUnifiedPath(s: string): string {
  let p = s;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Read a unified patch (SPEC.md section 6) into its sections. */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { oldPath: oldP, newPath: newP, hasPair: false, rFrom: null, rTo: null, creation: false, deletion: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = parseGitDiff(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(g[0], g[1]);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const op = parseUnifiedPath(line.slice(4));
      const np = parseUnifiedPath(lines[i + 1]!.slice(4));
      if (cur === null || !inHeader || cur.hasPair) {
        startSection(op, np);
        cur!.hasPair = true;
      } else {
        cur.oldPath = op;
        cur.newPath = np;
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkHead.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) { body.push(b); j++; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: Seg[] = [];
      const nn: Seg[] = [];
      let lastCtxPlus = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b.startsWith('\\')) continue;
        if (b === '' || b.startsWith(' ')) {
          const t = b === '' ? '' : b.slice(1);
          o.push({ text: t, ctx: true });
          nn.push({ text: t, ctx: true });
          lastCtxPlus = k;
        } else if (b.startsWith('-')) {
          o.push({ text: b.slice(1), ctx: false });
        } else if (b.startsWith('+')) {
          nn.push({ text: b.slice(1), ctx: false });
          lastCtxPlus = k;
          lastPlus = k;
        }
      }
      const noNl = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
      const noNlPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
      cur.hunks.push({ a, o, n: nn, noNl, noNlPlus });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.rFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.rTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.creation = true;
      else if (line.startsWith('deleted file mode')) cur.deletion = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** One Edit per unified section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => (tree: Tree) => {
    let oldP = s.oldPath;
    let newP = s.newPath;
    if (!s.hasPair) {
      if (s.rFrom !== null) oldP = s.rFrom;
      if (s.rTo !== null) newP = s.rTo;
    }
    const isCreate = s.creation || oldP === '/dev/null';
    const isDelete = !isCreate && (s.deletion || newP === '/dev/null');
    if (isCreate) {
      const np = newP;
      if (np === null || np === '/dev/null') return;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const seg of h.n) if (!seg.ctx) plus.push(seg.text);
      let noNl = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k]!.n.some((seg) => !seg.ctx)) { noNl = s.hunks[k]!.noNlPlus; break; }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP;
      if (op === null || op === '/dev/null') return;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (op === np) {
      if (!safe(op)) throw new Fail('unsafe', op);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      tree.now.set(op, applyHunks(cur, s.hunks, strict, op));
      return;
    }
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (tree.get(np) !== null) throw new Fail('exists', np);
    tree.now.set(np, applyHunks(cur, s.hunks, strict, op));
    tree.now.set(op, null);
    tree.moves.push([op, np]);
  });
}

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const parts = splitFile(cur);
    const found = findTier(parts.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const out = applyReplace(
      parts.lines,
      found.pos[0]!,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      found.tier,
    );
    tree.now.set(path, joinFile(out, parts.br, parts.final));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) into edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const sIdx = i;
      let path: string | null = null;
      for (let j = sIdx - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = sIdx + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') { eq = j; break; }
        if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '>>>>>>> REPLACE') { rep = j; break; }
        if (t === '<<<<<<< SEARCH') break;
      }
      if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      edits.push(makeSREdit(path, lines.slice(sIdx + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: Seg[];
  n: Seg[];
}

/** The first line at or after `from` equal to the anchor at the first tier with one, or -1. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

/** The first tier with an occurrence of O at or after `from`, with its positions, or null. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function makeV4AAdd(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function makeV4AUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(cur);
    let lines = parts.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const oText = ch.o.map((s) => s.text);
      if (oText.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins = ch.n.map((s) => s.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      const found = findTierFrom(lines, oText, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let pos = found.pos[0]!;
      if (ch.eof) {
        const end = found.pos.find((p) => p + oText.length === lines.length);
        if (end === undefined) throw new Fail('no-match', path);
        pos = end;
      }
      lines = applyReplace(lines, pos, ch.o, ch.n, found.tier);
      cursor = pos + ch.n.length;
    }
    const out = joinFile(lines, parts.br, parts.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

const v4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Read a V4A patch (SPEC.md section 8) into edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const start = i;
      i++;
      const raw: string[] = [];
      while (i < last && !v4aSectionStart(lines[i]!)) { raw.push(lines[i]!); i++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const content: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k]!;
        if (r === '') content.push('');
        else if (r.startsWith('+')) content.push(r.slice(1));
        else throw new Exit2(`error: parse ${start + 2 + k}`);
      }
      edits.push(makeV4AAdd(p, content));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && blank(lines[i]!)) i++;
      if (i < last && !v4aSectionStart(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(((pp) => (tree: Tree) => {
        if (!safe(pp)) throw new Fail('unsafe', pp);
        if (tree.get(pp) === null) throw new Fail('missing', pp);
        tree.now.set(pp, null);
      })(p));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updLine = i;
      i++;
      const raw: { text: string; idx: number }[] = [];
      while (i < last && !v4aSectionStart(lines[i]!)) { raw.push({ text: lines[i]!, idx: i }); i++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to:')) {
        moveTo = raw[k]!.text.slice('*** Move to:'.length).trim();
        if (moveTo === '') throw new Exit2(`error: parse ${raw[k]!.idx + 1}`);
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => { if (cur !== null) { chunks.push(cur); cur = null; } };
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.text.startsWith('@@')) {
          closeChunk();
          const anchor = r.text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
          continue;
        }
        if (r.text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          closeChunk();
          continue;
        }
        if (r.text.startsWith('*** ')) throw new Exit2(`error: parse ${r.idx + 1}`);
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur = { anchor: null, eof: false, o: [], n: [] };
        }
        if (r.text === '' || r.text.startsWith(' ')) {
          const t = r.text === '' ? '' : r.text.slice(1);
          cur.o.push({ text: t, ctx: true });
          cur.n.push({ text: t, ctx: true });
        } else if (r.text.startsWith('-')) {
          cur.o.push({ text: r.text.slice(1), ctx: false });
        } else if (r.text.startsWith('+')) {
          cur.n.push({ text: r.text.slice(1), ctx: false });
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine + 1}`);
      edits.push(makeV4AUpdate(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<[string, string]> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push([newP, `R ${oldP} -> ${newP}`]);
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push([p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`]);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const outLines = rows.map((r) => r[1]);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
