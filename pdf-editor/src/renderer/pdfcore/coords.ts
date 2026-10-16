/** Small pure helpers shared by the pdf core. */

export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match || !match[1]) return { r: 0, g: 0, b: 0 };
  const value = parseInt(match[1], 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

/**
 * StandardFonts.Helvetica is WinAnsi encoded, so drawing characters outside
 * Latin-1 throws. Replace them instead of crashing the save flow. Proper
 * Unicode support needs an embedded TTF; see README limitations.
 */
export function sanitizeWinAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

export function wrapText(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    while (line.length > maxChars) {
      const cut = line.lastIndexOf(' ', maxChars);
      out.push(line.slice(0, cut > 0 ? cut : maxChars));
      line = line.slice(cut > 0 ? cut + 1 : maxChars);
    }
    out.push(line);
  }
  return out;
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Parse a 1-based page range like "1-3, 5, 8-9" into sorted 0-based indices. */
export function parsePageRange(spec: string, pageCount: number): number[] {
  const indices = new Set<number>();
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Enter at least one page or range.');
  for (const part of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`Cannot parse "${part}". Use forms like 2 or 2-5.`);
    const start = parseInt(m[1]!, 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1 || end > pageCount || start > end) {
      throw new Error(`Range "${part}" is outside 1-${pageCount}.`);
    }
    for (let i = start; i <= end; i += 1) indices.add(i - 1);
  }
  return [...indices].sort((a, b) => a - b);
}
