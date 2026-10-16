/**
 * Session-scoped signature library (draw / upload). Persisted in localStorage
 * so the same stroke can be reused across documents until the browser profile
 * is cleared.
 */

const STORAGE_KEY = 'vellum.signatures.v1';
const MAX_SAVED = 8;

export interface SavedSignature {
  id: string;
  /** Optional label; defaults to a short timestamp. */
  name: string;
  /** PNG data URL. */
  dataUrl: string;
  createdAt: number;
}

export function loadSavedSignatures(): SavedSignature[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedSignature[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && typeof s.dataUrl === 'string' && s.dataUrl.startsWith('data:'));
  } catch {
    return [];
  }
}

export function persistSignature(entry: Omit<SavedSignature, 'id' | 'createdAt'> & { id?: string }): SavedSignature[] {
  const list = loadSavedSignatures().filter((s) => s.dataUrl !== entry.dataUrl);
  const saved: SavedSignature = {
    id: entry.id ?? `sig-${Date.now().toString(36)}`,
    name: entry.name || 'Signature',
    dataUrl: entry.dataUrl,
    createdAt: Date.now(),
  };
  list.unshift(saved);
  const trimmed = list.slice(0, MAX_SAVED);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded — keep going with the in-memory list for this session.
  }
  return trimmed;
}

export function removeSavedSignature(id: string): SavedSignature[] {
  const list = loadSavedSignatures().filter((s) => s.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
  return list;
}

/** Rasterize an SVG file (or SVG data URL) to a PNG data URL for pdf-lib. */
export async function svgToPngDataUrl(svgSource: string | ArrayBuffer, maxWidth = 600): Promise<string> {
  let svgText: string;
  if (typeof svgSource === 'string') {
    svgText = svgSource.startsWith('data:')
      ? await (await fetch(svgSource)).text()
      : svgSource;
  } else {
    svgText = new TextDecoder().decode(svgSource);
  }
  const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxWidth / Math.max(1, img.width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });
}

/** Read a File (PNG/JPEG/SVG) into a PNG data URL. */
export async function fileToPngDataUrl(file: File): Promise<string> {
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
    const text = await file.text();
    return svgToPngDataUrl(text);
  }
  const buffer = await file.arrayBuffer();
  const mime = file.type || 'image/png';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  const dataUrl = `data:${mime};base64,${btoa(binary)}`;
  if (/png/i.test(mime)) return dataUrl;
  // Normalize JPEG (and others) to PNG so flatten always uses embedPng.
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}
