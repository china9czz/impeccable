import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/editor';
import {
  fileToPngDataUrl,
  loadSavedSignatures,
  persistSignature,
  removeSavedSignature,
  type SavedSignature,
} from '../pdfcore/signatures';

interface Props {
  onClose: () => void;
}

export function SignatureDialog({ onClose }: Props) {
  const store = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [saved, setSaved] = useState<SavedSignature[]>(() => loadSavedSignatures());
  const [error, setError] = useState<string | null>(null);
  const [hasStroke, setHasStroke] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const canvasPos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return [x, y];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    drawing.current = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = canvasPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const [x, y] = canvasPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasStroke(true);
  };

  const onPointerUp = () => {
    drawing.current = false;
  };

  const clearPad = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasStroke(false);
  };

  /** Trim white margins and return a transparent-background PNG. */
  const exportDrawn = (): string | null => {
    const canvas = canvasRef.current;
    if (!canvas || !hasStroke) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const { width, height } = canvas;
    const image = ctx.getImageData(0, 0, width, height);
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const r = image.data[i]!;
        const g = image.data[i + 1]!;
        const b = image.data[i + 2]!;
        // Non-white ink
        if (r < 250 || g < 250 || b < 250) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < minX) return null;
    const pad = 6;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad);
    maxY = Math.min(height - 1, maxY + pad);
    const tw = maxX - minX + 1;
    const th = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = tw;
    out.height = th;
    const octx = out.getContext('2d');
    if (!octx) return null;
    const cropped = ctx.getImageData(minX, minY, tw, th);
    // Make near-white pixels transparent so the stamp sits cleanly on the page.
    for (let i = 0; i < cropped.data.length; i += 4) {
      const r = cropped.data[i]!;
      const g = cropped.data[i + 1]!;
      const b = cropped.data[i + 2]!;
      if (r > 245 && g > 245 && b > 245) cropped.data[i + 3] = 0;
    }
    octx.putImageData(cropped, 0, 0);
    return out.toDataURL('image/png');
  };

  const useDataUrl = (dataUrl: string, remember: boolean) => {
    if (remember) setSaved(persistSignature({ name: 'Signature', dataUrl }));
    store.setPendingSignature(dataUrl);
    onClose();
  };

  const applyDrawn = (remember: boolean) => {
    const dataUrl = exportDrawn();
    if (!dataUrl) {
      setError('Draw a signature first');
      return;
    }
    useDataUrl(dataUrl, remember);
  };

  const onUpload = async (file: File | null) => {
    if (!file) return;
    try {
      setError(null);
      const dataUrl = await fileToPngDataUrl(file);
      useDataUrl(dataUrl, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stampAll = (dataUrl: string) => {
    store.stampSignatureOnPages(dataUrl);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal signature-modal"
        role="dialog"
        aria-label="Signature"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Electronic signature</h2>
        <p className="modal-hint">
          Draw below or upload a PNG/SVG. Then click a page to place it, or stamp every page at once.
          Signatures stay in this browser for reuse.
        </p>

        <canvas
          ref={canvasRef}
          className="signature-pad"
          width={520}
          height={160}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />

        <div className="modal-actions signature-actions">
          <button type="button" className="btn" onClick={clearPad}>
            Clear
          </button>
          <label className="btn" title="Upload PNG or SVG">
            Upload
            <input
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
              hidden
              onChange={(e) => void onUpload(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasStroke}
            onClick={() => applyDrawn(true)}
            title="Save to this browser and place on click"
          >
            Use &amp; remember
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!hasStroke}
            onClick={() => applyDrawn(false)}
          >
            Place on page
          </button>
        </div>

        {error && <p className="modal-error">{error}</p>}

        {saved.length > 0 && (
          <div className="signature-library">
            <h3>Saved this session</h3>
            <ul>
              {saved.map((sig) => (
                <li key={sig.id}>
                  <button
                    type="button"
                    className="signature-thumb"
                    onClick={() => useDataUrl(sig.dataUrl, false)}
                    title="Click a page to place"
                  >
                    <img src={sig.dataUrl} alt={sig.name} />
                  </button>
                  <div className="signature-thumb-actions">
                    <button type="button" className="mini-btn" onClick={() => stampAll(sig.dataUrl)}>
                      Stamp all
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setSaved(removeSavedSignature(sig.id))}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
