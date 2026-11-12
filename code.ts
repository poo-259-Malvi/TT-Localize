// TT-Localize
// Duplicates the selected frames once per language and replaces the copy in
// their text layers with the translations from an uploaded CSV / Excel sheet.
//
// A text layer is matched to a sheet row by:
//   1. Layer name  -> value in the "key" column       (e.g. layer "headline")
//   2. Text content -> value in the "source text" column (e.g. "Buy now")

figma.showUI(__html__, { width: 400, height: 620, themeColors: true });

// ---------- Message types ----------

interface GenerateMessage {
  type: 'generate';
  headers: string[];
  rows: string[][];
  keyColumn: number; // -1 = don't match by layer name
  sourceColumn: number; // -1 = don't match by text content
  languageColumns: number[];
  gap: number;
}

type UIMessage = GenerateMessage | { type: 'cancel' };

interface LanguageReport {
  language: string;
  replaced: number;
  emptyTranslation: number;
}

interface Report {
  frames: number;
  languages: LanguageReport[];
  unmatched: string[];
  missingFonts: string[];
}

// ---------- Helpers ----------

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
    const k = normalize(row[column] ?? '');
    if (k && !map.has(k)) map.set(k, row);
  }
  return map;
}

function textNodesIn(node: SceneNode): TextNode[] {
  if (node.type === 'TEXT') return [node];
  if ('findAllWithCriteria' in node) return node.findAllWithCriteria({ types: ['TEXT'] });
  return [];
}

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

function absolutePosition(node: SceneNode): { x: number; y: number } {
  const t = node.absoluteTransform;
  return { x: t[0][2], y: t[1][2] };
}

function safeName(header: string, index: number): string {
  return header.trim() || `Column ${index + 1}`;
}

// ---------- Main ----------

async function generate(msg: GenerateMessage): Promise<void> {
  const sources = figma.currentPage.selection.slice();
  if (sources.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Select one or more frames in Figma first.' });
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

  // Bounding box of the whole selection, so each language becomes a new
  // "row" below the originals that mirrors their layout.
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of sources) {
    const { y } = absolutePosition(n);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + n.height);
  }
  const rowHeight = maxY - minY + msg.gap;

  const report: Report = { frames: sources.length, languages: [], unmatched: [], missingFonts: [] };
  const unmatched = new Set<string>();
  const missingFonts = new Set<string>();
  const created: SceneNode[] = [];
  const total = sources.length * msg.languageColumns.length;
  let done = 0;

  for (let li = 0; li < msg.languageColumns.length; li++) {
    const col = msg.languageColumns[li];
    const language = safeName(msg.headers[col] ?? '', col);
    const langReport: LanguageReport = { language, replaced: 0, emptyTranslation: 0 };

    for (const source of sources) {
      const pos = absolutePosition(source);
      const clone = source.clone();
      figma.currentPage.appendChild(clone);
      clone.x = pos.x;
      clone.y = pos.y + rowHeight * (li + 1);
      clone.name = `${source.name} / ${language}`;
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
          langReport.emptyTranslation++;
          continue;
        }
        if (textNode.hasMissingFont) {
          missingFonts.add(textNode.name);
          continue;
        }
        try {
          await loadFontsFor(textNode);
          textNode.characters = translation;
          langReport.replaced++;
        } catch (_err) {
          missingFonts.add(textNode.name);
        }
      }

      done++;
      figma.ui.postMessage({ type: 'progress', done, total });
    }
    report.languages.push(langReport);
  }

  report.unmatched = Array.from(unmatched).slice(0, 30);
  report.missingFonts = Array.from(missingFonts).slice(0, 30);

  figma.currentPage.selection = created;
  figma.viewport.scrollAndZoomIntoView([...sources, ...created]);
  figma.notify(`Created ${created.length} localised frame${created.length === 1 ? '' : 's'}`);
  figma.ui.postMessage({ type: 'done', report });
}

figma.ui.onmessage = async (msg: UIMessage) => {
  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }
  if (msg.type === 'generate') {
    try {
      await generate(msg);
    } catch (err) {
      figma.ui.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

figma.on('selectionchange', postSelection);
postSelection();
