# markdown-render-speed-02-entry

A dependency-free Markdown parser that renders Markdown to HTML byte-for-byte identical to [marked](https://github.com/markedjs/marked) 18.1.3 with default GFM settings.

## What it does

`parse.js` implements a complete Markdown parser (block and inline) in a single file with zero dependencies. Its output matches marked 18.1.3 exactly on the practice set (720 cases), and it runs faster than marked (~0.90x the time).

## Usage

```bash
MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=<output-dir> node main.ts
```

`main.ts` reads `<input-dir>/cases.json` (an array of objects with a `markdown` field), renders each case with `parse()` from `parse.js`, and writes `<output-dir>/html.json` — a JSON array of HTML strings, one per case, in the same order.

No build step and no install: just Node.js (22+).

## Files

- `parse.js` — the Markdown parser. Exports `parse(markdown)`.
- `main.ts` — the driver: reads cases, renders them, writes `html.json`.
- `package.json` — declares the package as an ES module.
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
