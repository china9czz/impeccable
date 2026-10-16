import { useEffect, useRef, useState } from 'react';
import { useEditorState, useStore } from '../state/editor';
import type { PageViewport, RenderTask } from '../pdfcore/pdfjs';
import type { PdfRect } from '../pdfcore/types';
import { AnnotationLayer } from './AnnotationLayer';

function isRenderCancel(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'RenderingCancelledException'
  );
}

export interface VpBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function viewportRect(viewport: PageViewport, rect: PdfRect): VpBox {
  const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
  const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** VpBox uses HTML-style left/top; SVG rect elements want x/y. */
export function boxToSvg(box: VpBox): { x: number; y: number; width: number; height: number } {
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

export function PageView({ index }: { index: number }) {
  const store = useStore();
  const state = useEditorState();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [viewport, setViewport] = useState<PageViewport | null>(null);

  const info = store.getPageInfo(index);
  const scale = state.scale;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setVisible(true);
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !info) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;
        task = await store.beginRender(index, canvas, scale);
        await task.promise;
        if (cancelled) return;
        setViewport(await store.getViewport(index, scale));
        store.markFirstRender();
      } catch (error) {
        if (!cancelled && !isRenderCancel(error)) console.error('Page render failed', error);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, scale, state.docVersion, index, info, store]);

  if (!info) return null;
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));

  return (
    <div className="page-slot" data-page-index={index}>
      <div ref={wrapRef} className="page-wrap" style={{ width, height }}>
        <canvas ref={canvasRef} className="page-canvas" />
        {viewport && <SearchHighlights pageIndex={index} viewport={viewport} />}
        {viewport && (
          <AnnotationLayer pageId={info.id} viewport={viewport} scale={scale} />
        )}
        <div className="page-chip">{index + 1}</div>
      </div>
    </div>
  );
}

function SearchHighlights({ pageIndex, viewport }: { pageIndex: number; viewport: PageViewport }) {
  const state = useEditorState();
  const active = state.searchMatches[state.searchActive];
  const matches = state.searchMatches.filter((m) => m.pageIndex === pageIndex);
  if (matches.length === 0) return null;

  return (
    <div className="search-layer">
      {matches.flatMap((match, mi) =>
        match.rects.map((rect, ri) => (
          <div
            key={`${mi}:${ri}`}
            className={`search-hit${match === active ? ' active' : ''}`}
            style={viewportRect(viewport, rect)}
          />
        )),
      )}
    </div>
  );
}
