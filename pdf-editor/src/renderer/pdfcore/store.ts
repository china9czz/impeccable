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
import { clamp, uid } from './coords';
import type { Annotation, AnnotationPatch, FitMode, PageInfo, SearchMatch, Tool } from './types';

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
};

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

  constructor(private readonly platform: PdfEditorApi) {}

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
      await this.reloadPageInfos();

      this.set({
        phase: 'ready',
        fileName: file.name,
        dirty: false,
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
    this.set(patch);
  }

  setColor(color: string): void {
    this.set({ color });
    const selected = this.getSelectedAnnotation();
    if (selected) this.updateAnnotation(selected.id, { color });
  }

  setStrokeWidth(strokeWidth: number): void {
    this.set({ strokeWidth });
    const selected = this.getSelectedAnnotation();
    if (selected && (selected.kind === 'pen' || selected.kind === 'rect')) {
      this.updateAnnotation(selected.id, { strokeWidth });
    }
  }

  setFontSize(fontSize: number): void {
    this.set({ fontSize });
    const selected = this.getSelectedAnnotation();
    if (selected && selected.kind === 'text') this.updateAnnotation(selected.id, { fontSize });
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
    this.set({
      annotationsVersion: this.state.annotationsVersion + 1,
      dirty: true,
    });
  }

  updateAnnotation(id: string, patch: AnnotationPatch): void {
    for (const list of this.annotations.values()) {
      const index = list.findIndex((a) => a.id === id);
      if (index === -1) continue;
      list[index] = { ...list[index]!, ...patch } as Annotation;
      this.set({
        annotationsVersion: this.state.annotationsVersion + 1,
        dirty: true,
      });
      return;
    }
  }

  deleteAnnotation(id: string): void {
    for (const [pageId, list] of this.annotations) {
      const index = list.findIndex((a) => a.id === id);
      if (index === -1) continue;
      list.splice(index, 1);
      if (list.length === 0) this.annotations.delete(pageId);
      this.set({
        annotationsVersion: this.state.annotationsVersion + 1,
        selectedAnnotationId: null,
        dirty: true,
      });
      this.status('Annotation deleted');
      return;
    }
  }

  deleteSelectedAnnotation(): void {
    if (this.state.selectedAnnotationId) this.deleteAnnotation(this.state.selectedAnnotationId);
  }

  // ------------------------------------------------------------------ search

  setSearchQuery(query: string): void {
    this.set({ searchQuery: query });
  }

  private async getTextItems(index: number): Promise<PageTextItem[]> {
    const cached = this.textCache.get(index);
    if (cached) return cached;
    const page = await this.getPdfPage(index);
    const items = await extractPageText(page);
    this.textCache.set(index, items);
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
      dirty: true,
    });
    // Rotations change page dimensions; re-fit when a fit mode is active.
    this.applyFitScale();
    this.status(message);
  }

  async rotateCurrentPage(deltaDegrees: number): Promise<void> {
    if (!this.libDoc || this.state.phase !== 'ready') return;
    const page = this.libDoc.getPage(this.state.currentPage);
    const next = (((page.getRotation().angle + deltaDegrees) % 360) + 360) % 360;
    page.setRotation(degrees(next));
    await this.resync(`Rotated page ${this.state.currentPage + 1} to ${next} deg`);
  }

  async deleteCurrentPage(): Promise<void> {
    if (!this.libDoc || this.state.phase !== 'ready') return;
    if (this.state.pageCount <= 1) {
      this.status('Cannot delete the last page');
      return;
    }
    const index = this.state.currentPage;
    const [removedId] = this.pageIds.splice(index, 1);
    if (removedId) this.annotations.delete(removedId);
    this.libDoc.removePage(index);
    await this.resync(`Deleted page ${index + 1}`);
  }

  async movePage(fromIndex: number, toIndex: number): Promise<void> {
    if (!this.libDoc || this.state.phase !== 'ready') return;
    const count = this.pageIds.length;
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= count || toIndex >= count) {
      return;
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
  }

  async insertBlankPageAfterCurrent(): Promise<void> {
    if (!this.libDoc || this.state.phase !== 'ready') return;
    const index = this.state.currentPage;
    const source = this.libDoc.getPage(index);
    const { width, height } = source.getSize();
    this.libDoc.insertPage(index + 1, [width, height]);
    this.pageIds.splice(index + 1, 0, uid());
    await this.resync(`Inserted a blank page after page ${index + 1}`);
    this.goToPage(index + 1);
  }

  async mergePdf(file: OpenedFile): Promise<void> {
    if (!this.libDoc || this.state.phase !== 'ready') return;
    try {
      const source = await PDFDocument.load(file.data, { ignoreEncryption: true });
      const indices = source.getPageIndices();
      const copied = await this.libDoc.copyPages(source, indices);
      for (const page of copied) {
        this.libDoc.addPage(page);
        this.pageIds.push(uid());
      }
      await this.resync(`Merged ${indices.length} page${indices.length === 1 ? '' : 's'} from ${file.name}`);
    } catch (error) {
      this.status(`Merge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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

  // ------------------------------------------------------------------ saving

  private async currentFlattenedBytes(): Promise<Uint8Array> {
    if (!this.bytes) throw new Error('No document open');
    return flattenAnnotations(this.bytes, this.annotations, this.pageIds);
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

  async save(saveAs = false): Promise<void> {
    if (this.state.phase !== 'ready') return;
    try {
      this.set({ statusMessage: 'Saving...' });
      const bytes = await this.currentFlattenedBytes();
      if (!saveAs && this.filePath) {
        await this.platform.writeFile(this.filePath, bytes);
        this.set({ dirty: false });
        this.status(`Saved ${this.state.fileName ?? ''} (annotations flattened)`);
        return;
      }
      const base = (this.state.fileName ?? 'document').replace(/\.pdf$/i, '');
      const suggested = saveAs ? `${base}-edited.pdf` : `${base}.pdf`;
      const chosen = await this.platform.savePdfDialog(suggested);
      if (chosen) {
        await this.platform.writeFile(chosen, bytes);
        this.filePath = chosen;
        this.set({
          dirty: false,
          fileName: chosen.split(/[\\/]/).pop() ?? chosen,
        });
        this.status(`Saved ${chosen}`);
      } else if (!this.isElectron) {
        await this.platform.writeFile(suggested, bytes);
        this.set({ dirty: false });
        this.status(`Downloaded ${suggested}`);
      } else {
        this.status('Save cancelled');
      }
    } catch (error) {
      this.status(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
