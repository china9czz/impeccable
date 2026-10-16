import { useEditorState, useStore } from '../state/editor';
import type { Tool } from '../pdfcore/types';
import {
  IconHighlight,
  IconNote,
  IconPagePlus,
  IconPen,
  IconRect,
  IconRotateCcw,
  IconRotateCw,
  IconSelect,
  IconText,
  IconTrash,
} from './icons';

const TOOLS: { id: Tool; label: string; icon: typeof IconPen }[] = [
  { id: 'select', label: 'Select', icon: IconSelect },
  { id: 'highlight', label: 'Highlight', icon: IconHighlight },
  { id: 'pen', label: 'Pen', icon: IconPen },
  { id: 'note', label: 'Note', icon: IconNote },
  { id: 'rect', label: 'Rectangle', icon: IconRect },
  { id: 'text', label: 'Text', icon: IconText },
];

const COLOR_PRESETS = ['#ffd400', '#ff5a52', '#34c759', '#4f8cff', '#b16bff', '#111827'];
const STROKE_WIDTHS = [1, 2, 2.5, 4, 6, 8];
const FONT_SIZES = [10, 12, 14, 16, 20, 24, 32, 48];

export function ToolBar() {
  const store = useStore();
  const state = useEditorState();
  const ready = state.phase === 'ready';
  const selected = store.getSelectedAnnotation();

  const strokeToolActive =
    state.tool === 'pen' || state.tool === 'rect' ||
    (selected !== null && (selected.kind === 'pen' || selected.kind === 'rect'));
  const fontToolActive = state.tool === 'text' || (selected !== null && selected.kind === 'text');
  const currentStroke = selected && (selected.kind === 'pen' || selected.kind === 'rect')
    ? selected.strokeWidth
    : state.strokeWidth;
  const currentFontSize = selected && selected.kind === 'text' ? selected.fontSize : state.fontSize;
  const currentColor = selected ? selected.color : state.color;

  return (
    <div className="toolbar tools-toolbar">
      <div className="toolbar-group" role="radiogroup" aria-label="Annotation tools">
        {TOOLS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`btn icon-only${state.tool === id ? ' active' : ''}`}
            disabled={!ready}
            onClick={() => store.setTool(id)}
            title={label}
            aria-pressed={state.tool === id}
          >
            <Icon />
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group color-group" aria-label="Color">
        {COLOR_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            className={`color-swatch${currentColor === color ? ' active' : ''}`}
            style={{ backgroundColor: color }}
            disabled={!ready}
            onClick={() => store.setColor(color)}
            title={color}
          />
        ))}
        <label className="color-custom" title="Custom color">
          <input
            type="color"
            disabled={!ready}
            value={currentColor}
            onChange={(e) => store.setColor(e.target.value)}
          />
          <span className="color-custom-ring" style={{ backgroundColor: currentColor }} />
        </label>
      </div>

      {strokeToolActive && (
        <>
          <div className="toolbar-divider" />
          <div className="toolbar-group">
            <span className="control-label">Stroke</span>
            <select
              className="control-select"
              disabled={!ready}
              value={String(currentStroke)}
              onChange={(e) => store.setStrokeWidth(parseFloat(e.target.value))}
            >
              {STROKE_WIDTHS.map((w) => (
                <option key={w} value={String(w)}>
                  {w} pt
                </option>
              ))}
              {!STROKE_WIDTHS.includes(currentStroke) && (
                <option value={String(currentStroke)}>{currentStroke} pt</option>
              )}
            </select>
          </div>
        </>
      )}

      {fontToolActive && (
        <>
          <div className="toolbar-divider" />
          <div className="toolbar-group">
            <span className="control-label">Size</span>
            <select
              className="control-select"
              disabled={!ready}
              value={String(currentFontSize)}
              onChange={(e) => store.setFontSize(parseFloat(e.target.value))}
            >
              {FONT_SIZES.map((s) => (
                <option key={s} value={String(s)}>
                  {s} pt
                </option>
              ))}
              {!FONT_SIZES.includes(currentFontSize) && (
                <option value={String(currentFontSize)}>{currentFontSize} pt</option>
              )}
            </select>
          </div>
        </>
      )}

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button type="button" className="btn icon-only" disabled={!ready} onClick={() => void store.rotateCurrentPage(-90)} title="Rotate page left">
          <IconRotateCcw />
        </button>
        <button type="button" className="btn icon-only" disabled={!ready} onClick={() => void store.rotateCurrentPage(90)} title="Rotate page right">
          <IconRotateCw />
        </button>
        <button type="button" className="btn icon-only" disabled={!ready} onClick={() => void store.insertBlankPageAfterCurrent()} title="Insert blank page after current">
          <IconPagePlus />
        </button>
        <button type="button" className="btn icon-only" disabled={!ready} onClick={() => void store.deleteCurrentPage()} title="Delete current page">
          <IconTrash />
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        <button
          type="button"
          className="btn danger"
          disabled={!ready || !state.selectedAnnotationId}
          onClick={() => store.deleteSelectedAnnotation()}
          title="Delete selected annotation (Delete)"
        >
          <IconTrash />
          <span>Delete</span>
        </button>
      </div>
    </div>
  );
}
