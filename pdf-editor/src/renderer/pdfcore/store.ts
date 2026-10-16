import { PDFDocument, degrees } from 'pdf-lib';
import type { OpenedFile, PdfEditorApi } from '../../shared/ipc';
import {
  extractPageText,
  loadPdfJs,
  type PageTextItem,
  type PageViewport,
  type PdfJsDocument,
  type PdfJsPage,
  type RenderTask,
} from './pdfjs';
import { flattenAnnotations } from './flatten';
import { loadCjkFont, needsCjk, onCjkFontLoaded, type CjkFontStatus } from './fonts';
import { recognizeCanvas, type OcrPageResult } from './ocr';
import { clamp, uid } from './coords';
import type {
  Annotation,
  AnnotationPatch,
  FitMode,
  OcrAnnotation,
  PageInfo,
  SearchMatch,
  SignatureAnnotation,
  Tool,
} from './types';

export interface OcrProgressState {
  mode: 'page' | 'document';
  current: number;
  total: number;
  /** 0–1 within the current page (tesseract logger). */
  pageFraction: number;
  label: string;
}

export interface EditorState {
  phase: 'empty' | 'loading' | 'ready' | 'error';
  fileName: string | null;
  dirty: boolean;
  pageCount: number;
  currentPage: number;
  scale: number;
  fitMode: FitMode;
  tool: Tool;
  color: string;
  strokeWidth: number;
  fontSize: number;
  /** Bumped whenever annotations change so overlays re-render. */
  annotationsVersion: number;
  /** Bumped whenever the underlying document bytes change (page ops, merge). */
  docVersion: number;
  searchQuery: string;
  searchMatches: SearchMatch[];
  searchActive: number;
  searching: boolean;
  selectedAnnotationId: string | null;
  /** Imperative scroll requests from navigation UI to the page area. */
  scrollTarget: { page: number; seq: number } | null;
  statusMessage: string;
  errorMessage: string | null;
  /** Bundled CJK font fetch state; null until the background load settles. */
  cjkFontStatus: CjkFontStatus | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Non-null while OCR is running. */
  ocrProgress: OcrProgressState | null;
  /**
   * When the signature tool is active, a click on a page places this image.
   * Cleared after place; stamp-all uses it without clearing until cancelled.
   */
  pendingSignatureDataUrl: string | null;
}

const initialState: EditorState = {
  phase: 'empty',
  fileName: null,
  dirty: false,
  pageCount: 0,
  currentPage: 0,
  scale: 1,
  fitMode: 'width',
  tool: 'select',
  color: '#ffd400',
  strokeWidth: 2.5,
  fontSize: 16,
  annotationsVersion: 0,
  docVersion: 0,
  searchQuery: '',
  searchMatches: [],
  searchActive: 0,
  searching: false,
  selectedAnnotationId: null,
  scrollTarget: null,
  statusMessage: 'Open a PDF to begin',
  errorMessage: null,
  cjkFontStatus: 'loading',
  canUndo: false,
  canRedo: false,
  ocrProgress: null,
  pendingSignatureDataUrl: null,
};

/** One reversible mutation. Stack discipline keeps page references valid:
 * an entry is only ever undone after every later entry has been undone. */
type HistoryEntry = {
  label: string;
  time: number;
  coalesceKey?: string;
} & (
  | { kind: 'ann-add'; ann: Annotation }
  | { kind: 'ann-remove'; pageId: string; ann: Annotation; index: number }
  | { kind: 'ann-update'; pageId: string; id: string; before: Annotation; after: Annotation }
  | { kind: 'rotate'; pageId: string; delta: number }
  | {
      kind: 'delete-page';
      pageIndex: number;
      pageId: string;
      pageBytes: Uint8Array;
      anns: Annotation[];
    }
  | { kind: 'insert-blank'; pageIndex: number; pageId: string; width: number; height: number }
  | { kind: 'move-page'; from: number; to: number }
  | { kind: 'merge'; pageIds: string[]; sourceBytes: Uint8Array; sourceName: string }
);

const HISTORY_LIMIT = 100;
/** Rapid-fire updates with the same key (drags, slider/color changes) merge. */
const COALESCE_WINDOW_MS = 1200;

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

/**
 * Central editor controller. Owns the pdf.js render document, the pdf-lib
 * working document, the page-id mapping that keeps annotations attached
 * across reorder/delete, and all mutations. React subscribes through
 * useSyncExternalStore.
 */
export class EditorStore {
  private state: EditorState = initialState;
  private readonly listeners = new Set<() => void>();

  private bytes: Uint8Array | null = null;
  private filePath: string | null = null;
  private pdfDoc: PdfJsDocument | null = null;
  private libDoc: PDFDocument | null = null;
  private pageIds: string[] = [];
  private pageInfos: PageInfo[] = [];
  private readonly annotations = new Map<string, Annotation[]>();
  private pageProxyCache = new Map<number, Promise<PdfJsPage>>();
  private textCache = new Map<number, PageTextItem[]>();
  private containerWidth = 0;
  private containerHeight = 0;
  private scrollSeq = 0;
  private lastSearchQuery = '';
  private notifiedFirstRender = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  /**
   * dirty = (revision !== savedRevision). Every mutation moves the revision
   * one step, undo/redo walk it back and forth, and saving pins the saved
   * revision — so undoing back to the saved state correctly shows "clean".
   */
  private revision = 0;
  private savedRevision = 0;
  /** Serializes structural (async) ops so history stays a consistent chain. */
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly platform: PdfEditorApi) {
    // Start the CJK font fetch immediately but never await it here: app
    // startup must not block on a 6 MB asset. Save awaits it if needed.
    void loadCjkFont();
    onCjkFontLoaded((result) => this.set({ cjkFontStatus: result.status }));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): EditorState => this.state;

  private set(partial: Partial<EditorState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  private status(message: string): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.set({ statusMessage: message });
    this.statusTimer = setTimeout(() => {
      this.set({ statusMessage: this.state.fileName ?? 'Open a PDF to begin' });
    }, 6000);
  }

  // --------------------------------------------------------------- history

  private derive(): Pick<EditorState, 'dirty' | 'canUndo' | 'canRedo'> {
    return {
      dirty: this.revision !== this.savedRevision,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  private pushHistory(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
  }

  /** A fresh user mutation: revision advances and the redo branch dies. */
  private mutated(): void {
    this.revision += 1;
    this.redoStack.length = 0;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.revision = 0;
    this.savedRevision = 0;
  }

  // ---------------------------------------------------------------- opening

  async openFile(file: OpenedFile): Promise<void> {
    this.set({ phase: 'loading', errorMessage: null, statusMessage: `Opening ${file.name}...` });
    try {
      const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      const libDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pdfDoc = await loadPdfJs(bytes);

      await this.destroyPdfDoc();
      this.bytes = bytes;
      this.libDoc = libDoc;
      this.pdfDoc = pdfDoc;
      this.filePath = file.path || null;
      this.pageIds = Array.from({ length: pdfDoc.numPages }, () => uid());
      this.annotations.clear();
      this.textCache.clear();
      this.pageProxyCache.clear();
      this.notifiedFirstRender = false;
      this.lastSearchQuery = '';
      this.clearHistory();
      await this.reloadPageInfos();

      this.set({
        phase: 'ready',
        fileName: file.name,
        ...this.derive(),
        pageCount: pdfDoc.numPages,
        currentPage: 0,
        docVersion: this.state.docVersion + 1,
        annotationsVersion: this.state.annotationsVersion + 1,
        searchMatches: [],
        searchQuery: '',
        searchActive: 0,
        selectedAnnotationId: null,
        scrollTarget: { page: 0, seq: (this.scrollSeq += 1) },
        statusMessage: `Opened ${file.name}`,
      });
      this.applyFitScale();
    } catch (error) {
      this.set({
        phase: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        statusMessage: 'Failed to open PDF',
      });
    }
  }

  /** Open the file passed via argv (Electron) or ?sample= (browser preview). */
  async openInitial(): Promise<void> {
    if (this.state.phase !== 'empty') return;
    const file = await this.platform.getInitialFile();
    if (file) await this.openFile(file);
  }

  async openDialog(): Promise<void> {
    const file = await this.platform.openPdfDialog();
    if (file) await this.openFile(file);
  }

  async mergeDialog(): Promise<void> {
    const file = await this.platform.openPdfDialog();
    if (file) await this.mergePdf(file);
  }

  async openDroppedFile(file: File): Promise<void> {
    const data = new Uint8Array(await file.arrayBuffer());
    await this.openFile({ path: '', name: file.name, data });
  }

  private async destroyPdfDoc(): Promise<void> {
    if (this.pdfDoc) {
      try {
        await this.pdfDoc.destroy();
      } catch {
        // already destroyed
      }
      this.pdfDoc = null;
    }
  }

  private async reloadPageInfos(): Promise<void> {
    if (!this.pdfDoc) return;
    const doc = this.pdfDoc;
    this.pageInfos = await Promise.all(
      this.pageIds.map(async (id, index) => {
        const page = await doc.getPage(index + 1);
        const viewport = page.getViewport({ scale: 1 });
        return { id, width: viewport.width, height: viewport.height };
      }),
    );
  }

  // ------------------------------------------------------------- rendering

  getPageInfo(index: number): PageInfo | null {
    return this.pageInfos[index] ?? null;
  }

  private getPdfPage(index: number): Promise<PdfJsPage> {
    const cached = this.pageProxyCache.get(index);
    if (cached) return cached;
    if (!this.pdfDoc) return Promise.reject(new Error('No document open'));
    const promise = this.pdfDoc.getPage(index + 1);
    this.pageProxyCache.set(index, promise);
    return promise;
  }

  async getViewport(index: number, scale: number): Promise<PageViewport> {
    const page = await this.getPdfPage(index);
    return page.getViewport({ scale });
  }

  /** Size a canvas for the current device pixel ratio and start rendering. */
  async beginRender(index: number, canvas: HTMLCanvasElement, scale: number): Promise<RenderTask> {
    const page = await this.getPdfPage(index);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: scale * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    return page.render({ canvasContext: ctx, viewport });
  }

  markFirstRender(): void {
    if (this.notifiedFirstRender) return;
    this.notifiedFirstRender = true;
    this.platform.notifyRendered();
  }

  // ---------------------------------------------------------- zoom and fit

  setViewportSize(width: number, height: number): void {
    if (width === this.containerWidth && height === this.containerHeight) return;
    this.containerWidth = width;
    this.containerHeight = height;
    if (this.state.phase === 'ready' && this.state.fitMode !== 'custom') this.applyFitScale();
  }

  setFitMode(mode: FitMode): void {
    this.set({ fitMode: mode });
    this.applyFitScale();
  }

  zoomIn(): void {
    this.setCustomScale(this.state.scale * 1.2);
  }

  zoomOut(): void {
    this.setCustomScale(this.state.scale / 1.2);
  }

  setScalePercent(percent: number): void {
    this.setCustomScale(percent / 100);
  }

  private setCustomScale(scale: number): void {
    this.set({ fitMode: 'custom', scale: clamp(scale, MIN_SCALE, MAX_SCALE) });
  }

  private applyFitScale(): void {
    if (this.state.fitMode === 'custom') return;
    const info = this.pageInfos[this.state.currentPage] ?? this.pageInfos[0];
    if (!info || this.containerWidth < 50 || this.containerHeight < 50) return;
    const availW = this.containerWidth - 64;
    const availH = this.containerHeight - 64;
    const scaleW = availW / info.width;
    const scaleH = availH / info.height;
    const scale = this.state.fitMode === 'width' ? scaleW : Math.min(scaleW, scaleH);
    this.set({ scale: clamp(scale, MIN_SCALE, MAX_SCALE) });
  }

  // -------------------------------------------------------------- navigation

  setCurrentPage(index: number): void {
    if (index !== this.state.currentPage && index >= 0 && index < this.state.pageCount) {
      this.set({ currentPage: index });
    }
  }

  goToPage(index: number): void {
    const target = clamp(index, 0, this.state.pageCount - 1);
    this.set({
      currentPage: target,
      scrollTarget: { page: target, seq: (this.scrollSeq += 1) },
    });
  }

  // ------------------------------------------------------------------ tools

  setTool(tool: Tool): void {
    const patch: Partial<EditorState> = { tool, selectedAnnotationId: null };
    // Keep colors sensible per tool: highlights default to yellow, text to ink.
    if (tool === 'highlight' && this.state.color === '#111827') patch.color = '#ffd400';
    if ((tool === 'text' || tool === 'pen' || tool === 'rect') && this.state.color === '#ffd400') {
      patch.color = tool === 'text' ? '#111827' : '#ff5a52';
    }
    if (tool !== 'signature') patch.pendingSignatureDataUrl = null;
    this.set(patch);
  }

  setPendingSignature(dataUrl: string | null): void {
    this.set({
      pendingSignatureDataUrl: dataUrl,
      tool: dataUrl ? 'signature' : this.state.tool === 'signature' ? 'select' : this.state.tool,
      selectedAnnotationId: null,
    });
  }

  setColor(color: string): void {
    this.set({ color });
    const selected = this.getSelectedAnnotation();
    if (selected) this.updateAnnotation(selected.id, { color }, { coalesceKey: `color:${selected.id}` });
  }

  setStrokeWidth(strokeWidth: number): void {
    this.set({ strokeWidth });
    const selected = this.getSelectedAnnotation();
    if (selected && (selected.kind === 'pen' || selected.kind === 'rect')) {
      this.updateAnnotation(selected.id, { strokeWidth }, { coalesceKey: `stroke:${selected.id}` });
    }
  }

  setFontSize(fontSize: number): void {
    this.set({ fontSize });
    const selected = this.getSelectedAnnotation();
    if (selected && selected.kind === 'text') {
      this.updateAnnotation(selected.id, { fontSize }, { coalesceKey: `font:${selected.id}` });
    }
  }

  // ------------------------------------------------------------- annotations

  getAnnotations(pageId: string): Annotation[] {
    return this.annotations.get(pageId) ?? [];
  }

  annotationCount(): number {
    let count = 0;
    for (const list of this.annotations.values()) count += list.length;
    return count;
  }

  getSelectedAnnotation(): Annotation | null {
    const id = this.state.selectedAnnotationId;
    if (!id) return null;
    for (const list of this.annotations.values()) {
      const found = list.find((a) => a.id === id);
      if (found) return found;
    }
    return null;
  }

  selectAnnotation(id: string | null): void {
    this.set({ selectedAnnotationId: id });
  }

  addAnnotation(ann: Annotation): void {
    const list = this.annotations.get(ann.pageId) ?? [];
    list.push(ann);
    this.annotations.set(ann.pageId, list);
    this.pushHistory({
      kind: 'ann-add',
      label: `${ann.kind} annotation`,
      time: Date.now(),
      ann: structuredClone(ann),
    });
    this.mutated();
    this.set({
      annotationsVersion: this.state.annotationsVersion + 1,
      ...this.derive(),
    });
  }

  updateAnnotation(id: string, patch: AnnotationPatch, opts?: { coalesceKey?: string }): void {
    for (const [pageId, list] of this.annotations) {
      const index = list.findIndex((a) => a.id === id);
      if (index === -1) continue;
      const before = list[index]!;
      const after = { ...before, ...patch } as Annotation;
      list[index] = after;
      const now = Date.now();
      const top = this.undoStack[this.undoStack.length - 1];
      if (
        opts?.coalesceKey &&
        top?.kind === 'ann-update' &&
        top.id === id &&
        top.coalesceKey === opts.coalesceKey &&
        now - top.time < COALESCE_WINDOW_MS
      ) {
        // Same gesture (drag / slider): extend the existing entry instead of
        // flooding the stack with one entry per pointer move.
        top.after = structuredClone(after);
        top.time = now;
      } else {
        this.pushHistory({
          kind: 'ann-update',
          label: 'edit annotation',
          time: now,
          coalesceKey: opts?.coalesceKey,
          pageId,
          id,
          before: structuredClone(before),
          after: structuredClone(after),
        });
      }
      this.mutated();
      this.set({
        annotationsVersion: this.state.annotationsVersion + 1,
        ...this.derive(),
      });
      return;
    }
  }

  deleteAnnotation(id: string): void {
    for (const [pageId, list] of this.annotations) {
      const index = list.findIndex((a) => a.id === id);
      if (index === -1) continue;
      const [removed] = list.splice(index, 1);
      if (list.length === 0) this.annotations.delete(pageId);
      if (removed) {
        this.pushHistory({
          kind: 'ann-remove',
          label: `delete ${removed.kind} annotation`,
          time: Date.now(),
          pageId,
          ann: structuredClone(removed),
          index,
        });
        this.mutated();
      }
      this.set({
        annotationsVersion: this.state.annotationsVersion + 1,
        selectedAnnotationId: null,
        ...this.derive(),
      });
      this.status('Annotation deleted');
      return;
    }
  }

  deleteSelectedAnnotation(): void {
    if (this.state.selectedAnnotationId) this.deleteAnnotation(this.state.selectedAnnotationId);
  }

  // ------------------------------------------------------------ undo/redo

  async undo(): Promise<void> {
    return this.undoRedo('undo');
  }

  async redo(): Promise<void> {
    return this.undoRedo('redo');
  }

  private async undoRedo(direction: 'undo' | 'redo'): Promise<void> {
    return this.enqueue(async () => {
      const entry = direction === 'undo' ? this.undoStack.pop() : this.redoStack.pop();
      if (!entry) return;
      await this.applyHistory(entry, direction === 'redo');
      if (direction === 'undo') this.redoStack.push(entry);
      else this.undoStack.push(entry);
      this.revision += direction === 'undo' ? -1 : 1;
      this.set({
        annotationsVersion: this.state.annotationsVersion + 1,
        selectedAnnotationId: null,
        ...this.derive(),
      });
      this.status(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${entry.label}`);
    });
  }

  /** Replay (forward) or reverse one history entry without recording it. */
  private async applyHistory(entry: HistoryEntry, forward: boolean): Promise<void> {
    switch (entry.kind) {
      case 'ann-add':
        if (forward) this.reinsertAnnotation(entry.ann);
        else this.removeAnnotationById(entry.ann.id);
        break;
      case 'ann-remove':
        if (forward) this.removeAnnotationById(entry.ann.id);
        else this.reinsertAnnotation(entry.ann, entry.pageId, entry.index);
        break;
      case 'ann-update':
        this.replaceAnnotation(entry.id, forward ? entry.after : entry.before);
        break;
      case 'rotate':
        await this.rotatePageId(entry.pageId, forward ? entry.delta : -entry.delta);
        break;
      case 'delete-page':
        if (forward) await this.deletePageId(entry.pageId);
        else await this.reinsertDeletedPage(entry);
        break;
      case 'insert-blank':
        if (forward) await this.insertBlankPage(entry.pageIndex, entry.pageId, entry.width, entry.height);
        else await this.deletePageId(entry.pageId);
        break;
      case 'move-page':
        await this.movePageRaw(forward ? entry.from : entry.to, forward ? entry.to : entry.from);
        break;
      case 'merge':
        if (forward) await this.reMerge(entry);
        else await this.unmerge(entry);
        break;
    }
  }

  private reinsertAnnotation(ann: Annotation, pageId?: string, index?: number): void {
    const targetPage = pageId ?? ann.pageId;
    const list = this.annotations.get(targetPage) ?? [];
    const copy = structuredClone(ann);
    if (index !== undefined && index <= list.length) list.splice(index, 0, copy);
    else list.push(copy);
    this.annotations.set(targetPage, list);
  }

  private removeAnnotationById(id: string): void {
    for (const [pageId, list] of this.annotations) {
      const index = list.findIndex((a) => a.id === id);
      if (index === -1) continue;
      list.splice(index, 1);
      if (list.length === 0) this.annotations.delete(pageId);
      return;
    }
  }

  private replaceAnnotation(id: string, ann: Annotation): void {
    for (const list of this.annotations.values()) {
      const index = list.findIndex((a) => a.id === id);
      if (index === -1) continue;
      list[index] = structuredClone(ann);
      return;
    }
  }

  private async reinsertDeletedPage(entry: Extract<HistoryEntry, { kind: 'delete-page' }>): Promise<void> {
    if (!this.libDoc) return;
    const source = await PDFDocument.load(entry.pageBytes);
    const [page] = await this.libDoc.copyPages(source, [0]);
    const index = Math.min(entry.pageIndex, this.pageIds.length);
    this.libDoc.insertPage(index, page);
    this.pageIds.splice(index, 0, entry.pageId);
    if (entry.anns.length > 0) {
      this.annotations.set(entry.pageId, entry.anns.map((a) => structuredClone(a)));
    }
    await this.resync(`Restored page ${index + 1}`);
  }

  private async unmerge(entry: Extract<HistoryEntry, { kind: 'merge' }>): Promise<void> {
    if (!this.libDoc) return;
    for (const pageId of entry.pageIds) {
      const index = this.pageIds.indexOf(pageId);
      if (index === -1) continue;
      this.pageIds.splice(index, 1);
      this.annotations.delete(pageId);
      this.libDoc.removePage(index);
    }
    await this.resync(`Removed ${entry.pageIds.length} merged pages`);
  }

  private async reMerge(entry: Extract<HistoryEntry, { kind: 'merge' }>): Promise<void> {
    if (!this.libDoc) return;
    const source = await PDFDocument.load(entry.sourceBytes, { ignoreEncryption: true });
    const copied = await this.libDoc.copyPages(source, source.getPageIndices());
    copied.forEach((page, i) => {
      this.libDoc!.addPage(page);
      // Reuse the original ids so later history entries keep their targets.
      this.pageIds.push(entry.pageIds[i] ?? uid());
    });
    await this.resync(`Re-merged ${copied.length} pages from ${entry.sourceName}`);
  }

  // ------------------------------------------------------------------ search

  setSearchQuery(query: string): void {
    this.set({ searchQuery: query });
  }

  private async getTextItems(index: number): Promise<PageTextItem[]> {
    const cached = this.textCache.get(index);
    const base = cached ?? (await this.loadBaseTextItems(index));
    // OCR runs live as annotations until save; merge them so search works
    // immediately without waiting for flatten.
    const pageId = this.pageIds[index];
    if (!pageId) return base;
    const ocrItems = this.ocrTextItemsForPage(pageId);
    if (ocrItems.length === 0) return base;
    return [...base, ...ocrItems];
  }

  private async loadBaseTextItems(index: number): Promise<PageTextItem[]> {
    const page = await this.getPdfPage(index);
    const items = await extractPageText(page);
    this.textCache.set(index, items);
    return items;
  }

  private ocrTextItemsForPage(pageId: string): PageTextItem[] {
    const items: PageTextItem[] = [];
    for (const ann of this.getAnnotations(pageId)) {
      if (ann.kind !== 'ocr') continue;
      for (const run of ann.runs) {
        if (!run.text) continue;
        items.push({ str: run.text, rect: run.rect });
      }
    }
    return items;
  }

  async runSearch(rawQuery?: string): Promise<void> {
    const query = (rawQuery ?? this.state.searchQuery).trim();
    if (!query || this.state.phase !== 'ready') {
      this.set({ searchMatches: [], searchActive: 0, searchQuery: query });
      return;
    }
    // Pressing Enter again with the same query steps to the next match.
    if (query === this.lastSearchQuery && this.state.searchMatches.length > 0) {
      this.nextMatch();
      return;
    }
    this.lastSearchQuery = query;
    this.set({ searching: true, searchQuery: query });
    try {
      const needle = query.toLowerCase();
      const matches: SearchMatch[] = [];
      for (let index = 0; index < this.state.pageCount; index += 1) {
        const pageId = this.pageIds[index];
        if (!pageId) continue;
        const items = await this.getTextItems(index);
        const ranges: { start: number; end: number }[] = [];
        let joined = '';
        for (const item of items) {
          if (joined.length > 0) joined += ' ';
          const start = joined.length;
          joined += item.str;
          ranges.push({ start, end: joined.length });
        }
        const haystack = joined.toLowerCase();
        let from = 0;
        for (;;) {
          const hit = haystack.indexOf(needle, from);
          if (hit === -1) break;
          const hitEnd = hit + needle.length;
          const rects = items
            .filter((_, i) => {
              const r = ranges[i]!;
              return r.end > hit && r.start < hitEnd;
            })
            .map((item) => item.rect);
          if (rects.length > 0) matches.push({ pageId, pageIndex: index, rects });
          from = hitEnd;
        }
      }
      this.set({ searching: false, searchMatches: matches, searchActive: 0 });
      if (matches.length > 0) {
        this.jumpToMatch(0);
        this.status(`${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}"`);
      } else {
        this.status(`No matches for "${query}"`);
      }
    } catch (error) {
      this.set({ searching: false });
      this.status(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  nextMatch(): void {
    const count = this.state.searchMatches.length;
    if (count === 0) return;
    this.jumpToMatch((this.state.searchActive + 1) % count);
  }

  prevMatch(): void {
    const count = this.state.searchMatches.length;
    if (count === 0) return;
    this.jumpToMatch((this.state.searchActive - 1 + count) % count);
  }

  private jumpToMatch(active: number): void {
    const match = this.state.searchMatches[active];
    if (!match) return;
    this.set({
      searchActive: active,
      currentPage: match.pageIndex,
      scrollTarget: { page: match.pageIndex, seq: (this.scrollSeq += 1) },
    });
  }

  clearSearch(): void {
    this.set({ searchQuery: '', searchMatches: [], searchActive: 0 });
  }

  // --------------------------------------------------------------- page ops

  /** Re-serialize the pdf-lib document and reload everything derived from it. */
  private async resync(message: string): Promise<void> {
    if (!this.libDoc) return;
    const keepId = this.pageIds[this.state.currentPage];
    this.bytes = await this.libDoc.save();
    await this.destroyPdfDoc();
    this.pdfDoc = await loadPdfJs(this.bytes);
    this.pageProxyCache.clear();
    this.textCache.clear();
    await this.reloadPageInfos();
    const currentPage = Math.max(0, this.pageIds.indexOf(keepId ?? ''));
    this.set({
      docVersion: this.state.docVersion + 1,
      pageCount: this.pageIds.length,
      currentPage,
      ...this.derive(),
    });
    // Rotations change page dimensions; re-fit when a fit mode is active.
    this.applyFitScale();
    this.status(message);
  }

  async rotateCurrentPage(deltaDegrees: number): Promise<void> {
    return this.enqueue(async () => {
      const pageId = this.pageIds[this.state.currentPage];
      if (!pageId || !(await this.rotatePageId(pageId, deltaDegrees))) return;
      this.pushHistory({
        kind: 'rotate',
        label: `rotate page ${this.state.currentPage + 1}`,
        time: Date.now(),
        pageId,
        delta: deltaDegrees,
      });
      this.mutated();
      this.set(this.derive());
    });
  }

  /** Rotate the page identified by pageId. Returns false when not possible. */
  private async rotatePageId(pageId: string, deltaDegrees: number): Promise<boolean> {
    if (!this.libDoc || this.state.phase !== 'ready') return false;
    const index = this.pageIds.indexOf(pageId);
    if (index === -1) return false;
    const page = this.libDoc.getPage(index);
    const next = (((page.getRotation().angle + deltaDegrees) % 360) + 360) % 360;
    page.setRotation(degrees(next));
    await this.resync(`Rotated page ${index + 1} to ${next} deg`);
    return true;
  }

  async deleteCurrentPage(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.libDoc || this.state.phase !== 'ready') return;
      if (this.state.pageCount <= 1) {
        this.status('Cannot delete the last page');
        return;
      }
      const index = this.state.currentPage;
      const pageId = this.pageIds[index];
      if (!pageId) return;
      // Export the page alone so undo can reinsert it byte-identical.
      const single = await PDFDocument.create();
      const [copy] = await single.copyPages(this.libDoc, [index]);
      single.addPage(copy);
      const pageBytes = await single.save();
      const anns = this.getAnnotations(pageId).map((a) => structuredClone(a));

      await this.deletePageId(pageId);
      this.pushHistory({
        kind: 'delete-page',
        label: `delete page ${index + 1}`,
        time: Date.now(),
        pageIndex: index,
        pageId,
        pageBytes,
        anns,
      });
      this.mutated();
      this.set(this.derive());
    });
  }

  /** Remove a page (by stable id) plus its annotations; re-sync everything. */
  private async deletePageId(pageId: string): Promise<void> {
    if (!this.libDoc) return;
    const index = this.pageIds.indexOf(pageId);
    if (index === -1) return;
    this.pageIds.splice(index, 1);
    this.annotations.delete(pageId);
    this.libDoc.removePage(index);
    await this.resync(`Deleted page ${index + 1}`);
  }

  async movePage(fromIndex: number, toIndex: number): Promise<void> {
    return this.enqueue(async () => {
      if (!(await this.movePageRaw(fromIndex, toIndex))) return;
      this.pushHistory({
        kind: 'move-page',
        label: `move page ${fromIndex + 1} to ${toIndex + 1}`,
        time: Date.now(),
        from: fromIndex,
        to: toIndex,
      });
      this.mutated();
      this.set(this.derive());
    });
  }

  private async movePageRaw(fromIndex: number, toIndex: number): Promise<boolean> {
    if (!this.libDoc || this.state.phase !== 'ready') return false;
    const count = this.pageIds.length;
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= count || toIndex >= count) {
      return false;
    }
    // Rebuild via copyPages: remove+reinsert of the same page object is not
    // reliably supported by pdf-lib, copying into a fresh document is.
    const order = Array.from({ length: count }, (_, i) => i);
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved!);
    const [movedId] = this.pageIds.splice(fromIndex, 1);
    this.pageIds.splice(toIndex, 0, movedId!);

    const fresh = await PDFDocument.create();
    const copied = await fresh.copyPages(this.libDoc, order);
    for (const page of copied) fresh.addPage(page);
    this.libDoc = fresh;
    await this.resync(`Moved page ${fromIndex + 1} to position ${toIndex + 1}`);
    return true;
  }

  async insertBlankPageAfterCurrent(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.libDoc || this.state.phase !== 'ready') return;
      const index = this.state.currentPage;
      const source = this.libDoc.getPage(index);
      const { width, height } = source.getSize();
      const pageId = uid();
      await this.insertBlankPage(index + 1, pageId, width, height);
      this.pushHistory({
        kind: 'insert-blank',
        label: `insert blank page at ${index + 2}`,
        time: Date.now(),
        pageIndex: index + 1,
        pageId,
        width,
        height,
      });
      this.mutated();
      this.set(this.derive());
      this.goToPage(index + 1);
    });
  }

  private async insertBlankPage(pageIndex: number, pageId: string, width: number, height: number): Promise<void> {
    if (!this.libDoc) return;
    this.libDoc.insertPage(pageIndex, [width, height]);
    this.pageIds.splice(pageIndex, 0, pageId);
    await this.resync(`Inserted a blank page at position ${pageIndex + 1}`);
  }

  async mergePdf(file: OpenedFile): Promise<void> {
    return this.enqueue(async () => {
      if (!this.libDoc || this.state.phase !== 'ready') return;
      try {
        const sourceBytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
        const source = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
        const indices = source.getPageIndices();
        const copied = await this.libDoc.copyPages(source, indices);
        const newIds: string[] = [];
        for (const page of copied) {
          this.libDoc.addPage(page);
          const id = uid();
          this.pageIds.push(id);
          newIds.push(id);
        }
        await this.resync(`Merged ${indices.length} page${indices.length === 1 ? '' : 's'} from ${file.name}`);
        this.pushHistory({
          kind: 'merge',
          label: `merge ${indices.length} pages from ${file.name}`,
          time: Date.now(),
          pageIds: newIds,
          sourceBytes,
          sourceName: file.name,
        });
        this.mutated();
        this.set(this.derive());
      } catch (error) {
        this.status(`Merge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Split: export 0-based page indices as a new PDF file. */
  async exportPageRange(spec: string, indices: number[]): Promise<void> {
    if (!this.libDoc) return;
    const out = await PDFDocument.create();
    const copied = await out.copyPages(this.libDoc, indices);
    for (const page of copied) out.addPage(page);
    const bytes = await out.save();
    const base = (this.state.fileName ?? 'document').replace(/\.pdf$/i, '');
    const suggested = `${base}-pages-${spec.replace(/[^0-9,-]+/g, '')}.pdf`;
    await this.saveBytesAs(bytes, suggested, `Exported ${indices.length} page${indices.length === 1 ? '' : 's'}`);
  }

  // -------------------------------------------------------------------- OCR

  /** Render a page to an offscreen canvas at a fixed OCR scale and recognize. */
  private async ocrPageIndex(
    index: number,
    onProgress?: (fraction: number, status: string) => void,
  ): Promise<OcrPageResult> {
    const page = await this.getPdfPage(index);
    const ocrScale = 2;
    const viewport = page.getViewport({ scale: ocrScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    const task = page.render({ canvasContext: ctx, viewport });
    await task.promise;
    return recognizeCanvas(canvas, viewport, ({ progress, status }) => {
      onProgress?.(progress, status);
    });
  }

  private applyOcrResult(pageId: string, result: OcrPageResult): void {
    const existing = this.getAnnotations(pageId).find((a): a is OcrAnnotation => a.kind === 'ocr');
    const runs = result.words.map((w) => ({
      text: w.text,
      rect: w.rect,
      fontSize: w.fontSize,
    }));
    if (runs.length === 0) {
      if (existing) this.deleteAnnotation(existing.id);
      return;
    }
    if (existing) {
      this.updateAnnotation(existing.id, { runs });
    } else {
      this.addAnnotation({
        id: uid(),
        pageId,
        kind: 'ocr',
        color: '#4f8cff',
        runs,
      });
    }
    // Invalidate search cache so the next query sees OCR text. Base pdf.js
    // text stays cached; getTextItems merges OCR on the fly.
    this.lastSearchQuery = '';
  }

  async runOcrCurrentPage(): Promise<void> {
    if (this.state.phase !== 'ready' || this.state.ocrProgress) return;
    const index = this.state.currentPage;
    const pageId = this.pageIds[index];
    if (!pageId) return;
    this.set({
      ocrProgress: {
        mode: 'page',
        current: 1,
        total: 1,
        pageFraction: 0,
        label: `OCR page ${index + 1}…`,
      },
      statusMessage: `OCR page ${index + 1}…`,
    });
    try {
      const result = await this.ocrPageIndex(index, (fraction, status) => {
        this.set({
          ocrProgress: {
            mode: 'page',
            current: 1,
            total: 1,
            pageFraction: fraction,
            label: status,
          },
        });
      });
      this.applyOcrResult(pageId, result);
      this.set({ ocrProgress: null });
      this.status(
        result.words.length > 0
          ? `OCR page ${index + 1}: ${result.words.length} word${result.words.length === 1 ? '' : 's'}`
          : `OCR page ${index + 1}: no text found`,
      );
    } catch (error) {
      this.set({ ocrProgress: null });
      this.status(`OCR failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async runOcrDocument(): Promise<void> {
    if (this.state.phase !== 'ready' || this.state.ocrProgress) return;
    const total = this.state.pageCount;
    this.set({
      ocrProgress: {
        mode: 'document',
        current: 0,
        total,
        pageFraction: 0,
        label: `OCR document (0/${total})…`,
      },
      statusMessage: `OCR document (0/${total})…`,
    });
    let words = 0;
    try {
      for (let index = 0; index < total; index += 1) {
        const pageId = this.pageIds[index];
        if (!pageId) continue;
        this.set({
          ocrProgress: {
            mode: 'document',
            current: index + 1,
            total,
            pageFraction: 0,
            label: `OCR page ${index + 1}/${total}…`,
          },
          statusMessage: `OCR page ${index + 1}/${total}…`,
        });
        const result = await this.ocrPageIndex(index, (fraction) => {
          this.set({
            ocrProgress: {
              mode: 'document',
              current: index + 1,
              total,
              pageFraction: fraction,
              label: `OCR page ${index + 1}/${total}…`,
            },
          });
        });
        this.applyOcrResult(pageId, result);
        words += result.words.length;
      }
      this.set({ ocrProgress: null });
      this.status(`OCR complete: ${words} word${words === 1 ? '' : 's'} across ${total} pages`);
    } catch (error) {
      this.set({ ocrProgress: null });
      this.status(`OCR failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------- signature

  /**
   * Place a signature annotation on a page. `anchor` is the click point in
   * PDF user space (top-left of the image box); default size ~140×48 pt.
   */
  placeSignature(
    pageId: string,
    imageDataUrl: string,
    anchor: { x: number; y: number },
    opts?: { w?: number; h?: number; select?: boolean },
  ): string {
    const w = opts?.w ?? 140;
    const h = opts?.h ?? 48;
    const ann: SignatureAnnotation = {
      id: uid(),
      pageId,
      kind: 'signature',
      color: '#111827',
      imageDataUrl,
      rect: { x: anchor.x, y: anchor.y - h, w, h },
    };
    this.addAnnotation(ann);
    if (opts?.select !== false) {
      this.set({ selectedAnnotationId: ann.id, tool: 'select', pendingSignatureDataUrl: null });
    }
    return ann.id;
  }

  /** Stamp the same signature image onto every page (or a page-index list). */
  stampSignatureOnPages(imageDataUrl: string, pageIndices?: number[]): number {
    const indices =
      pageIndices ?? Array.from({ length: this.state.pageCount }, (_, i) => i);
    let placed = 0;
    let lastId: string | null = null;
    for (const index of indices) {
      const pageId = this.pageIds[index];
      const info = this.pageInfos[index];
      if (!pageId || !info) continue;
      const w = 140;
      const h = 48;
      const margin = 36;
      lastId = this.placeSignature(
        pageId,
        imageDataUrl,
        {
          x: Math.max(margin, info.width - w - margin),
          y: margin + h,
        },
        { w, h, select: false },
      );
      placed += 1;
    }
    this.set({
      selectedAnnotationId: lastId,
      tool: 'select',
      pendingSignatureDataUrl: null,
    });
    this.status(`Stamped signature on ${placed} page${placed === 1 ? '' : 's'}`);
    return placed;
  }

  // ------------------------------------------------------------------ saving

  private anyCjkText(): boolean {
    for (const list of this.annotations.values()) {
      for (const ann of list) {
        if ((ann.kind === 'text' || ann.kind === 'note') && needsCjk(ann.text)) return true;
        if (ann.kind === 'ocr' && ann.runs.some((r) => needsCjk(r.text))) return true;
      }
    }
    return false;
  }

  private async currentFlattenedBytes(): Promise<{ bytes: Uint8Array; degradedCjk: boolean }> {
    if (!this.bytes) throw new Error('No document open');
    // Only wait on the font when the document actually contains CJK text;
    // the fetch normally finished long ago in the background.
    const cjkFontBytes = this.anyCjkText() ? (await loadCjkFont()).bytes : null;
    return flattenAnnotations(this.bytes, this.annotations, this.pageIds, { cjkFontBytes });
  }

  private async saveBytesAs(bytes: Uint8Array, suggestedName: string, doneMessage: string): Promise<void> {
    const chosen = await this.platform.savePdfDialog(suggestedName);
    if (chosen) {
      await this.platform.writeFile(chosen, bytes);
      this.status(`${doneMessage}: ${chosen}`);
    } else if (!this.isElectron) {
      // Browser fallback: no native dialog, download with the suggested name.
      await this.platform.writeFile(suggestedName, bytes);
      this.status(doneMessage);
    } else {
      this.status('Save cancelled');
    }
  }

  private get isElectron(): boolean {
    return typeof window !== 'undefined' && 'pdfEditor' in window;
  }

  /** Pin the current revision as the saved baseline (dirty becomes false). */
  private markSaved(): void {
    this.savedRevision = this.revision;
    this.set(this.derive());
  }

  async save(saveAs = false): Promise<void> {
    if (this.state.phase !== 'ready') return;
    try {
      this.set({ statusMessage: 'Saving...' });
      const flattened = await this.currentFlattenedBytes();
      const bytes = flattened.bytes;
      const cjkNote = flattened.degradedCjk
        ? ' — CJK font unavailable, non-Latin text saved as "?"'
        : '';
      if (!saveAs && this.filePath) {
        await this.platform.writeFile(this.filePath, bytes);
        this.markSaved();
        this.status(`Saved ${this.state.fileName ?? ''} (annotations flattened)${cjkNote}`);
        return;
      }
      const base = (this.state.fileName ?? 'document').replace(/\.pdf$/i, '');
      const suggested = saveAs ? `${base}-edited.pdf` : `${base}.pdf`;
      const chosen = await this.platform.savePdfDialog(suggested);
      if (chosen) {
        await this.platform.writeFile(chosen, bytes);
        this.filePath = chosen;
        this.markSaved();
        this.set({ fileName: chosen.split(/[\\/]/).pop() ?? chosen });
        this.status(`Saved ${chosen}${cjkNote}`);
      } else if (!this.isElectron) {
        await this.platform.writeFile(suggested, bytes);
        this.markSaved();
        this.status(`Downloaded ${suggested}${cjkNote}`);
      } else {
        this.status('Save cancelled');
      }
    } catch (error) {
      this.status(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
