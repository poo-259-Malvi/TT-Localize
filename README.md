# TT-Localize
Create localized frames in Figma using csv files

Select one or more frames in Figma, upload a CSV or Excel copy sheet, and the plugin
duplicates each frame once per language with the copy replaced by its translation.

## Copy sheet format

The first row is the header: one key column, one source-language column, then one
column per language. See [sample-copy.csv](sample-copy.csv).

```
key,en,fr,de,es
headline,Summer sale is here,Les soldes d'été sont là,Der Sommerschlussverkauf ist da,Las rebajas de verano ya están aquí
cta,Shop now,Acheter,Jetzt kaufen,Comprar ahora
```

Text layers are matched to rows by:
1. **Layer name** → key column (a text layer named `headline` uses the `headline` row)
2. **Current text** → source column (a layer reading "Shop now" uses the `cta` row)

Matching ignores case and extra whitespace. Unmatched text is left unchanged and listed in the report.

## Development

```bash
npm install
npm run build   # compiles code.ts -> code.js
npm run watch   # rebuild on save
npm run lint
```

In the Figma desktop app: **Plugins → Development → Import plugin from manifest…** and pick `manifest.json`.

Excel (.xlsx/.xls) files are parsed with SheetJS loaded from `cdn.sheetjs.com`, so they need an
internet connection; CSV files work offline.
