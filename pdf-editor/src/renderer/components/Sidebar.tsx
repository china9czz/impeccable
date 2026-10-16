import { useEffect, useRef, useState } from 'react';
import { useEditorState, useStore } from '../state/editor';
import type { RenderTask } from '../pdfcore/pdfjs';

const THUMB_WIDTH = 132;

export function Sidebar() {
  const state = useEditorState();
  const store = useStore();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  // Ref mirrors: drop handlers read them because React state lags behind
  // back-to-back dragstart/dragover/drop events (also matters for synthetic
  // DnD dispatched inside a single task).
  const dropGapRef = useRef<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  dropGapRef.current = dropGap;

  if (state.phase !== 'ready') {
    return (
      <aside className="sidebar sidebar-placeholder">
        <div className="sidebar-header">
          <span>Pages</span>
        </div>
        <div className="sidebar-empty-hint">Thumbnails appear here</div>
      </aside>
    );
  }

  const finishDrop = () => {
    const from = dragIndexRef.current ?? dragIndex;
    const gap = dropGapRef.current;
    if (from !== null && gap !== null) {
      const target = gap > from ? gap - 1 : gap;
      if (target !== from) void store.movePage(from, target);
    }
    dropGapRef.current = null;
    dragIndexRef.current = null;
    setDragIndex(null);
    setDropGap(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>Pages</span>
        <span className="sidebar-count">{state.pageCount}</span>
      </div>
      <div className="sidebar-list" onDragLeave={() => setDropGap(null)}>
        {Array.from({ length: state.pageCount }, (_, index) => (
          <div key={`${state.docVersion}:${index}`} className="thumb-slot">
            {dropGap === index && <div className="drop-line" />}
            <Thumbnail
              index={index}
              active={index === state.currentPage}
              dragging={dragIndex === index}
              onClick={() => store.goToPage(index)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(index));
                dragIndexRef.current = index;
                setDragIndex(index);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const before = e.clientY < rect.top + rect.height / 2;
                const gap = before ? index : index + 1;
                dropGapRef.current = gap;
                setDropGap(gap);
              }}
              onDrop={(e) => {
                e.preventDefault();
                finishDrop();
              }}
              onDragEnd={finishDrop}
            />
          </div>
        ))}
        {dropGap === state.pageCount && <div className="drop-line" />}
      </div>
    </aside>
  );
}

interface ThumbnailProps {
  index: number;
  active: boolean;
  dragging: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

function Thumbnail({ index, active, dragging, onClick, onDragStart, onDragOver, onDrop, onDragEnd }: ThumbnailProps) {
  const store = useStore();
  const state = useEditorState();
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setNear(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let task: RenderTask | null = null;
    void (async () => {
      const info = store.getPageInfo(index);
      const canvas = canvasRef.current;
      if (!info || !canvas) return;
      try {
        task = await store.beginRender(index, canvas, THUMB_WIDTH / info.width);
        await task.promise;
      } catch {
        // cancelled renders are expected during fast scrolling
      }
    })();
    return () => {
      task?.cancel();
    };
  }, [near, index, state.docVersion, store]);

  const info = store.getPageInfo(index);
  const aspect = info ? info.height / info.width : 11 / 8.5;

  return (
    <div
      ref={holderRef}
      className={`thumb${active ? ' active' : ''}${dragging ? ' dragging' : ''}`}
      draggable
      onClick={onClick}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title={`Page ${index + 1} (drag to reorder)`}
    >
      <div className="thumb-canvas-holder" style={{ width: THUMB_WIDTH, height: Math.round(THUMB_WIDTH * aspect) }}>
        <canvas ref={canvasRef} />
      </div>
      <div className="thumb-label">{index + 1}</div>
    </div>
  );
}
