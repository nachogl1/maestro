import { invoke } from "@tauri-apps/api/core";
import type { Mark, Node as PmNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { WORK_JOURNAL_ENTRY_NODE } from "./WorkJournalEntryNode";

/**
 * The spelling fixer's model call: sends the texts to a headless Claude and
 * returns the fixed texts in the same order. The one way the page reaches
 * the model; tests mock `invoke`. Rejects with a plain sentence on failure.
 */
export function fixWorkJournalSpelling(texts: string[]): Promise<string[]> {
  return invoke<string[]>("work_journal_fix_spelling", { texts });
}

/** A doc range, `from` inclusive and `to` exclusive. */
interface DocRange {
  from: number;
  to: number;
}

/** One piece of page text the fixer sends: plain text between two doc positions. */
export interface SpellingSegment extends DocRange {
  text: string;
  /** Doc ranges a fix must leave exactly as they are (links, code, numbers, the project). */
  locked: DocRange[];
  /** Part of a card's bold lead: a fix may not add a colon, which would move the bold split. */
  inLead: boolean;
}

/** One replacement of page text: `from..to` becomes `text`. */
export interface SpellingEdit extends DocRange {
  text: string;
}

/** Marks whose text a fix never changes, and never spreads onto new text. */
const LOCKED_MARKS = new Set(["link", "code"]);

/** Times, dates, versions and other numbers: digits with their separators. */
const NUMBER_PATTERN = /\d(?:[\d:./-]*\d)?/g;

/** Web addresses written as plain text. */
const ADDRESS_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

/** Words (with inner apostrophes), runs of space, and single other characters. */
const TOKEN_PATTERN = /[\p{L}\p{N}_'’]+|\s+|[^\p{L}\p{N}_'’\s]/gu;

/** The words of a text: letters and digits, with inner apostrophes. */
const WORD_PATTERN = /[\p{L}\p{N}_'’]+/gu;

/** Above this many token pairs the diff replaces the changed middle as one piece. */
const MAX_DIFF_CELLS = 2_000_000;

/** A letter in any script: a text without one has nothing to fix. */
const LETTER = /\p{L}/u;

/**
 * The texts the fixer sends for `range` (a selection), or for the whole
 * page when there is none: every run of plain text in a block, split at
 * line breaks and, in an entry card, at the first colon (never sent, so the
 * bold split cannot move), clipped to the range and trimmed. A card's time,
 * project and source are attributes and are never sent.
 */
export function spellingSegments(doc: PmNode, range?: DocRange): SpellingSegment[] {
  const from = range?.from ?? 0;
  const to = range?.to ?? doc.content.size;
  const segments: SpellingSegment[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isTextblock) return true;
    const project =
      parent?.type.name === WORK_JOURNAL_ENTRY_NODE ? String(parent.attrs.project ?? "") : null;
    for (const piece of blockPieces(node, pos + 1, project)) {
      const segment = clipAndTrim(doc, piece, from, to);
      if (segment) segments.push(segment);
    }
    return false;
  });
  return segments;
}

/** A block's runs of text, split at the card colon, with their locked ranges. */
function blockPieces(block: PmNode, start: number, project: string | null): SpellingSegment[] {
  const runs: Array<{ from: number; text: string; locked: DocRange[] }> = [];
  let run: { from: number; text: string; locked: DocRange[] } | null = null;
  block.forEach((child, offset) => {
    const at = start + offset;
    if (!child.isText || !child.text) {
      run = null;
      return;
    }
    if (!run) {
      run = { from: at, text: "", locked: [] };
      runs.push(run);
    }
    run.text += child.text;
    if (child.marks.some((m) => LOCKED_MARKS.has(m.type.name))) {
      run.locked.push({ from: at, to: at + child.text.length });
    }
  });

  const isCard = project !== null;
  let colon: number | null = null;
  if (isCard) {
    for (const r of runs) {
      const index = r.text.indexOf(":");
      if (index !== -1) {
        colon = r.from + index;
        break;
      }
    }
  }

  const pieces: SpellingSegment[] = [];
  for (const r of runs) {
    const locked = [...r.locked, ...lockedText(r.text, r.from, project)];
    const end = r.from + r.text.length;
    const cuts =
      colon !== null && colon >= r.from && colon < end
        ? [
            { from: r.from, to: colon },
            { from: colon + 1, to: end },
          ]
        : [{ from: r.from, to: end }];
    for (const cut of cuts) {
      pieces.push({
        ...cut,
        text: r.text.slice(cut.from - r.from, cut.to - r.from),
        locked,
        inLead: isCard && (colon === null || cut.to <= colon),
      });
    }
  }
  return pieces;
}

/** Numbers, web addresses and the card's own project name in `text`, as doc ranges. */
function lockedText(text: string, from: number, project: string | null): DocRange[] {
  const ranges: DocRange[] = [];
  for (const pattern of [NUMBER_PATTERN, ADDRESS_PATTERN]) {
    for (const m of text.matchAll(pattern)) {
      ranges.push({ from: from + (m.index ?? 0), to: from + (m.index ?? 0) + m[0].length });
    }
  }
  if (project) {
    for (let at = text.indexOf(project); at !== -1; at = text.indexOf(project, at + 1)) {
      ranges.push({ from: from + at, to: from + at + project.length });
    }
  }
  return ranges;
}

/** `piece` cut to `from..to` and without outer space; null when no letter is left. */
function clipAndTrim(
  doc: PmNode,
  piece: SpellingSegment,
  from: number,
  to: number,
): SpellingSegment | null {
  let start = Math.max(piece.from, from);
  let end = Math.min(piece.to, to);
  if (start >= end) return null;
  const text = doc.textBetween(start, end);
  start += text.length - text.trimStart().length;
  end -= text.length - text.trimEnd().length;
  const trimmed = text.trim();
  if (!LETTER.test(trimmed)) return null;
  return { ...piece, from: start, to: end, text: trimmed };
}

/**
 * The changed stretches between `before` and `after`, as character offsets
 * into `before` and their new text, found by a word-level diff so text that
 * did not change (and its formatting) is never rewritten.
 */
export function diffText(
  before: string,
  after: string,
): Array<{ start: number; end: number; text: string }> {
  if (before === after) return [];
  const a = before.match(TOKEN_PATTERN) ?? [];
  const b = after.match(TOKEN_PATTERN) ?? [];
  if (a.length * b.length > MAX_DIFF_CELLS) return [middleChange(before, after)];
  // lcs[i][j]: the longest common run of tokens of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks: Array<{ start: number; end: number; text: string }> = [];
  let hunk: { start: number; end: number; text: string } | null = null;
  let at = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (hunk) hunks.push(hunk);
      hunk = null;
      at += a[i].length;
      i++;
      j++;
      continue;
    }
    hunk ??= { start: at, end: at, text: "" };
    if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      hunk.text += b[j];
      j++;
    } else {
      at += a[i].length;
      hunk.end = at;
      i++;
    }
  }
  if (hunk) hunks.push(hunk);
  return hunks;
}

/** The one change between the common start and the common end of two texts. */
function middleChange(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    start,
    end: before.length - tail,
    text: after.slice(start, after.length - tail),
  };
}

/** Whether replacing `edit` would change or split a locked range. */
function touchesLocked(edit: DocRange, locked: DocRange[]): boolean {
  return locked.some((r) =>
    edit.from === edit.to
      ? edit.from > r.from && edit.from < r.to
      : edit.from < r.to && edit.to > r.from,
  );
}

/** The words of `text`, lower case. */
function wordsOf(text: string): string[] {
  return (text.match(WORD_PATTERN) ?? []).map((w) => w.toLowerCase());
}

/**
 * The edit distance between two words, a swap of two neighbouring letters
 * counting as one edit ("teh" and "the" are one apart).
 */
function wordDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Whether `fixed` reads as a spelling fix of `word`: the same word, or a typo away from it. */
function sameWord(word: string, fixed: string): boolean {
  return wordDistance(word, fixed) <= Math.max(1, Math.floor(word.length / 3));
}

/**
 * Whether `after` is a spelling, grammar and punctuation fix of `before`
 * rather than other text: at least half of the words, counted on the longer
 * side, are kept in order (unchanged or a typo away). A swapped, repeated,
 * rewritten or emptied text fails.
 */
export function isSpellingFix(before: string, after: string): boolean {
  const a = wordsOf(before);
  const b = wordsOf(after);
  if (a.length * b.length > MAX_DIFF_CELLS) return before === after;
  const kept = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      kept[i][j] = sameWord(a[i], b[j])
        ? kept[i + 1][j + 1] + 1
        : Math.max(kept[i + 1][j], kept[i][j + 1]);
    }
  }
  return kept[0][0] * 2 >= Math.max(a.length, b.length, 1);
}

/**
 * The edits that turn each segment's text into its fixed text (`fixed[i]`
 * for `segments[i]`), or null when any fixed text is not a spelling fix of
 * its segment ({@link isSpellingFix}): the reply is then refused whole. A
 * change that would touch a link, code, a number or the card's project, or
 * add a colon to a card's bold lead, is left out.
 */
export function spellingEdits(segments: SpellingSegment[], fixed: string[]): SpellingEdit[] | null {
  const afters = segments.map((_, index) => (fixed[index] ?? "").trim());
  if (segments.some((segment, index) => !isSpellingFix(segment.text, afters[index]))) {
    return null;
  }
  const edits: SpellingEdit[] = [];
  segments.forEach((segment, index) => {
    const after = afters[index];
    for (const hunk of diffText(segment.text, after)) {
      const edit = {
        from: segment.from + hunk.start,
        to: segment.from + hunk.end,
        text: hunk.text,
      };
      if (touchesLocked(edit, segment.locked)) continue;
      if (segment.inLead && edit.text.includes(":")) continue;
      edits.push(edit);
    }
  });
  return edits;
}

/** The marks new text at `edit` takes: the replaced text's, else its neighbour's. */
function marksAt(doc: PmNode, edit: SpellingEdit): readonly Mark[] {
  const $pos = doc.resolve(edit.from);
  const source =
    edit.to > edit.from
      ? $pos.nodeAfter
      : $pos.nodeBefore?.isText
        ? $pos.nodeBefore
        : $pos.nodeAfter;
  return (source?.marks ?? []).filter((m) => !LOCKED_MARKS.has(m.type.name));
}

/** Applies `edits` (from one page state) to `tr`, last first so positions hold. */
export function applySpellingEdits(tr: Transaction, edits: SpellingEdit[]): Transaction {
  const { schema } = tr.doc.type;
  for (const edit of [...edits].sort((x, y) => y.from - x.from)) {
    if (edit.text === "") tr.delete(edit.from, edit.to);
    else tr.replaceWith(edit.from, edit.to, schema.text(edit.text, marksAt(tr.doc, edit)));
  }
  return tr;
}

/** The line shown after a successful fix. */
export function fixesMessage(count: number): string {
  return count === 1 ? "1 fix made" : `${count} fixes made`;
}
