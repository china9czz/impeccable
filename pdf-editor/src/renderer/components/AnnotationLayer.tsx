import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEditorState, useStore } from '../state/editor';
import type { PageViewport } from '../pdfcore/pdfjs';
import { uid } from '../pdfcore/coords';
import type {
  Annotation,
  NoteAnnotation,
  PdfRect,
  TextAnnotation,
} from '../pdfcore/types';
import { boxToSvg, viewportRect, type VpBox } from './PageView';

type Draft =
  | { kind: 'rect' | 'highlight'; startX: number; startY: number; rect: PdfRect }
  | { kind: 'pen'; points: number[] };

interface EditorSession {
  mode: 'create' | 'edit';
  kind: 'note' | 'text';
  id?: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

interface LayerProps {
  pageId: string;
  viewport: PageViewport;
  scale: number;
}

type DragState =
  | {
      mode: 'move-point';
      id: string;
      startX: number;
      startY: number;
      origX: number;
      origY: number;
    }
  | {
      mode: 'move-rect';
      id: string;
      startX: number;
      startY: number;
      orig: PdfRect;
    }
  | {
      mode: 'resize-signature';
      id: string;
      startX: number;
      startY: number;
      orig: PdfRect;
      corner: 'se';
    };

export function AnnotationLayer({ pageId, viewport, scale }: LayerProps) {
  const store = useStore();
  const state = useEditorState();
  const tool = state.tool;
  const anns = store.getAnnotations(pageId);
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    setDraft(null);
    setEditor(null);
  }, [tool]);

  const toPdf = (clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const bounds = svg.getBoundingClientRect();
    const point = viewport.convertToPdfPoint(clientX - bounds.left, clientY - bounds.top);
    return [point[0] ?? 0, point[1] ?? 0];
  };

  const toVp = (x: number, y: number): [number, number] => {
    const point = viewport.convertToViewportPoint(x, y);
    return [point[0] ?? 0, point[1] ?? 0];
  };

  // ------------------------------------------------------------ drawing

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || tool === 'select') return;
    const [x, y] = toPdf(e.clientX, e.clientY);
    if (tool === 'note' || tool === 'text') {
      setEditor({ mode: 'create', kind: tool, x, y, text: '', fontSize: state.fontSize });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (tool === 'pen') {
      setDraft({ kind: 'pen', points: [x, y] });
    } else if (tool === 'highlight' || tool === 'rect') {
      setDraft({ kind: tool, startX: x, startY: y, rect: { x, y, w: 0, h: 0 } });
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!draft) return;
    const [x, y] = toPdf(e.clientX, e.clientY);
    if (draft.kind === 'pen') {
      const pts = draft.points;
      const lastX = pts[pts.length - 2] ?? x;
      const lastY = pts[pts.length - 1] ?? y;
      if (Math.hypot(x - lastX, y - lastY) * scale < 2) return;
      setDraft({ kind: 'pen', points: [...pts, x, y] });
    } else {
      setDraft({
        ...draft,
        rect: {
          x: Math.min(draft.startX, x),
          y: Math.min(draft.startY, y),
          w: Math.abs(x - draft.startX),
          h: Math.abs(y - draft.startY),
        },
      });
    }
  };

  const onPointerUp = () => {
    if (!draft) return;
    if (draft.kind === 'pen') {
      if (draft.points.length >= 4) {
        store.addAnnotation({
          id: uid(),
          pageId,
          kind: 'pen',
          color: state.color,
          points: draft.points,
          strokeWidth: state.strokeWidth,
        });
      }
    } else if (draft.rect.w * scale > 4 && draft.rect.h * scale > 4) {
      store.addAnnotation({
        id: uid(),
        pageId,
        kind: draft.kind,
        color: state.color,
        rect: draft.rect,
        strokeWidth: state.strokeWidth,
      });
    }
    setDraft(null);
  };

  // ------------------------------------------------- select / move / edit

  const movableHandlers = (ann: NoteAnnotation | TextAnnotation) => ({
    onPointerDown: (e: ReactPointerEvent<Element>) => {
      if (tool !== 'select' || e.button !== 0) return;
      e.stopPropagation();
      store.selectAnnotation(ann.id);
      const [x, y] = toPdf(e.clientX, e.clientY);
      dragRef.current = {
        mode: 'move-point',
        id: ann.id,
        startX: x,
        startY: y,
        origX: ann.x,
        origY: ann.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<Element>) => {
      const drag = dragRef.current;
      if (!drag || drag.mode !== 'move-point' || drag.id !== ann.id) return;
      const [x, y] = toPdf(e.clientX, e.clientY);
      store.updateAnnotation(
        ann.id,
        {
          x: drag.origX + (x - drag.startX),
          y: drag.origY + (y - drag.startY),
        },
        { coalesceKey: `move:${ann.id}` },
      );
    },
    onPointerUp: () => {
      dragRef.current = null;
    },
    onDoubleClick: (e: ReactMouseEvent<Element>) => {
      if (tool !== 'select') return;
      e.stopPropagation();
      setEditor({
        mode: 'edit',
        kind: ann.kind,
        id: ann.id,
        x: ann.x,
        y: ann.y,
        text: ann.text,
        fontSize: ann.kind === 'text' ? ann.fontSize : 11,
      });
    },
  });

  const selectOnlyHandlers = (ann: Annotation) => ({
    onPointerDown: (e: ReactPointerEvent<Element>) => {
      if (tool !== 'select' || e.button !== 0) return;
      e.stopPropagation();
      store.selectAnnotation(ann.id);
    },
  });

  // ------------------------------------------------------------ rendering

  const selectionBox = (ann: Annotation): VpBox | null => {
    switch (ann.kind) {
      case 'rect':
      case 'highlight':
        return viewportRect(viewport, ann.rect);
      case 'ocr': {
        if (ann.runs.length === 0) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const run of ann.runs) {
          minX = Math.min(minX, run.rect.x);
          minY = Math.min(minY, run.rect.y);
          maxX = Math.max(maxX, run.rect.x + run.rect.w);
          maxY = Math.max(maxY, run.rect.y + run.rect.h);
        }
        return viewportRect(viewport, { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
      }
      case 'pen': {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i + 1 < ann.points.length; i += 2) {
          minX = Math.min(minX, ann.points[i]!);
          maxX = Math.max(maxX, ann.points[i]!);
          minY = Math.min(minY, ann.points[i + 1]!);
          maxY = Math.max(maxY, ann.points[i + 1]!);
        }
        if (!Number.isFinite(minX)) return null;
        return viewportRect(viewport, { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
      }
      case 'note': {
        const [vx, vy] = toVp(ann.x, ann.y);
        const size = 16 * scale;
        return { left: vx, top: vy, width: size, height: size };
      }
      case 'text': {
        const [vx, vy] = toVp(ann.x, ann.y);
        const lines = ann.text.split('\n');
        const longest = lines.reduce((m, line) => Math.max(m, line.length), 1);
        return {
          left: vx,
          top: vy,
          width: Math.max(24, longest * ann.fontSize * 0.58 * scale),
          height: lines.length * ann.fontSize * 1.25 * scale,
        };
      }
    }
  };

  const renderShape = (ann: Annotation) => {
    const selected = ann.id === state.selectedAnnotationId;
    const box = selected ? selectionBox(ann) : null;
    return (
      <g key={ann.id}>
        {ann.kind === 'highlight' && (
          <rect
            className="ann-shape"
            {...boxToSvg(viewportRect(viewport, ann.rect))}
            fill={ann.color}
            fillOpacity={0.35}
            {...selectOnlyHandlers(ann)}
          />
        )}
        {ann.kind === 'rect' && (
          <rect
            className="ann-shape"
            {...boxToSvg(viewportRect(viewport, ann.rect))}
            fill="none"
            stroke={ann.color}
            strokeWidth={ann.strokeWidth * scale}
            {...selectOnlyHandlers(ann)}
          />
        )}
        {ann.kind === 'pen' && (
          <polyline
            className="ann-shape"
            points={penViewportPoints(ann.points, toVp)}
            fill="none"
            stroke={ann.color}
            strokeWidth={ann.strokeWidth * scale}
            strokeLinecap="round"
            strokeLinejoin="round"
            {...selectOnlyHandlers(ann)}
          />
        )}
        {ann.kind === 'note' && (
          <g className="ann-shape" {...movableHandlers(ann)}>
            <NoteMarker x={toVp(ann.x, ann.y)[0]} y={toVp(ann.x, ann.y)[1]} scale={scale} />
          </g>
        )}
        {ann.kind === 'text' && (
          <text
            className="ann-shape ann-text"
            x={toVp(ann.x, ann.y)[0]}
            y={toVp(ann.x, ann.y)[1]}
            fill={ann.color}
            fontSize={ann.fontSize * scale}
            {...movableHandlers(ann)}
          >
            {ann.text.split('\n').map((line, i) => (
              <tspan
                key={i}
                x={toVp(ann.x, ann.y)[0]}
                dy={i === 0 ? ann.fontSize * scale * 0.8 : ann.fontSize * scale * 1.25}
              >
                {line || ' '}
              </tspan>
            ))}
          </text>
        )}
        {ann.kind === 'ocr' && (
          <g className="ann-shape ann-ocr" {...selectOnlyHandlers(ann)}>
            {ann.runs.map((run, i) => {
              const boxRun = boxToSvg(viewportRect(viewport, run.rect));
              return (
                <g key={i}>
                  <rect
                    {...boxRun}
                    fill="rgba(79, 140, 255, 0.12)"
                    stroke="rgba(79, 140, 255, 0.35)"
                    strokeWidth={0.75}
                  />
                  <text
                    x={boxRun.x}
                    y={boxRun.y + boxRun.height * 0.78}
                    fill="rgba(20, 40, 90, 0.55)"
                    fontSize={Math.max(7, run.fontSize * scale * 0.9)}
                    style={{ userSelect: 'text' }}
                  >
                    {run.text}
                  </text>
                </g>
              );
            })}
          </g>
        )}
        {box && ann.kind !== 'ocr' && (
          <rect
            className="selection-outline"
            x={(box.left as number) - 3}
            y={(box.top as number) - 3}
            width={(box.width as number) + 6}
            height={(box.height as number) + 6}
          />
        )}
      </g>
    );
  };

  const renderDraft = () => {
    if (!draft) return null;
    if (draft.kind === 'pen') {
      return (
        <polyline
          className="ann-draft"
          points={penViewportPoints(draft.points, toVp)}
          fill="none"
          stroke={state.color}
          strokeWidth={state.strokeWidth * scale}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    const box = boxToSvg(viewportRect(viewport, draft.rect));
    if (draft.kind === 'highlight') {
      return <rect className="ann-draft" {...box} fill={state.color} fillOpacity={0.35} />;
    }
    return (
      <rect
        className="ann-draft"
        {...box}
        fill="none"
        stroke={state.color}
        strokeWidth={state.strokeWidth * scale}
      />
    );
  };

  const commitEditor = (text: string) => {
    if (!editor) return;
    const trimmed = text.trim();
    if (editor.mode === 'create') {
      if (trimmed.length > 0) {
        if (editor.kind === 'note') {
          store.addAnnotation({
            id: uid(),
            pageId,
            kind: 'note',
            x: editor.x,
            y: editor.y,
            text: trimmed,
            color: '#ffd400',
          });
        } else {
          store.addAnnotation({
            id: uid(),
            pageId,
            kind: 'text',
            x: editor.x,
            y: editor.y,
            text: trimmed,
            color: state.color,
            fontSize: state.fontSize,
          });
        }
      }
    } else if (editor.id) {
      store.updateAnnotation(editor.id, { text: trimmed });
    }
    setEditor(null);
  };

  const [editorVx, editorVy] = editor ? toVp(editor.x, editor.y) : [0, 0];

  return (
    <div className="annotation-layer" data-tool={tool}>
      <svg
        ref={svgRef}
        className="annotation-svg"
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {anns.map(renderShape)}
        {renderDraft()}
      </svg>
      {editor && (
        <InlineTextEditor
          kind={editor.kind}
          initialText={editor.text}
          fontSize={editor.kind === 'text' ? editor.fontSize : 11}
          color={editor.kind === 'text' ? state.color : '#3a3200'}
          scale={scale}
          x={editorVx}
          y={editorVy}
          onCommit={commitEditor}
          onCancel={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function penViewportPoints(
  points: number[],
  toVp: (x: number, y: number) => [number, number],
): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const [vx, vy] = toVp(points[i]!, points[i + 1]!);
    parts.push(`${vx.toFixed(1)},${vy.toFixed(1)}`);
  }
  return parts.join(' ');
}

function NoteMarker({ x, y, scale }: { x: number; y: number; scale: number }) {
  const size = 15 * scale;
  const fold = 4.5 * scale;
  return (
    <g>
      <path
        d={`M ${x} ${y} h ${size} v ${size - fold} l ${-fold} ${fold} h ${-(size - fold)} Z`}
        fill="#ffd94d"
        stroke="#8a6d00"
        strokeWidth={Math.max(0.75, 0.8 * scale)}
      />
      <path
        d={`M ${x + size - fold} ${y + size - fold} v ${fold} h ${-fold}`}
        fill="none"
        stroke="#8a6d00"
        strokeWidth={Math.max(0.75, 0.8 * scale)}
      />
      <rect x={x - 3} y={y - 3} width={size + 6} height={size + 6} fill="transparent" />
    </g>
  );
}

interface InlineEditorProps {
  kind: 'note' | 'text';
  initialText: string;
  fontSize: number;
  color: string;
  scale: number;
  x: number;
  y: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

function InlineTextEditor({ kind, initialText, fontSize, color, scale, x, y, onCommit, onCancel }: InlineEditorProps) {
  const [text, setText] = useState(initialText);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
    if (initialText) areaRef.current?.select();
  }, [initialText]);

  return (
    <div className={`inline-editor ${kind}`} style={{ left: x, top: y }}>
      <textarea
        ref={areaRef}
        value={text}
        rows={kind === 'note' ? 4 : 2}
        placeholder={kind === 'note' ? 'Add a note...' : 'Type text...'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onCommit(text);
          }
        }}
        style={
          kind === 'text'
            ? { fontSize: Math.max(11, fontSize * scale * 0.85), color, lineHeight: 1.25 }
            : undefined
        }
      />
      <div className="inline-editor-actions">
        <button type="button" className="mini-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="mini-btn primary" onClick={() => onCommit(text)}>
          {kind === 'note' ? 'Save note' : 'Apply'}
        </button>
      </div>
    </div>
  );
}
