# FileFlow (Web)

A privacy-friendly file toolkit that runs **entirely in your browser** – no uploads, no server, no build step. Just HTML, CSS and vanilla JavaScript.

This is the web edition of FileFlow, originally built as a desktop app with **C# / .NET / Avalonia**.

## Features

**Image Tools**
- Batch convert many images at once (PNG, JPG, WEBP, BMP) and download everything as a ZIP
- Resize with aspect-ratio lock, quality control, side-by-side preview with zoom, size comparison

**PDF Tools**
- Merge PDFs (reorder with arrows)
- Extract pages – click page thumbnails or type `1,3-5`
- Split a PDF into single pages (ZIP)
- Protect with a password (AES-256, with print / copy / edit permissions)
- Remove a password

**Compression**
- Images: quality presets, optional max-dimension, auto-format, and "keep original if not smaller"
- PDFs: *Maximum compression* (re-renders pages as JPEG – 80–90 % smaller for scans) or *Keep text* (lossless optimisation)
- Batch support with total space saved

**Also:** drag & drop anywhere on the page, File Inspector (detects real file type from its signature), searchable history, light/dark theme.

## Run it

Extract the folder and open `index.html` in a browser. No installation needed. (Keep `index.html`, `style.css` and `script.js` in the same folder.)

Or host it free with **GitHub Pages**: repo *Settings → Pages → Deploy from branch → main / root*.

## Tech

- HTML5, CSS3 (CSS variables for theming), vanilla JavaScript (ES2020)
- Canvas API – image decoding, resizing, JPG/PNG/WEBP encoding (custom BMP encoder)
- [pdf-lib](https://pdf-lib.js.org/) – merge, extract, split, PDF building
- [PDF.js](https://mozilla.github.io/pdf.js/) – page thumbnails and page rendering for compression
- [qpdf (WebAssembly)](https://github.com/neslinesli93/qpdf-wasm) – AES-256 encryption, password removal, lossless optimisation
- [JSZip](https://stuk.github.io/jszip/) – ZIP downloads
- `localStorage` – conversion history

Libraries are loaded lazily from a CDN only when a feature needs them, so an internet connection is required for PDF features and ZIP downloads.

## Differences from the desktop version

| Feature | Desktop (C# / Avalonia) | Web |
|---|---|---|
| Image conversion | ImageSharp | Canvas API |
| PDF merge / extract / split | PDFsharp | pdf-lib |
| PDF protection | PDFsharp (RC4) | qpdf-wasm (AES-256) |
| PDF compression | Ghostscript | PDF.js + pdf-lib re-render, or qpdf lossless |
| History storage | SQLite | localStorage (output files downloadable during the session only) |
| Save location | Native file dialog | Browser download |

## Project structure

```
index.html   – layout and pages
style.css    – themes and styling
script.js    – all application logic
```
