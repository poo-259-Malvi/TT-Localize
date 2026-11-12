// TT-Localize
// Duplicates the selected frames once per language, replaces the copy in their
// text layers with translations from an uploaded CSV / Excel sheet, keeps mixed
// text styles, and groups each language into its own Figma section.
//
// A text layer is matched to a sheet row by:
//   1. Layer name   -> value in the "key" column          (e.g. layer "headline")
//   2. Text content -> value in the "source text" column  (e.g. "Buy now")
//
// Mixed styles (bold words, coloured prices, links...) are kept by:
//   - Tags in the translation: <1>…</1>, <2>…</2> = 1st, 2nd styled run of the
//     original text; <b>, <i>, <u> = the bold / italic / underlined run.
//   - Otherwise, styled runs whose text appears unchanged in the translation
//     (numbers, prices, brand names) are restyled automatically.
//   - Everything else gets the text's main (most used) style.

figma.showUI(__html__, { width: 400, height: 680, themeColors: true });

// ---------- Message types ----------

interface GenerateMessage {
  type: 'generate';
  headers: string[];
  rows: string[][];
  keyColumn: number; // -1 = don't match by layer name
  sourceColumn: number; // -1 = don't match by text content
  languageColumns: number[];
  useSections: boolean;
  gap: number;
}

interface OrganizeMessage {
  type: 'organize';
  languages: string[]; // known language names from the sheet (may be empty)
}

type UIMessage = GenerateMessage | OrganizeMessage | { type: 'cancel' };

interface LanguageReport {
  language: string;
  replaced: number;
  styledRuns: number;
  emptyTranslation: number;
}

// ---------- General helpers ----------

const SECTION_PADDING = 80;

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

function postSelection(): void {
  const nodes = figma.currentPage.selection;
  figma.ui.postMessage({
    type: 'selection',
    count: nodes.length,
    names: nodes.slice(0, 5).map((n) => n.name),
  });
}

function buildLookup(rows: string[][], column: number): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (column < 0) return map;
  for (const row of rows) {
    const k = normalize(stripTags(row[column] ?? ''));
    if (k && !map.has(k)) map.set(k, row);
  }
  return map;
}

function textNodesIn(node: SceneNode): TextNode[] {
  if (node.type === 'TEXT') return [node];
  if ('findAllWithCriteria' in node) return node.findAllWithCriteria({ types: ['TEXT'] });
  return [];
}

function absolutePosition(node: SceneNode): { x: number; y: number } {
  const t = node.absoluteTransform;
  return { x: t[0][2], y: t[1][2] };
}

/** The ancestor that sits directly on the page (or the node itself). */
function topLevel(node: SceneNode): SceneNode {
  let current: SceneNode = node;
  while (current.parent && current.parent.type !== 'PAGE' && current.parent.type !== 'DOCUMENT') {
    current = current.parent as SceneNode;
  }
  return current;
}

function bottomOf(node: SceneNode): number {
  return absolutePosition(node).y + node.height;
}

function safeName(header: string, index: number): string {
  return header.trim() || `Column ${index + 1}`;
}

// ---------- Fonts ----------

const loadedFonts = new Set<string>();

async function loadFontsFor(node: TextNode): Promise<void> {
  const fonts: FontName[] =
    node.characters.length > 0
      ? node.getRangeAllFontNames(0, node.characters.length)
      : node.fontName !== figma.mixed
        ? [node.fontName]
        : [];
  for (const font of fonts) {
    const id = `${font.family}::${font.style}`;
    if (loadedFonts.has(id)) continue;
    await figma.loadFontAsync(font);
    loadedFonts.add(id);
  }
}

// ---------- Mixed styles ----------

type StyleField =
  | 'fontName'
  | 'fontSize'
  | 'fills'
  | 'fillStyleId'
  | 'textStyleId'
  | 'textDecoration'
  | 'textCase'
  | 'letterSpacing'
  | 'lineHeight'
  | 'hyperlink';

const STYLE_FIELDS: StyleField[] = [
  'fontName',
  'fontSize',
  'fills',
  'fillStyleId',
  'textStyleId',
  'textDecoration',
  'textCase',
  'letterSpacing',
  'lineHeight',
  'hyperlink',
];

type Segment = Pick<StyledTextSegment, StyleField | 'characters' | 'start' | 'end'>;
type TextStyleRun = Pick<StyledTextSegment, StyleField>;

interface StyledRange {
  start: number;
  end: number;
  style: TextStyleRun;
}

const TAG_RE = /<(\d+|b|strong|i|em|u)>([\s\S]*?)<\/\1>/gi;

function stripTags(text: string): string {
  return text.replace(TAG_RE, '$2');
}

function styleKey(s: TextStyleRun): string {
  return JSON.stringify(STYLE_FIELDS.map((f) => s[f]));
}

function pickStyle(seg: Segment): TextStyleRun {
  const out = {} as Record<StyleField, unknown>;
  for (const f of STYLE_FIELDS) out[f] = seg[f];
  return out as TextStyleRun;
}

async function applyStyle(node: TextNode, start: number, end: number, s: TextStyleRun): Promise<void> {
  if (end <= start) return;
  if (s.textStyleId) {
    await node.setRangeTextStyleIdAsync(start, end, s.textStyleId);
  } else {
    node.setRangeFontName(start, end, s.fontName);
    node.setRangeFontSize(start, end, s.fontSize);
    node.setRangeTextDecoration(start, end, s.textDecoration);
    node.setRangeTextCase(start, end, s.textCase);
    node.setRangeLetterSpacing(start, end, s.letterSpacing);
    node.setRangeLineHeight(start, end, s.lineHeight);
  }
  if (s.fillStyleId) {
    await node.setRangeFillStyleIdAsync(start, end, s.fillStyleId);
  } else {
    node.setRangeFills(start, end, s.fills);
  }
  node.setRangeHyperlink(start, end, s.hyperlink);
}

/** Resolve <b>/<i>/<u> tags to the first styled run that looks bold/italic/underlined. */
function namedTagStyle(tag: string, runs: TextStyleRun[]): TextStyleRun | undefined {
  const t = tag.toLowerCase();
  if (t === 'b' || t === 'strong')
    return runs.find((r) => /bold|black|heavy|semi|medium/i.test(r.fontName.style)) ?? runs[0];
  if (t === 'i' || t === 'em') return runs.find((r) => /italic|oblique/i.test(r.fontName.style)) ?? runs[0];
  if (t === 'u') return runs.find((r) => r.textDecoration === 'UNDERLINE') ?? runs[0];
  return undefined;
}

/**
 * Replace the node's text with `translation`, keeping its mixed styles.
 * Returns how many styled runs were re-applied.
 */
async function localizeText(node: TextNode, translation: string): Promise<number> {
  await loadFontsFor(node);
  const segments: Segment[] =
    node.characters.length > 0 ? node.getStyledTextSegments(STYLE_FIELDS) : [];

  // Uniform text: setting characters keeps the single style.
  if (segments.length <= 1) {
    node.characters = stripTags(translation);
    return 0;
  }

  // Main style = the one covering the most characters.
  const usage = new Map<string, { style: TextStyleRun; chars: number; texts: string[] }>();
  for (const seg of segments) {
    const key = styleKey(seg);
    const entry = usage.get(key) ?? { style: pickStyle(seg), chars: 0, texts: [] };
    entry.chars += seg.end - seg.start;
    entry.texts.push(seg.characters);
    usage.set(key, entry);
  }
  let baseKey = '';
  let best = -1;
  for (const [key, entry] of usage) {
    if (entry.chars > best) {
      best = entry.chars;
      baseKey = key;
    }
  }
  const base = usage.get(baseKey)!.style;

  // Other styles, numbered in the order they first appear (<1>, <2>, ...).
  const runOrder: string[] = [];
  for (const seg of segments) {
    const key = styleKey(seg);
    if (key !== baseKey && !runOrder.includes(key)) runOrder.push(key);
  }
  const runs = runOrder.map((k) => usage.get(k)!.style);

  // 1) Explicit tags in the translation.
  const ranges: StyledRange[] = [];
  let plain = '';
  let last = 0;
  let tagged = false;
  for (const m of translation.matchAll(TAG_RE)) {
    tagged = true;
    plain += translation.slice(last, m.index);
    const tag = m[1];
    const inner = m[2];
    const style = /^\d+$/.test(tag) ? runs[Number(tag) - 1] : namedTagStyle(tag, runs);
    if (style && inner.length) ranges.push({ start: plain.length, end: plain.length + inner.length, style });
    plain += inner;
    last = (m.index ?? 0) + m[0].length;
  }
  plain += translation.slice(last);

  // 2) No tags: restyle runs whose text appears unchanged (prices, numbers, brands).
  if (!tagged) {
    const lower = plain.toLowerCase();
    for (const key of runOrder) {
      const entry = usage.get(key)!;
      for (const text of entry.texts) {
        const needle = text.trim().toLowerCase();
        if (!needle) continue;
        let from = 0;
        let idx: number;
        while ((idx = lower.indexOf(needle, from)) !== -1) {
          const end = idx + needle.length;
          if (!ranges.some((r) => idx < r.end && end > r.start)) {
            ranges.push({ start: idx, end, style: entry.style });
          }
          from = end;
        }
      }
    }
  }

  node.characters = plain;
  await applyStyle(node, 0, plain.length, base);
  for (const r of ranges) await applyStyle(node, r.start, r.end, r.style);
  return ranges.length;
}

// ---------- Sections ----------

function findSection(name: string): SectionNode | null {
  for (const child of figma.currentPage.children) {
    if (child.type === 'SECTION' && child.name === name) return child;
  }
  return null;
}

function createSection(name: string, x: number, y: number): SectionNode {
  const section = figma.createSection();
  section.name = name;
  section.x = x;
  section.y = y;
  return section;
}

/** Move a node into a section without changing where it appears on the canvas. */
function moveIntoSection(section: SectionNode, node: SceneNode): void {
  const abs = absolutePosition(node);
  const s = absolutePosition(section);
  section.appendChild(node);
  node.x = abs.x - s.x;
  node.y = abs.y - s.y;
}

/** Grow/shrink a section around its children, keeping them in place on the canvas. */
function fitSection(section: SectionNode): void {
  const kids = section.children;
  if (kids.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const k of kids) {
    minX = Math.min(minX, k.x);
    minY = Math.min(minY, k.y);
    maxX = Math.max(maxX, k.x + k.width);
    maxY = Math.max(maxY, k.y + k.height);
  }
  const dx = SECTION_PADDING - minX;
  const dy = SECTION_PADDING - minY;
  if (dx !== 0 || dy !== 0) {
    for (const k of kids) {
      k.x += dx;
      k.y += dy;
    }
    section.x -= dx;
    section.y -= dy;
  }
  section.resizeWithoutConstraints(maxX - minX + SECTION_PADDING * 2, maxY - minY + SECTION_PADDING * 2);
}

function sectionContentBottom(section: SectionNode): number {
  let bottom = 0;
  for (const k of section.children) bottom = Math.max(bottom, k.y + k.height);
  return bottom;
}

// ---------- Generate ----------

async function generate(msg: GenerateMessage): Promise<void> {
  const sources = figma.currentPage.selection.filter((n) => n.type !== 'SECTION');
  if (sources.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Select one or more frames (not sections) in Figma first.' });
    return;
  }
  if (msg.languageColumns.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Choose at least one language.' });
    return;
  }
  if (msg.keyColumn < 0 && msg.sourceColumn < 0) {
    figma.ui.postMessage({ type: 'error', message: 'Enable layer-name or text matching.' });
    return;
  }

  const byKey = buildLookup(msg.rows, msg.keyColumn);
  const byText = buildLookup(msg.rows, msg.sourceColumn);
  const languages = msg.languageColumns.map((col) => ({
    col,
    name: safeName(msg.headers[col] ?? '', col),
  }));

  // Bounding box of the selection; copies mirror this layout.
  let minX = Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of sources) {
    const p = absolutePosition(n);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y + n.height);
  }
  const selectionHeight = maxY - minY;

  // New sections stack below the originals and any language sections being reused.
  let cursorY = Math.max(...sources.map((n) => bottomOf(topLevel(n)))) + msg.gap;
  if (msg.useSections) {
    for (const lang of languages) {
      const existing = findSection(lang.name);
      if (existing) cursorY = Math.max(cursorY, bottomOf(existing) + msg.gap);
    }
  }

  const reports: LanguageReport[] = [];
  const unmatched = new Set<string>();
  const missingFonts = new Set<string>();
  const created: SceneNode[] = [];
  const total = sources.length * languages.length;
  let done = 0;

  for (let li = 0; li < languages.length; li++) {
    const { col, name: language } = languages[li];
    const report: LanguageReport = { language, replaced: 0, styledRuns: 0, emptyTranslation: 0 };

    let section: SectionNode | null = null;
    let offsetY = 0; // where new frames go inside a reused section
    if (msg.useSections) {
      section = findSection(language);
      if (section) {
        offsetY = sectionContentBottom(section) + msg.gap - SECTION_PADDING;
      } else {
        section = createSection(language, minX - SECTION_PADDING, cursorY);
        cursorY += selectionHeight + SECTION_PADDING * 2 + msg.gap;
      }
    }

    for (const source of sources) {
      const pos = absolutePosition(source);
      const clone = source.clone();
      clone.name = `${source.name} / ${language}`;

      if (section) {
        const previous = section.children.find((c) => c.name === clone.name);
        section.appendChild(clone);
        if (previous) {
          // Re-run: replace the earlier version in place.
          clone.x = previous.x;
          clone.y = previous.y;
          previous.remove();
        } else {
          clone.x = SECTION_PADDING + (pos.x - minX);
          clone.y = SECTION_PADDING + offsetY + (pos.y - minY);
        }
      } else {
        figma.currentPage.appendChild(clone);
        clone.x = pos.x;
        clone.y = pos.y + (selectionHeight + msg.gap) * (li + 1);
      }
      created.push(clone);

      for (const textNode of textNodesIn(clone)) {
        const row =
          byKey.get(normalize(textNode.name)) ?? byText.get(normalize(textNode.characters));
        if (!row) {
          if (textNode.characters.trim()) unmatched.add(textNode.characters.trim().slice(0, 60));
          continue;
        }
        const translation = (row[col] ?? '').trim();
        if (!translation) {
          report.emptyTranslation++;
          continue;
        }
        if (textNode.hasMissingFont) {
          missingFonts.add(textNode.name);
          continue;
        }
        try {
          report.styledRuns += await localizeText(textNode, translation);
          report.replaced++;
        } catch (_err) {
          missingFonts.add(textNode.name);
        }
      }

      done++;
      figma.ui.postMessage({ type: 'progress', done, total });
    }

    if (section) fitSection(section);
    reports.push(report);
  }

  figma.currentPage.selection = created;
  figma.viewport.scrollAndZoomIntoView([...sources, ...created]);
  figma.notify(`Created ${created.length} localised frame${created.length === 1 ? '' : 's'}`);
  figma.ui.postMessage({
    type: 'done',
    report: {
      frames: sources.length,
      languages: reports,
      unmatched: Array.from(unmatched).slice(0, 30),
      missingFonts: Array.from(missingFonts).slice(0, 30),
    },
  });
}

// ---------- Organize existing localised frames into sections ----------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SEP = String.raw`[\s/_\-–—|()[\].,:]`;

/** Find the language in a frame name like "Banner / fr", "Banner_FR" or "Banner (French)". */
function detectLanguage(name: string, languages: string[]): string | null {
  let best: { lang: string; index: number } | null = null;
  const sorted = [...languages].filter((l) => l.trim()).sort((a, b) => b.length - a.length);
  for (const lang of sorted) {
    const re = new RegExp(`(?:^|${SEP})(${escapeRegExp(lang.trim())})(?=$|${SEP})`, 'gi');
    for (const m of name.matchAll(re)) {
      const index = (m.index ?? 0) + m[0].length;
      if (!best || index > best.index) best = { lang: lang.trim(), index };
    }
  }
  if (best) return best.lang;
  // No sheet loaded (or no match): use the part after the last " / ".
  const slash = name.lastIndexOf('/');
  if (slash !== -1) {
    const tail = name.slice(slash + 1).trim();
    if (tail && tail.length <= 20) return tail;
  }
  return null;
}

function organize(msg: OrganizeMessage): void {
  const nodes = figma.currentPage.selection.filter((n) => n.type !== 'SECTION');
  if (nodes.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Select the localised frames you want to organise.' });
    return;
  }

  const groups = new Map<string, SceneNode[]>();
  const skipped: string[] = [];
  for (const node of nodes) {
    const lang = detectLanguage(node.name, msg.languages);
    if (!lang) {
      skipped.push(node.name);
      continue;
    }
    const list = groups.get(lang) ?? [];
    list.push(node);
    groups.set(lang, list);
  }

  const sections: SectionNode[] = [];
  const counts: { language: string; frames: number }[] = [];
  for (const [lang, list] of groups) {
    let section = findSection(lang);
    if (!section) {
      let minX = Infinity;
      let minY = Infinity;
      for (const n of list) {
        const p = absolutePosition(n);
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
      }
      section = createSection(lang, minX - SECTION_PADDING, minY - SECTION_PADDING);
    }
    for (const n of list) {
      if (n.parent !== section) moveIntoSection(section, n);
    }
    fitSection(section);
    sections.push(section);
    counts.push({ language: lang, frames: list.length });
  }

  if (sections.length) {
    figma.currentPage.selection = sections;
    figma.viewport.scrollAndZoomIntoView(sections);
  }
  figma.notify(`Organised ${nodes.length - skipped.length} frame(s) into ${sections.length} section(s)`);
  figma.ui.postMessage({ type: 'organized', counts, skipped: skipped.slice(0, 30) });
}

// ---------- Wiring ----------

figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    if (msg.type === 'cancel') figma.closePlugin();
    else if (msg.type === 'generate') await generate(msg);
    else if (msg.type === 'organize') organize(msg);
  } catch (err) {
    figma.ui.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

figma.on('selectionchange', postSelection);
postSelection();
