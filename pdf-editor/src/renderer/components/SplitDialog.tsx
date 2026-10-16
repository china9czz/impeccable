import { useEffect, useRef, useState } from 'react';
import { useEditorState, useStore } from '../state/editor';
import { parsePageRange } from '../pdfcore/coords';

export function SplitDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const state = useEditorState();
  const [spec, setSpec] = useState(`${state.currentPage + 1}-${state.pageCount}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    try {
      const indices = parsePageRange(spec, state.pageCount);
      setError(null);
      setBusy(true);
      await store.exportPageRange(spec, indices);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Split: export pages</h2>
        <p className="modal-hint">
          Pages to export, 1-based. Use commas and ranges, for example <code>1-3, 5</code>.
          The current document stays open and unchanged.
        </p>
        <input
          ref={inputRef}
          type="text"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder={`1-${state.pageCount}`}
        />
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Exporting...' : 'Export PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}
