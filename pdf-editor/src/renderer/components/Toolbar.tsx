import { useEffect, useRef } from 'react';
import { useEditorState, useStore } from '../state/editor';
import {
  IconChevronDown,
  IconChevronUp,
  IconFitPage,
  IconFitWidth,
  IconMerge,
  IconMinus,
  IconOcr,
  IconOpen,
  IconPlus,
  IconRedo,
  IconSave,
  IconSaveAs,
  IconSearch,
  IconSplit,
  IconUndo,
} from './icons';

const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300, 400];

export function Toolbar({ onSplit }: { onSplit: () => void }) {
  const store = useStore();
  const state = useEditorState();
  const ready = state.phase === 'ready';
  const ocrBusy = state.ocrProgress !== null;
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = () => searchRef.current?.select();
    window.addEventListener('vellum:focus-search', focusSearch);
    return () => window.removeEventListener('vellum:focus-search', focusSearch);
  }, []);

  const zoomValue = state.fitMode === 'custom' ? String(Math.round(state.scale * 100)) : state.fitMode;
  const matchCount = state.searchMatches.length;

  const onPageInput = (value: string) => {
    const page = parseInt(value, 10);
    if (Number.isFinite(page)) store.goToPage(page - 1);
  };

  return (
    <header className="toolbar main-toolbar">
      <div className="toolbar-group">
        <button type="button" className="btn" onClick={() => void store.openDialog()} title="Open PDF (Ctrl+O)">
          <IconOpen />
          <span>Open</span>
        </button>
        <button
          type="button"
          className="btn"
          disabled={!ready}
          onClick={() => void store.save(false)}
          title="Save changes into the file (Ctrl+S)"
        >
          <IconSave />
          <span>Save{state.dirty ? ' *' : ''}</span>
        </button>
        <button
          type="button"
          className="btn"
          disabled={!ready}
          onClick={() => void store.save(true)}
          title="Save a copy (Ctrl+Shift+S)"
        >
          <IconSaveAs />
          <span>Save as</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          type="button"
          className="btn icon-only"
          disabled={!state.canUndo}
          onClick={() => void store.undo()}
          title="Undo (Ctrl+Z)"
        >
          <IconUndo />
        </button>
        <button
          type="button"
          className="btn icon-only"
          disabled={!state.canRedo}
          onClick={() => void store.redo()}
          title="Redo (Ctrl+Shift+Z or Ctrl+Y)"
        >
          <IconRedo />
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button type="button" className="btn" disabled={!ready} onClick={() => void store.mergeDialog()} title="Append another PDF to this document">
          <IconMerge />
          <span>Merge</span>
        </button>
        <button type="button" className="btn" disabled={!ready} onClick={onSplit} title="Export a page range as a new PDF">
          <IconSplit />
          <span>Split</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          type="button"
          className="btn"
          disabled={!ready || ocrBusy}
          onClick={() => void store.runOcrCurrentPage()}
          title="OCR current page (Chinese + English)"
        >
          <IconOcr />
          <span>{ocrBusy && state.ocrProgress?.mode === 'page' ? 'OCR…' : 'OCR page'}</span>
        </button>
        <button
          type="button"
          className="btn"
          disabled={!ready || ocrBusy}
          onClick={() => void store.runOcrDocument()}
          title="OCR every page (Chinese + English)"
        >
          <IconOcr />
          <span>{ocrBusy && state.ocrProgress?.mode === 'document' ? `OCR ${state.ocrProgress.current}/${state.ocrProgress.total}` : 'OCR all'}</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className={`toolbar-group search-group${ready ? '' : ' disabled'}`}>
        <IconSearch className="search-icon" />
        <input
          id="search-input"
          ref={searchRef}
          type="text"
          placeholder="Search text..."
          disabled={!ready}
          value={state.searchQuery}
          onChange={(e) => store.setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) store.prevMatch();
              else void store.runSearch();
            } else if (e.key === 'Escape') {
              store.clearSearch();
              e.currentTarget.blur();
            }
          }}
        />
        {state.searchQuery && (
          <span className="search-count">
            {state.searching ? '...' : matchCount > 0 ? `${state.searchActive + 1}/${matchCount}` : '0/0'}
          </span>
        )}
        <button type="button" className="btn icon-only" disabled={!ready || matchCount === 0} onClick={() => store.prevMatch()} title="Previous match (Shift+Enter)">
          <IconChevronUp />
        </button>
        <button type="button" className="btn icon-only" disabled={!ready || matchCount === 0} onClick={() => store.nextMatch()} title="Next match (Enter)">
          <IconChevronDown />
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        <button type="button" className="btn icon-only" disabled={!ready} onClick={() => store.zoomOut()} title="Zoom out (Ctrl+-)">
          <IconMinus />
        </button>
        <select
          className="zoom-select"
          disabled={!ready}
          value={zoomValue}
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'width' || value === 'page') store.setFitMode(value);
            else store.setScalePercent(parseInt(value, 10));
          }}
          title="Zoom level"
        >
          <option value="width">Fit width</option>
          <option value="page">Fit page</option>
          {ZOOM_PRESETS.map((preset) => (
            <option key={preset} value={String(preset)}>
              {preset}%
            </option>
          ))}
          {state.fitMode === 'custom' &&
            !ZOOM_PRESETS.includes(Math.round(state.scale * 100)) && (
              <option value={String(Math.round(state.scale * 100))}>
                {Math.round(state.scale * 100)}%
              </option>
            )}
        </select>
        <button type="button" className="btn icon-only" disabled={!ready} onClick={() => store.zoomIn()} title="Zoom in (Ctrl++)">
          <IconPlus />
        </button>
        <button
          type="button"
          className={`btn icon-only${state.fitMode === 'width' ? ' active' : ''}`}
          disabled={!ready}
          onClick={() => store.setFitMode('width')}
          title="Fit width"
        >
          <IconFitWidth />
        </button>
        <button
          type="button"
          className={`btn icon-only${state.fitMode === 'page' ? ' active' : ''}`}
          disabled={!ready}
          onClick={() => store.setFitMode('page')}
          title="Fit whole page"
        >
          <IconFitPage />
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group page-nav">
        <input
          type="number"
          min={1}
          max={state.pageCount}
          disabled={!ready}
          value={ready ? state.currentPage + 1 : ''}
          onChange={(e) => onPageInput(e.target.value)}
          onFocus={(e) => e.target.select()}
          title="Current page"
        />
        <span className="page-total">/ {state.pageCount || '–'}</span>
      </div>
    </header>
  );
}
