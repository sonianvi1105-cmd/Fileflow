"use strict";

/* ============================================================
   FileFlow – browser version 2.0
   Ported from the C# / Avalonia desktop app.
   Everything runs locally in the browser; no file is uploaded.
   ============================================================ */

/* ------------------------------------------------------------
   1. Helpers
   ------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const tick = () => new Promise(r => setTimeout(r, 0));
let _uid = 0;
const nextId = () => ++_uid;

function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let size = Math.max(0, bytes), i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${Number(size.toFixed(2))} ${units[i]}`;
}

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const extOf = name => { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i + 1).toLowerCase() : ""; };
const baseName = name => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(0, i) : name; };

function fileKind(file) {
  const ext = extOf(file.name);
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "bmp", "gif"].includes(ext)) return "image";
  return "other";
}

function setStatus(el, msg, isError = false) {
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

function setProgress(el, value) {
  if (value == null) { el.hidden = true; return; }
  el.hidden = false;
  el.value = Math.max(0, Math.min(1, value));
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

function setDownload(anchor, blob, filename, label) {
  if (anchor._url) URL.revokeObjectURL(anchor._url);
  anchor._url = URL.createObjectURL(blob);
  anchor.href = anchor._url;
  anchor.download = filename;
  if (label) anchor.textContent = label;
  anchor.classList.remove("hidden");
}
function hideDownload(anchor) { anchor.classList.add("hidden"); }

function uniqueName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const b = baseName(name), e = extOf(name);
  let i = 1, n;
  do { n = `${b}-${i++}${e ? "." + e : ""}`; } while (used.has(n));
  used.add(n);
  return n;
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function pctText(before, after) {
  if (before <= 0) return "—";
  const saved = before - after;
  if (saved === 0) return "no change";
  return `${saved > 0 ? "−" : "+"}${Math.abs((saved * 100) / before).toFixed(1)}%`;
}

/* ------------------------------------------------------------
   2. Lazy-loaded libraries (only fetched when needed)
   ------------------------------------------------------------ */
const CDN = {
  pdflib:  "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
  jszip:   "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  pdfjs:   "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfjsWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  qpdfBase: "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.1/dist/"
};
const LIB_TEST = {
  pdflib: () => window.PDFLib,
  jszip: () => window.JSZip,
  pdfjs: () => window.pdfjsLib
};
const _scriptCache = new Map();

function loadScript(url) {
  if (_scriptCache.has(url)) return _scriptCache.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = () => {
      _scriptCache.delete(url);
      reject(new Error("Could not load a required library. Check your internet connection and try again."));
    };
    document.head.appendChild(s);
  });
  _scriptCache.set(url, p);
  return p;
}

async function lib(name) {
  if (LIB_TEST[name]()) return;
  await loadScript(CDN[name]);
  if (!LIB_TEST[name]()) throw new Error(`Library "${name}" failed to initialise.`);
  if (name === "pdfjs") {
    // Load the worker through a Blob so it also works from file:// pages
    try {
      const code = await (await fetch(CDN.pdfjsWorker)).text();
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    } catch {
      pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;
    }
  }
}

async function makeZip(entries) {
  await lib("jszip");
  const zip = new JSZip();
  entries.forEach(e => zip.file(e.name, e.blob));
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

/** Runs qpdf (WebAssembly). Each call uses a fresh instance so a failure can't poison the next run. */
async function runQpdf(args, inputs, outName) {
  await loadScript(CDN.qpdfBase + "qpdf.js");
  const log = [];
  const q = await window.Module({
    locateFile: f => CDN.qpdfBase + f,
    print: l => log.push(l),
    printErr: l => log.push(l)
  });
  for (const [name, bytes] of Object.entries(inputs)) q.FS.writeFile("/" + name, bytes);
  let rc;
  try { rc = q.callMain(args); }
  catch (e) {
    rc = e && typeof e.status === "number" ? e.status : 2;
    log.push(String((e && e.message) || e));
  }
  let out = null;
  try { out = q.FS.readFile("/" + outName); } catch { /* not produced */ }
  return { rc, out, log: log.join("\n").trim() };
}

/* ------------------------------------------------------------
   3. History (replaces the SQLite ConversionHistoryService)
   ------------------------------------------------------------ */
const History = {
  KEY: "fileflow-history",
  outputs: new Map(), // id -> {blob, name}; kept only for this session

  all() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); }
    catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(this.KEY, JSON.stringify(list.slice(-500))); } catch { /* storage full/blocked */ }
  },
  add(record, blob) {
    const list = this.all();
    record.id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    record.completedAt = new Date().toISOString();
    record.status = "Completed";
    list.push(record);
    this.save(list);
    if (blob) this.outputs.set(record.id, { blob, name: record.outputFileName });
    return record;
  },
  query(search = "", type = "All") {
    const q = search.trim().toLowerCase();
    return this.all()
      .filter(r =>
        (!q || r.originalFileName.toLowerCase().includes(q) ||
               r.outputFileName.toLowerCase().includes(q) ||
               r.operation.toLowerCase().includes(q)) &&
        (type === "All" || r.fileType === type))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id - a.id);
  },
  remove(id) { this.save(this.all().filter(r => r.id !== id)); this.outputs.delete(id); },
  clear() { this.save([]); this.outputs.clear(); }
};

/* ------------------------------------------------------------
   4. Navigation, theme, drag & drop
   ------------------------------------------------------------ */
const PAGES = {
  dashboard: ["Dashboard", "Welcome to your personal file workspace."],
  image:     ["Image Tools", "Batch convert, resize and optimize your images."],
  pdf:       ["PDF Tools", "Merge, extract, split, protect and unlock PDFs."],
  compress:  ["Compression", "Reduce image and PDF file sizes."],
  inspect:   ["File Inspector", "Detect the real format of your files."],
  history:   ["Conversion History", "Review your previous file operations."]
};
let currentPage = "dashboard";

function navigate(page) {
  currentPage = page;
  $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + page));
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  $("#pageTitle").textContent = PAGES[page][0];
  $("#pageSub").textContent = PAGES[page][1];
  if (page === "history") loadHistory();
  if (page === "dashboard") renderRecent();
  window.scrollTo(0, 0);
}
$$(".nav-btn").forEach(b => b.addEventListener("click", () => navigate(b.dataset.page)));
$$("[data-go]").forEach(b => b.addEventListener("click", () => navigate(b.dataset.go)));

$("#themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("fileflow-theme", next); } catch { /* ignore */ }
});

/** Wires a <label class="drop"> so it accepts both clicks and dropped files. */
function setupDrop(zone, input, handler) {
  input.addEventListener("change", () => {
    const files = [...input.files];
    input.value = "";               // lets the same file be picked again
    if (files.length) handler(files);
  });
  ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.add("over");
  }));
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove("over");
    $("#dropOverlay").classList.remove("show");
    const files = [...e.dataTransfer.files];
    if (files.length) handler(files);
  });
}

// Drop anywhere on the page -> send to the current tool
const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
let _dragDepth = 0;
window.addEventListener("dragenter", e => { if (hasFiles(e)) { _dragDepth++; $("#dropOverlay").classList.add("show"); } });
window.addEventListener("dragleave", e => { if (hasFiles(e) && --_dragDepth <= 0) { _dragDepth = 0; $("#dropOverlay").classList.remove("show"); } });
window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth = 0;
  $("#dropOverlay").classList.remove("show");
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (currentPage === "dashboard" || currentPage === "history") {
    const kinds = files.map(fileKind);
    navigate(kinds.includes("image") ? "image" : kinds.includes("pdf") ? "pdf" : "inspect");
  }
  ({ image: imgAdd, pdf: pdfAdd, compress: cAdd, inspect: inspectFiles }[currentPage])(files);
});

/* ------------------------------------------------------------
   5. Image engine (replaces ImageSharp, using the Canvas API)
   ------------------------------------------------------------ */
const EXT = { PNG: "png", JPG: "jpg", WEBP: "webp", BMP: "bmp" };
const MIME = { PNG: "image/png", JPG: "image/jpeg", WEBP: "image/webp" };

function loadBitmap(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`"${file.name}" is not a readable image.`)); };
    img.src = url;
  });
}

function encodeBMP(imageData) {
  const { width: w, height: h, data } = imageData;
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint8(0, 0x42); v.setUint8(1, 0x4D);
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, row * h, true);
  v.setInt32(38, 2835, true);
  v.setInt32(42, 2835, true);
  const px = new Uint8Array(buf);
  for (let y = 0; y < h; y++) {
    const o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[o + x * 3] = data[i + 2];
      px[o + x * 3 + 1] = data[i + 1];
      px[o + x * 3 + 2] = data[i];
    }
  }
  return new Blob([buf], { type: "image/bmp" });
}

async function renderImage(img, { format, quality = 90, width = 0, height = 0, keepAspect = true, maxDim = 0 }) {
  let tw = img.naturalWidth, th = img.naturalHeight;
  if (width > 0 && height > 0) {
    if (keepAspect) {
      const s = Math.min(width / tw, height / th);
      tw = Math.max(1, Math.round(tw * s));
      th = Math.max(1, Math.round(th * s));
    } else { tw = width; th = height; }
  }
  if (maxDim > 0 && Math.max(tw, th) > maxDim) {
    const s = maxDim / Math.max(tw, th);
    tw = Math.max(1, Math.round(tw * s));
    th = Math.max(1, Math.round(th * s));
  }
  const canvas = document.createElement("canvas");
  canvas.width = tw; canvas.height = th;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  if (format === "JPG" || format === "BMP") {        // these formats have no transparency
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, tw, th);
  }
  ctx.drawImage(img, 0, 0, tw, th);

  if (format === "BMP") return { blob: encodeBMP(ctx.getImageData(0, 0, tw, th)), width: tw, height: th };

  const mime = MIME[format];
  if (!mime) throw new Error(`Format '${format}' is not supported.`);
  const blob = await new Promise(res => canvas.toBlob(res, mime, quality / 100));
  if (!blob || blob.type !== mime) throw new Error(`Your browser can't encode ${format}.`);
  return { blob, width: tw, height: th };
}

/* ------------------------------------------------------------
   6. Shared file-row renderer
   ------------------------------------------------------------ */
function renderItems(container, items, { onSelect, onRemove, selectedId, extra } = {}) {
  container.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "item" + (onSelect ? " clickable" : "") + (it.id === selectedId ? " selected" : "");
    const thumb = it.thumbUrl
      ? `<img class="item-thumb" src="${it.thumbUrl}" alt="">`
      : `<div class="item-thumb pdf">PDF</div>`;
    const meta = [it.w ? `${it.w} × ${it.h}` : null, formatSize(it.file.size)].filter(Boolean).join(" • ");
    row.innerHTML =
      `${thumb}<div class="item-main"><div class="item-name" title="${esc(it.file.name)}">${esc(it.file.name)}</div>` +
      `<div class="item-meta">${esc(meta)}</div></div>` +
      `<div class="item-status ${it.statusClass || ""}">${esc(it.status || "")}</div>`;
    if (extra) extra(row, it);
    const rm = document.createElement("button");
    rm.className = "icon-btn"; rm.title = "Remove"; rm.setAttribute("aria-label", "Remove " + it.file.name);
    rm.textContent = "✕";
    rm.addEventListener("click", e => { e.stopPropagation(); onRemove && onRemove(it); });
    row.appendChild(rm);
    if (onSelect) row.addEventListener("click", () => onSelect(it));
    container.appendChild(row);
  }
}

function revokeItem(it) {
  if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
  if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
}

async function loadImageItems(files, statusEl) {
  const items = [], failed = [];
  for (const f of files) {
    if (fileKind(f) !== "image") { failed.push(f.name); continue; }
    try {
      const im = await loadBitmap(f);
      items.push({ id: nextId(), file: f, img: im, w: im.naturalWidth, h: im.naturalHeight,
                   thumbUrl: URL.createObjectURL(f), status: "Ready" });
    } catch { failed.push(f.name); }
  }
  if (failed.length) setStatus(statusEl, `Skipped (not a readable image): ${failed.join(", ")}`, true);
  return items;
}

/* ============================================================
   7. IMAGE TOOLS
   ============================================================ */
const img = { items: [], selId: null, autoDims: true };

$("#imgQ").addEventListener("input", e => { $("#imgQLabel").textContent = e.target.value; });
$("#imgZoom").addEventListener("input", e => {
  const w = 180 * Number(e.target.value) + "px";
  $("#imgOrig").style.width = w; $("#imgConv").style.width = w;
});

async function imgAdd(files) {
  const status = $("#imgStatus");
  const added = await loadImageItems(files, status);
  if (!added.length) {
    if (!status.classList.contains("error")) setStatus(status, "Please choose image files.", true);
    return;
  }
  img.items.push(...added);

  if (img.items.length === 1) {
    $("#imgW").value = img.items[0].w; $("#imgH").value = img.items[0].h; img.autoDims = true;
  } else if (img.autoDims) {                      // untouched prefill makes no sense for a batch
    $("#imgW").value = ""; $("#imgH").value = "";
  }
  if (!img.selId) img.selId = img.items[0].id;
  imgRender();
  imgPreview();
  hideDownload($("#imgDownload"));
  setStatus(status, `${img.items.length} image(s) ready. Choose a format and click Convert.`);
}

function imgRender() {
  renderItems($("#imgList"), img.items, {
    selectedId: img.selId,
    onSelect: it => { img.selId = it.id; imgRender(); imgPreview(); },
    onRemove: it => {
      revokeItem(it);
      img.items = img.items.filter(x => x.id !== it.id);
      if (img.selId === it.id) img.selId = img.items[0]?.id ?? null;
      imgRender(); imgPreview(); hideDownload($("#imgDownload"));
    }
  });
  $("#imgListActions").style.display = img.items.length ? "flex" : "none";
}

function imgPreview() {
  const it = img.items.find(x => x.id === img.selId);
  const o = $("#imgOrig"), c = $("#imgConv");
  if (!it) {
    o.removeAttribute("src"); o.style.display = "none"; c.removeAttribute("src"); c.style.display = "none";
    $("#imgOrigInfo").textContent = "No image selected";
    $("#imgConvInfo").textContent = "Not converted yet";
    $("#imgCompare").innerHTML = "Original: —&nbsp;&nbsp; Converted: —<br>Space saved: —&nbsp;&nbsp; Reduction: —";
    return;
  }
  o.src = it.thumbUrl; o.style.display = "block";
  $("#imgOrigInfo").textContent = `${it.file.name}\n${it.w} × ${it.h} • ${formatSize(it.file.size)}`;
  if (it.result) {
    c.src = it.resultUrl; c.style.display = "block";
    $("#imgConvInfo").textContent = `${it.result.name}\n${it.result.width} × ${it.result.height} • ${formatSize(it.result.blob.size)}`;
    const before = it.file.size, after = it.result.blob.size, saved = before - after;
    $("#imgCompare").innerHTML =
      `Original: ${formatSize(before)}&nbsp;&nbsp; Converted: ${formatSize(after)}<br>` +
      `Space saved: ${saved >= 0 ? formatSize(saved) : formatSize(-saved) + " larger"}&nbsp;&nbsp; Reduction: ${pctText(before, after)}`;
  } else {
    c.removeAttribute("src"); c.style.display = "none";
    $("#imgConvInfo").textContent = "Not converted yet";
    $("#imgCompare").innerHTML = "Original: —&nbsp;&nbsp; Converted: —<br>Space saved: —&nbsp;&nbsp; Reduction: —";
  }
}

$("#imgClear").addEventListener("click", () => {
  img.items.forEach(revokeItem); img.items = []; img.selId = null;
  $("#imgW").value = ""; $("#imgH").value = "";
  imgRender(); imgPreview(); hideDownload($("#imgDownload"));
  setStatus($("#imgStatus"), "Add one or more images to begin.");
});

// Typing a dimension: remember it was edited, and keep the ratio for a single image
["#imgW", "#imgH"].forEach(sel => $(sel).addEventListener("input", e => {
  img.autoDims = false;
  if (img.items.length === 1 && $("#imgAspect").checked) {
    const it = img.items[0], v = parseInt(e.target.value, 10);
    if (v > 0) {
      if (sel === "#imgW") $("#imgH").value = Math.max(1, Math.round(v * it.h / it.w));
      else $("#imgW").value = Math.max(1, Math.round(v * it.w / it.h));
    }
  }
}));

$("#imgConvert").addEventListener("click", async () => {
  const status = $("#imgStatus"), prog = $("#imgProg"), btn = $("#imgConvert");
  if (!img.items.length) return setStatus(status, "Please add at least one image.", true);

  const wRaw = $("#imgW").value.trim(), hRaw = $("#imgH").value.trim();
  const w = wRaw === "" ? 0 : parseInt(wRaw, 10), h = hRaw === "" ? 0 : parseInt(hRaw, 10);
  if (Number.isNaN(w) || Number.isNaN(h) || w < 0 || h < 0 || w > 20000 || h > 20000)
    return setStatus(status, "Width and height must be between 1 and 20000 pixels.", true);
  if ((w === 0) !== (h === 0))
    return setStatus(status, "Enter both width and height, or leave both empty.", true);

  const format = $("#imgFormat").value, quality = Number($("#imgQ").value), keepAspect = $("#imgAspect").checked;
  btn.disabled = true; hideDownload($("#imgDownload"));
  const used = new Set(), entries = [];
  let done = 0, failed = 0;

  for (const it of img.items) {
    it.status = "Converting…"; it.statusClass = ""; imgRender();
    setStatus(status, `Converting ${done + 1} of ${img.items.length}…`);
    setProgress(prog, done / img.items.length);
    await tick();
    try {
      if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
      const r = await renderImage(it.img, { format, quality, width: w, height: h, keepAspect });
      const name = uniqueName(`${baseName(it.file.name)}_converted.${EXT[format]}`, used);
      it.result = { ...r, name };
      it.resultUrl = URL.createObjectURL(r.blob);
      it.status = `✓ ${formatSize(it.file.size)} → ${formatSize(r.blob.size)} (${pctText(it.file.size, r.blob.size)})`;
      it.statusClass = "ok";
      entries.push({ name, blob: r.blob });
      History.add({
        originalFileName: it.file.name, outputFileName: name, fileType: "Image",
        operation: "Image Conversion", originalSize: it.file.size, outputSize: r.blob.size
      }, r.blob);
    } catch (err) {
      failed++; it.result = null; it.status = "Failed: " + err.message; it.statusClass = "err";
    }
    done++;
  }
  setProgress(prog, null);
  imgRender(); imgPreview();
  btn.disabled = false;

  if (!entries.length) return setStatus(status, "Conversion failed for every image.", true);
  if (entries.length === 1) {
    setDownload($("#imgDownload"), entries[0].blob, entries[0].name, "Download Result");
  } else {
    try {
      setDownload($("#imgDownload"), await makeZip(entries), "fileflow-images.zip", `Download ZIP (${entries.length} files)`);
    } catch (err) { setStatus(status, "Converted, but ZIP creation failed: " + err.message, true); return; }
  }
  setStatus(status, `Converted ${entries.length} image(s)` + (failed ? `, ${failed} failed` : "") + ". Saved to Conversion History.", failed > 0);
  toast("Conversion complete");
});

/* ============================================================
   8. COMPRESSION
   ============================================================ */
const comp = { items: [], mode: "Image" };

const PRESETS = {
  light:    { q: 85, max: "" },
  balanced: { q: 70, max: 2560 },
  strong:   { q: 50, max: 1600 }
};
$$("#cImageOpts .chip").forEach(chip => chip.addEventListener("click", () => {
  const p = PRESETS[chip.dataset.preset];
  $("#cQ").value = p.q; $("#cQLabel").textContent = p.q; $("#cMax").value = p.max;
  $$("#cImageOpts .chip").forEach(c => c.classList.toggle("active", c === chip));
}));
$("#cQ").addEventListener("input", e => {
  $("#cQLabel").textContent = e.target.value;
  $$("#cImageOpts .chip").forEach(c => c.classList.remove("active"));
});

$("#cPdfMethod").addEventListener("change", () => {
  $("#cLevelWrap").classList.toggle("hidden", $("#cPdfMethod").value !== "raster");
});

function cReset() {
  comp.items.forEach(revokeItem); comp.items = [];
  cRender(); hideDownload($("#cDownload"));
  $("#cStats").textContent = "—";
  setStatus($("#cStatus"), "Choose files to begin.");
}

$("#cMode").addEventListener("change", () => {
  comp.mode = $("#cMode").value;
  const isImg = comp.mode === "Image";
  $("#cImageOpts").classList.toggle("hidden", !isImg);
  $("#cPdfOpts").classList.toggle("hidden", isImg);
  $("#cInput").accept = isImg ? "image/png,image/jpeg,image/webp,image/bmp" : "application/pdf,.pdf";
  $("#cDropTitle").textContent = isImg ? "Drop images here" : "Drop PDF files here";
  cReset();
});

async function cAdd(files) {
  const status = $("#cStatus");
  hideDownload($("#cDownload"));
  if (comp.mode === "Image") {
    const added = await loadImageItems(files, status);
    if (!added.length) { if (!status.classList.contains("error")) setStatus(status, "Please choose image files.", true); return; }
    comp.items.push(...added);
  } else {
    const pdfs = files.filter(f => fileKind(f) === "pdf");
    if (!pdfs.length) return setStatus(status, "Please choose PDF files.", true);
    pdfs.forEach(f => comp.items.push({ id: nextId(), file: f, status: "Ready" }));
  }
  cRender();
  setStatus(status, `${comp.items.length} file(s) selected. Click Compress Files.`);
}

function cRender() {
  renderItems($("#cList"), comp.items, {
    onRemove: it => { revokeItem(it); comp.items = comp.items.filter(x => x.id !== it.id); cRender(); }
  });
  $("#cListActions").style.display = comp.items.length ? "flex" : "none";
}
$("#cClear").addEventListener("click", cReset);

const PDF_LEVELS = { Low: { dpi: 150, q: 0.8 }, Medium: { dpi: 110, q: 0.65 }, High: { dpi: 72, q: 0.5 } };

async function compressPdfRaster(file, level, onProgress) {
  await lib("pdfjs"); await lib("pdflib");
  const { dpi, q } = PDF_LEVELS[level];
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = await PDFLib.PDFDocument.create();
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(dpi / 72, 4000 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise(r => c.toBlob(r, "image/jpeg", q));
      const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const p = out.addPage([base.width, base.height]);
      p.drawImage(jpg, { x: 0, y: 0, width: base.width, height: base.height });
      page.cleanup(); c.width = c.height = 0;
      onProgress(i / doc.numPages);
      await tick();
    }
  } finally { doc.destroy(); }
  return new Blob([await out.save()], { type: "application/pdf" });
}

async function compressPdfLossless(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const r = await runQpdf(
      ["--object-streams=generate", "--compress-streams=y", "--recompress-flate", "--compression-level=9",
       "/in.pdf", "/out.pdf"], { "in.pdf": bytes }, "out.pdf");
    if (r.out && (r.rc === 0 || r.rc === 3)) return new Blob([r.out], { type: "application/pdf" });
    if (/password|encrypt/i.test(r.log)) throw new Error("This PDF is password-protected. Remove the password first.");
  } catch (e) {
    if (/password-protected/.test(e.message)) throw e;
    /* otherwise fall back to pdf-lib below */
  }
  await lib("pdflib");
  const doc = await PDFLib.PDFDocument.load(bytes.slice());
  return new Blob([await doc.save({ useObjectStreams: true })], { type: "application/pdf" });
}

$("#cRun").addEventListener("click", async () => {
  const status = $("#cStatus"), prog = $("#cProg"), btn = $("#cRun");
  if (!comp.items.length) return setStatus(status, "Please choose a file first.", true);

  const isImg = comp.mode === "Image", keep = $("#cKeep").checked;
  const quality = Number($("#cQ").value);
  const maxDim = parseInt($("#cMax").value, 10) || 0;
  const fmtChoice = $("#cFormat").value;
  const method = $("#cPdfMethod").value, level = $("#cPdfLevel").value;

  btn.disabled = true; hideDownload($("#cDownload")); $("#cStats").textContent = "";
  const used = new Set(), entries = [];
  let totalBefore = 0, totalAfter = 0, failed = 0, n = 0;

  for (const it of comp.items) {
    n++;
    it.status = "Compressing…"; it.statusClass = ""; cRender();
    setStatus(status, `Compressing ${n} of ${comp.items.length}…`);
    setProgress(prog, (n - 1) / comp.items.length);
    await tick();
    try {
      let blob, name, note = "";
      if (isImg) {
        const srcExt = extOf(it.file.name);
        const fmt = fmtChoice !== "AUTO" ? fmtChoice
          : (srcExt === "png" ? "PNG" : srcExt === "webp" ? "WEBP" : "JPG");
        ({ blob } = await renderImage(it.img, { format: fmt, quality, maxDim, keepAspect: true }));
        name = `${baseName(it.file.name)}_compressed.${EXT[fmt]}`;
        if (fmt === "PNG" && blob.size >= it.file.size * 0.97 && !maxDim)
          note = " (PNG is lossless – try JPG/WEBP or a size limit)";
      } else {
        const base = (n - 1) / comp.items.length, span = 1 / comp.items.length;
        blob = method === "raster"
          ? await compressPdfRaster(it.file, level, p => setProgress(prog, base + p * span))
          : await compressPdfLossless(it.file);
        name = `${baseName(it.file.name)}_compressed.pdf`;
        if (method === "lossless" && blob.size >= it.file.size * 0.97) note = " (already well optimised)";
      }
      if (keep && blob.size >= it.file.size) {
        blob = it.file;
        name = `${baseName(it.file.name)}_compressed.${extOf(it.file.name)}`;
        note = " – original kept (couldn't get smaller)";
      }
      name = uniqueName(name, used);
      const before = it.file.size, after = blob.size;
      totalBefore += before; totalAfter += after;
      it.status = `✓ ${formatSize(before)} → ${formatSize(after)} (${pctText(before, after)})${note}`;
      it.statusClass = after < before ? "ok" : "warn";
      entries.push({ name, blob });
      History.add({
        originalFileName: it.file.name, outputFileName: name, fileType: isImg ? "Image" : "PDF",
        operation: isImg ? "Image Compression" : "PDF Compression", originalSize: before, outputSize: after
      }, blob);
    } catch (err) {
      failed++; it.status = "Failed: " + friendlyPdfError(err); it.statusClass = "err";
    }
  }
  setProgress(prog, null);
  cRender();
  btn.disabled = false;

  if (!entries.length) return setStatus(status, "Compression failed for every file.", true);

  const saved = Math.max(0, totalBefore - totalAfter);
  $("#cStats").innerHTML =
    `Original size: ${formatSize(totalBefore)}<br>Compressed size: ${formatSize(totalAfter)}<br>` +
    (saved > 0
      ? `<b>Space saved: ${formatSize(saved)} (${((saved / totalBefore) * 100).toFixed(1)}%)</b>`
      : "File size did not change.") +
    `<br>Files processed: ${entries.length}`;

  try {
    if (entries.length === 1) setDownload($("#cDownload"), entries[0].blob, entries[0].name, "Download Result");
    else setDownload($("#cDownload"), await makeZip(entries), "fileflow-compressed.zip", `Download ZIP (${entries.length} files)`);
  } catch (err) { return setStatus(status, "Compressed, but ZIP creation failed: " + err.message, true); }

  setStatus(status, "Compression completed. Saved to Conversion History." + (failed ? `\n${failed} file(s) failed.` : ""), failed > 0);
  toast(saved > 0 ? `Saved ${formatSize(saved)}` : "Compression complete");
});

/* ============================================================
   9. PDF TOOLS
   ============================================================ */
const pdfS = { files: [], thumbRun: 0, sel: new Set(), pages: 0 };

const OPS = {
  merge:   { multi: true,  run: "Merge PDFs", drop: "Drop PDF files here", hint: "Add two or more PDFs, then reorder them with the arrows",
             status: "Select two or more PDF files to merge." },
  extract: { multi: false, run: "Extract Pages", drop: "Drop a PDF here", hint: "Then click the pages you want, or type them below",
             status: "Select a PDF, then pick the pages to extract.", thumbs: true },
  split:   { multi: false, run: "Split into Pages", drop: "Drop a PDF here", hint: "Every page becomes its own PDF, delivered as a ZIP",
             status: "Select a PDF to split into single pages.", thumbs: true },
  protect: { multi: false, run: "Protect PDF", drop: "Drop a PDF here", hint: "The PDF will need a password to open",
             status: "Choose a password for the PDF." },
  unlock:  { multi: false, run: "Remove Password", drop: "Drop a protected PDF here", hint: "You must know the current password",
             status: "Select a protected PDF and enter its password." }
};
const pdfOp = () => $("#pOp").value;

function updatePdfOperation() {
  const op = pdfOp(), o = OPS[op];
  $("#pInput").multiple = o.multi;
  $("#pDropTitle").textContent = o.drop;
  $("#pDropHint").textContent = o.hint;
  $("#pRun").textContent = o.run;
  $("#pExtractBox").classList.toggle("hidden", op !== "extract");
  $("#pProtectBox").classList.toggle("hidden", op !== "protect");
  $("#pUnlockBox").classList.toggle("hidden", op !== "unlock");
  if (!o.multi && pdfS.files.length > 1) pdfS.files = pdfS.files.slice(0, 1);
  hideDownload($("#pDownload"));
  setStatus($("#pStatus"), o.status);
  pdfRenderFiles();
  loadThumbs();
}
$("#pOp").addEventListener("change", updatePdfOperation);

function pdfAdd(files) {
  const status = $("#pStatus");
  const pdfs = files.filter(f => fileKind(f) === "pdf");
  if (!pdfs.length) return setStatus(status, "Please select a PDF file.", true);
  const o = OPS[pdfOp()];
  if (o.multi) pdfs.forEach(f => pdfS.files.push({ id: nextId(), file: f }));
  else pdfS.files = [{ id: nextId(), file: pdfs[0] }];
  hideDownload($("#pDownload"));
  pdfRenderFiles();
  loadThumbs();
  setStatus(status, o.multi
    ? `${pdfS.files.length} PDF file(s) selected.` + (pdfS.files.length < 2 ? " Add at least one more to merge." : " Click Merge PDFs.")
    : "File selected. " + (o.thumbs ? "Pick pages below, then click " : "Click ") + o.run + ".");
}

function pdfRenderFiles() {
  const multi = OPS[pdfOp()].multi;
  renderItems($("#pFiles"), pdfS.files, {
    onRemove: it => { pdfS.files = pdfS.files.filter(x => x.id !== it.id); pdfRenderFiles(); loadThumbs(); },
    extra: multi ? (row, it) => {
      const i = pdfS.files.indexOf(it);
      const mk = (txt, title, dis, fn) => {
        const b = document.createElement("button");
        b.className = "icon-btn"; b.textContent = txt; b.title = title; b.disabled = dis;
        b.setAttribute("aria-label", title);
        b.addEventListener("click", e => { e.stopPropagation(); fn(); });
        row.appendChild(b);
      };
      mk("↑", "Move up", i === 0, () => { [pdfS.files[i - 1], pdfS.files[i]] = [pdfS.files[i], pdfS.files[i - 1]]; pdfRenderFiles(); });
      mk("↓", "Move down", i === pdfS.files.length - 1, () => { [pdfS.files[i + 1], pdfS.files[i]] = [pdfS.files[i], pdfS.files[i + 1]]; pdfRenderFiles(); });
    } : null
  });
}

/* ----- Page thumbnails (PDF.js) ----- */
function rangeString(nums) {
  const a = [...nums].sort((x, y) => x - y), parts = [];
  for (let i = 0; i < a.length;) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    parts.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`);
    i = j + 1;
  }
  return parts.join(",");
}

function syncThumbSelection() {
  $$("#pThumbs .thumb").forEach(t => t.classList.toggle("sel", pdfS.sel.has(Number(t.dataset.p))));
}

async function loadThumbs() {
  const run = ++pdfS.thumbRun;
  const wrap = $("#pThumbWrap"), box = $("#pThumbs"), info = $("#pThumbInfo");
  box.innerHTML = ""; pdfS.sel.clear(); pdfS.pages = 0;
  const f = pdfS.files[0];
  if (!OPS[pdfOp()].thumbs || !f) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  box.classList.toggle("selectable", pdfOp() === "extract");
  info.textContent = "Loading previews…";
  let doc;
  try {
    await lib("pdfjs");
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(await f.file.arrayBuffer()) }).promise;
  } catch (err) {
    if (run !== pdfS.thumbRun) return;
    info.textContent = err && err.name === "PasswordException"
      ? "This PDF is password-protected. Use “Remove password” first."
      : "Could not preview this PDF: " + (err.message || err);
    return;
  }
  if (run !== pdfS.thumbRun) { doc.destroy(); return; }
  pdfS.pages = doc.numPages;
  const MAX = 150, count = Math.min(doc.numPages, MAX);
  info.textContent = `${doc.numPages} page(s)` + (doc.numPages > MAX ? ` – previewing the first ${MAX}` : "") +
    (pdfOp() === "extract" ? ". Click pages to select them." : ".");
  for (let i = 1; i <= count; i++) {
    if (run !== pdfS.thumbRun) { doc.destroy(); return; }
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 120 / base.width });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    if (run !== pdfS.thumbRun) { doc.destroy(); return; }   // a newer file was chosen meanwhile
    const t = document.createElement("div");
    t.className = "thumb"; t.dataset.p = i;
    t.appendChild(c);
    t.appendChild(document.createTextNode(`Page ${i}`));
    t.addEventListener("click", () => {
      if (pdfOp() !== "extract") return;
      pdfS.sel.has(i) ? pdfS.sel.delete(i) : pdfS.sel.add(i);
      $("#pPageBox").value = rangeString(pdfS.sel);
      syncThumbSelection();
    });
    box.appendChild(t);
    page.cleanup();
    if (i % 4 === 0) await tick();
  }
  doc.destroy();
}

$("#pPageBox").addEventListener("input", () => {        // typing updates the thumbnail highlights
  try { pdfS.sel = new Set(parsePageSelection($("#pPageBox").value, pdfS.pages || 100000)); }
  catch { pdfS.sel = new Set(); }
  syncThumbSelection();
});
$("#pShowPw").addEventListener("change", e => {
  $("#pUser").type = $("#pOwner").type = e.target.checked ? "text" : "password";
});

function parsePageSelection(selection, pageCount) {
  if (!selection || !selection.trim()) throw new Error("Enter pages, for example: 1,3-5.");
  const pages = new Set();
  for (const raw of selection.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const range = part.split("-").map(s => s.trim());
    if (range.length === 1) {
      const n = Number(range[0]);
      if (!/^\d+$/.test(range[0]) || n < 1 || n > pageCount)
        throw new Error(`Invalid page number: ${range[0]}. This PDF has ${pageCount} pages.`);
      pages.add(n);
    } else if (range.length === 2 && /^\d+$/.test(range[0]) && /^\d+$/.test(range[1])) {
      const start = Number(range[0]), end = Number(range[1]);
      if (start < 1 || end < start || end > pageCount)
        throw new Error(`Invalid page range: ${part}. This PDF has ${pageCount} pages.`);
      for (let p = start; p <= end; p++) pages.add(p);
    } else {
      throw new Error(`Invalid page selection: ${part}. Use a format such as 1,3-5.`);
    }
  }
  if (pages.size === 0) throw new Error("No valid pages were selected.");
  return [...pages].sort((a, b) => a - b);
}

function friendlyPdfError(err) {
  return err && (err.name === "PasswordException" || /is encrypted/i.test(err.message || ""))
    ? "This PDF is password-protected. Use “Remove password” on it first."
    : (err && err.message) || String(err);
}

function randomPassword(len = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = crypto.getRandomValues(new Uint32Array(len));
  return [...buf].map(v => chars[v % chars.length]).join("");
}

$("#pRun").addEventListener("click", async () => {
  const status = $("#pStatus"), prog = $("#pProg"), btn = $("#pRun"), op = pdfOp();
  if (!pdfS.files.length) return setStatus(status, "Select a PDF file first.", true);
  if (op === "merge" && pdfS.files.length < 2)
    return setStatus(status, "Select at least two PDF files to merge.", true);

  btn.disabled = true; hideDownload($("#pDownload")); setProgress(prog, 0.05);
  const first = pdfS.files[0].file;
  const record = (orig, outName, opName, origSize, blob) => History.add({
    originalFileName: orig, outputFileName: outName, fileType: "PDF",
    operation: opName, originalSize: origSize, outputSize: blob.size
  }, blob);

  try {
    if (op === "merge") {
      await lib("pdflib");
      setStatus(status, "Merging…");
      const out = await PDFLib.PDFDocument.create();
      let i = 0;
      for (const f of pdfS.files) {
        let src;
        try { src = await PDFLib.PDFDocument.load(await f.file.arrayBuffer()); }
        catch (e) { throw new Error(`${f.file.name}: ${friendlyPdfError(e)}`); }
        (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
        setProgress(prog, ++i / pdfS.files.length); await tick();
      }
      const blob = new Blob([await out.save()], { type: "application/pdf" });
      setDownload($("#pDownload"), blob, "merged.pdf", "Download merged PDF");
      record(pdfS.files.map(f => f.file.name).join(", "), "merged.pdf", "Merge PDF",
             pdfS.files.reduce((s, f) => s + f.file.size, 0), blob);
      setStatus(status, `Merge completed (${formatSize(blob.size)}). Saved to Conversion History.`);

    } else if (op === "extract") {
      await lib("pdflib");
      let src;
      try { src = await PDFLib.PDFDocument.load(await first.arrayBuffer()); }
      catch (e) { throw new Error(friendlyPdfError(e)); }
      const nums = parsePageSelection($("#pPageBox").value, src.getPageCount());
      const out = await PDFLib.PDFDocument.create();
      (await out.copyPages(src, nums.map(n => n - 1))).forEach(p => out.addPage(p));
      const blob = new Blob([await out.save()], { type: "application/pdf" });
      const name = `${baseName(first.name)}_extracted.pdf`;
      setDownload($("#pDownload"), blob, name, "Download extracted PDF");
      record(first.name, name, "Extract PDF Pages", first.size, blob);
      setStatus(status, `Extracted ${nums.length} page(s). Saved to Conversion History.`);

    } else if (op === "split") {
      await lib("pdflib");
      let src;
      try { src = await PDFLib.PDFDocument.load(await first.arrayBuffer()); }
      catch (e) { throw new Error(friendlyPdfError(e)); }
      const total = src.getPageCount(), pad = String(total).length, entries = [];
      for (let i = 0; i < total; i++) {
        const out = await PDFLib.PDFDocument.create();
        out.addPage((await out.copyPages(src, [i]))[0]);
        entries.push({ name: `${baseName(first.name)}_page_${String(i + 1).padStart(pad, "0")}.pdf`,
                       blob: new Blob([await out.save()], { type: "application/pdf" }) });
        setProgress(prog, (i + 1) / total); setStatus(status, `Splitting page ${i + 1} of ${total}…`);
        if (i % 3 === 0) await tick();
      }
      const zip = await makeZip(entries);
      const name = `${baseName(first.name)}_pages.zip`;
      setDownload($("#pDownload"), zip, name, `Download ZIP (${total} PDFs)`);
      record(first.name, name, "Split PDF", first.size, zip);
      setStatus(status, `Split into ${total} PDF(s). Saved to Conversion History.`);

    } else if (op === "protect") {
      const user = $("#pUser").value;
      if (!user) throw new Error("Enter a password for opening the protected PDF.");
      const owner = $("#pOwner").value || randomPassword();
      setStatus(status, "Encrypting (loading the encryption engine the first time)…");
      setProgress(prog, 0.3);
      const bytes = new Uint8Array(await first.arrayBuffer());
      const r = await runQpdf([
        "--encrypt", user, owner, "256",
        `--print=${$("#pAllowPrint").checked ? "full" : "none"}`,
        `--extract=${$("#pAllowCopy").checked ? "y" : "n"}`,
        `--modify=${$("#pAllowEdit").checked ? "all" : "none"}`,
        `--annotate=${$("#pAllowEdit").checked ? "y" : "n"}`,
        "--", "/in.pdf", "/out.pdf"
      ], { "in.pdf": bytes }, "out.pdf");
      if (!r.out || (r.rc !== 0 && r.rc !== 3))
        throw new Error(/password|encrypt/i.test(r.log) && /invalid|incorrect/i.test(r.log)
          ? "This PDF is already password-protected. Remove its password first."
          : (r.log || "Encryption failed."));
      const blob = new Blob([r.out], { type: "application/pdf" });
      const name = `${baseName(first.name)}_protected.pdf`;
      setDownload($("#pDownload"), blob, name, "Download protected PDF");
      record(first.name, name, "Protect PDF", first.size, blob);
      setStatus(status, "Password protection completed (AES-256). Saved to Conversion History.\nKeep your password safe – it can't be recovered.");

    } else if (op === "unlock") {
      const pass = $("#pPass").value;
      setStatus(status, "Removing password…");
      setProgress(prog, 0.3);
      const bytes = new Uint8Array(await first.arrayBuffer());
      const r = await runQpdf(["--decrypt", `--password=${pass}`, "/in.pdf", "/out.pdf"], { "in.pdf": bytes }, "out.pdf");
      if (!r.out || (r.rc !== 0 && r.rc !== 3))
        throw new Error(/invalid password|incorrect password/i.test(r.log) || r.rc === 2
          ? "Incorrect password, or the PDF could not be opened." : (r.log || "Could not remove the password."));
      const blob = new Blob([r.out], { type: "application/pdf" });
      const name = `${baseName(first.name)}_unlocked.pdf`;
      setDownload($("#pDownload"), blob, name, "Download unlocked PDF");
      record(first.name, name, "Remove PDF Password", first.size, blob);
      setStatus(status, "Password removed. Saved to Conversion History.");
    }
    toast("Done");
  } catch (err) {
    setStatus(status, `Operation failed: ${friendlyPdfError(err)}`, true);
  } finally {
    setProgress(prog, null);
    btn.disabled = false;
  }
});

/* ============================================================
   10. FILE INSPECTOR  (port of FileTypeDetector)
   ============================================================ */
function startsWith(data, ...sig) {
  return data.length >= sig.length && sig.every((b, i) => data[i] === b);
}
const ascii = (data, start, len) => String.fromCharCode(...data.slice(start, start + len));

function getCategory(format) {
  const map = {
    Image: ["PNG", "JPEG", "JPG", "GIF", "WEBP", "BMP", "TIFF", "TIF", "ICO"],
    Document: ["PDF", "DOC", "DOCX", "XLS", "XLSX", "PPT", "PPTX", "TXT", "RTF"],
    Audio: ["MP3", "WAV", "FLAC", "AAC", "OGG", "M4A"],
    Video: ["MP4", "AVI", "MKV", "MOV", "WEBM"],
    Archive: ["ZIP", "RAR", "7Z", "TAR", "GZ"]
  };
  for (const [cat, list] of Object.entries(map)) if (list.includes(format)) return cat;
  return "Unknown";
}

async function detectFile(file) {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  let format = extOf(file.name).toUpperCase(), method = "Extension";

  if (startsWith(header, 0x25, 0x50, 0x44, 0x46)) { format = "PDF"; method = "File signature"; }
  else if (startsWith(header, 0x89, 0x50, 0x4E, 0x47)) { format = "PNG"; method = "File signature"; }
  else if (startsWith(header, 0xFF, 0xD8, 0xFF)) { format = "JPEG"; method = "File signature"; }
  else if (startsWith(header, 0x47, 0x49, 0x46, 0x38)) { format = "GIF"; method = "File signature"; }
  else if (startsWith(header, 0x50, 0x4B, 0x03, 0x04)) { format = "ZIP"; method = "File signature"; }
  else if (startsWith(header, 0x49, 0x44, 0x33)) { format = "MP3"; method = "File signature"; }
  else if (startsWith(header, 0x52, 0x49, 0x46, 0x46)) {
    const riff = ascii(header, 8, 4);
    if (riff === "WEBP") format = "WEBP"; else if (riff === "WAVE") format = "WAV";
    method = "File signature";
  }
  else if (header.length >= 8 && ascii(header, 4, 4) === "ftyp") { format = "MP4"; method = "File signature"; }
  else if (startsWith(header, 0x42, 0x4D)) { format = "BMP"; method = "File signature"; }

  const category = getCategory(format);
  return { format: format || "—", category, isSupported: category !== "Unknown", method };
}

async function inspectFiles(files) {
  const out = $("#inspectResults");
  out.innerHTML = `<h3 class="section-title">${files.length} file(s) selected</h3>`;
  for (const f of files) {
    const d = await detectFile(f);
    const card = document.createElement("div");
    card.className = "record";
    card.innerHTML =
      `<h5>${esc(f.name)}</h5>` +
      `<p class="meta">${esc(d.format)} • ${esc(d.category)} • ${formatSize(f.size)}</p>` +
      (d.isSupported
        ? `<p class="tag-ok">Detected by: ${esc(d.method)}</p>`
        : `<p class="tag-warn">Unknown format – further inspection required</p>`);
    out.appendChild(card);
  }
}

/* ============================================================
   11. HISTORY
   ============================================================ */
function loadHistory() {
  const records = History.query($("#hSearch").value, $("#hFilter").value);
  const list = $("#hList");
  list.innerHTML = "";
  const saved = records.filter(r => /Compression/.test(r.operation))
    .reduce((s, r) => s + Math.max(0, r.originalSize - r.outputSize), 0);
  $("#hStatus").textContent = `${records.length} history record(s)` +
    (saved > 0 ? ` • ${formatSize(saved)} saved by compression` : "") + ".";

  if (!records.length) {
    list.innerHTML = `<p class="muted small">No history records yet. Convert or compress a file and it will appear here.</p>`;
    return;
  }
  for (const r of records) {
    const card = document.createElement("div");
    card.className = "record";
    const when = new Date(r.completedAt).toLocaleString("en-GB",
      { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
    const available = History.outputs.has(r.id);
    card.innerHTML =
      `<h5>${esc(r.operation)} • ${esc(r.status)}</h5>` +
      `<p>Original: ${esc(r.originalFileName)}<br>Output: ${esc(r.outputFileName)}</p>` +
      `<p class="meta">${esc(r.fileType)} • ${esc(when)}</p>` +
      `<p class="meta">Original: ${formatSize(r.originalSize)} &nbsp; Output: ${formatSize(r.outputSize)}</p>` +
      `<div class="btns">` +
        `<button class="btn secondary" data-act="dl" ${available ? "" : "disabled"} ` +
          `title="${available ? "" : "Output files are only kept until you close or reload the page"}">Download Output</button>` +
        `<button class="btn danger" data-act="del">Delete Record</button>` +
      `</div>`;
    $('[data-act="dl"]', card).addEventListener("click", () => {
      const o = History.outputs.get(r.id);
      if (o) triggerDownload(o.blob, o.name);
    });
    $('[data-act="del"]', card).addEventListener("click", () => { History.remove(r.id); loadHistory(); });
    list.appendChild(card);
  }
}
$("#hSearchBtn").addEventListener("click", loadHistory);
$("#hFilter").addEventListener("change", loadHistory);
$("#hSearch").addEventListener("keydown", e => { if (e.key === "Enter") loadHistory(); });
$("#hClear").addEventListener("click", () => {
  if (confirm("Delete all history records? Output files will not be deleted.")) { History.clear(); loadHistory(); }
});

function renderRecent() {
  const recent = History.query("", "All").slice(0, 3);
  $("#recentActivity").innerHTML = recent.length
    ? recent.map(r => `${esc(r.operation)} • ${esc(r.originalFileName)} → ${esc(r.outputFileName)}`).join("<br>")
    : "Your recent file operations can be reviewed in Conversion History.";
}

/* ------------------------------------------------------------
   12. Init
   ------------------------------------------------------------ */
setupDrop($("#imgDrop"), $("#imgInput"), imgAdd);
setupDrop($("#pDrop"), $("#pInput"), pdfAdd);
setupDrop($("#cDrop"), $("#cInput"), cAdd);
setupDrop($("#inspectDrop"), $("#inspectInput"), inspectFiles);

updatePdfOperation();
renderRecent();
