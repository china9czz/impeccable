import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useEditorState, useStore } from './state/editor';
import { Toolbar } from './components/Toolbar';
import { ToolBar } from './components/AnnotationToolBar';
import { Sidebar } from './components/Sidebar';
import { PageView } from './components/PageView';
import { SplitDialog } from './components/SplitDialog';
import { IconFilePdf, IconOpen } from './components/icons';
import type { Tool } from './pdfcore/types';

const TOOL_HINTS: Record<Tool, string> = {
  select: 'Click an annotation to select it. Drag notes and text to move them. Double-click to edit.',
  highlight: 'Drag across the page to paint a highlight.',
  pen: 'Drag to draw freehand.',
  note: 'Click anywhere to place a note.',
  rect: 'Drag to draw a rectangle.',
  text: 'Click anywhere to add a text box.',
};

export default function App() {
  const store = useStore();
  const state = useEditorState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [splitOpen, setSplitOpen] = useState(false);

  // Track the page area's size so fit-width / fit-page can compute scale.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => store.setViewportSize(el.clientWidth, el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [store, state.phase]);

  // Honor imperative scroll requests (page nav, search jumps, thumbnails).
  useEffect(() => {
    if (!state.scrollTarget || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-page-index="${state.scrollTarget.page}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  }, [state.scrollTarget]);

  // Open a file passed on the command line (or the sample in web preview).
  useEffect(() => {
    void store.openInitial();
  }, [store]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void store.openDialog();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void store.save(e.shiftKey);
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        document.getElementById('search-input')?.focus();
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        store.zoomIn();
      } else if (mod && e.key === '-') {
        e.preventDefault();
        store.zoomOut();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        store.deleteSelectedAnnotation();
      } else if (e.key === 'Escape' && !typing) {
        store.selectAnnotation(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const probe = el.scrollTop + el.clientHeight * 0.35;
    const pages = el.querySelectorAll<HTMLElement>('[data-page-index]');
    for (const page of pages) {
      if (page.offsetTop + page.offsetHeight > probe) {
        const index = Number(page.dataset.pageIndex);
        if (Number.isFinite(index)) store.setCurrentPage(index);
        break;
      }
    }
  };

  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && /\.pdf$/i.test(file.name)) void store.openDroppedFile(file);
  };

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <Toolbar onSplit={() => setSplitOpen(true)} />
      <ToolBar />
      <div className="app-body">
        <Sidebar />
        {state.phase === 'ready' ? (
          <div className="page-area" ref={scrollRef} onScroll={onScroll}>
            <div className="page-column">
              {Array.from({ length: state.pageCount }, (_, index) => (
                <PageView key={`${state.docVersion}:${index}`} index={index} />
              ))}
            </div>
          </div>
        ) : (
          <div className="page-area empty-area" ref={scrollRef}>
            <EmptyState />
          </div>
        )}
      </div>
      <StatusBar />
      {splitOpen && <SplitDialog onClose={() => setSplitOpen(false)} />}
    </div>
  );
}

function EmptyState() {
  const store = useStore();
  const state = useEditorState();
  return (
    <div className="empty-state">
      <IconFilePdf className="empty-icon" />
      {state.phase === 'loading' ? (
        <>
          <h1>Opening document...</h1>
          <p>This usually takes a moment.</p>
        </>
      ) : (
        <>
          <h1>Vellum PDF</h1>
          <p>Open a PDF to view, search, annotate and edit it.</p>
          {state.phase === 'error' && <p className="empty-error">{state.errorMessage}</p>}
          <button type="button" className="btn primary large" onClick={() => void store.openDialog()}>
            <IconOpen />
            <span>Open PDF</span>
          </button>
          <p className="empty-hint">or drop a PDF file anywhere in this window</p>
        </>
      )}
    </div>
  );
}

function StatusBar() {
  const state = useEditorState();
  return (
    <footer className="status-bar">
      <span className="status-file">
        {state.fileName ?? 'No document'}
        {state.dirty && <span className="dirty-dot" title="Unsaved changes" />}
      </span>
      <span className="status-message">{state.statusMessage}</span>
      <span className="status-right">
        {state.cjkFontStatus === 'loading' && (
          <span className="status-meta font-loading">Loading CJK font…</span>
        )}
        {state.cjkFontStatus === 'error' && (
          <span className="status-meta font-error" title="Chinese/Japanese/Korean text will be saved as '?' — the bundled font failed to load.">
            CJK font unavailable
          </span>
        )}
        {state.phase === 'ready' && (
          <>
            <span className="status-hint">{TOOL_HINTS[state.tool]}</span>
            <span className="status-meta">
              Page {state.currentPage + 1} of {state.pageCount} · {Math.round(state.scale * 100)}%
            </span>
          </>
        )}
      </span>
    </footer>
  );
}
