/**
 * Domain types for the editor. Annotations are stored in PDF user-space
 * coordinates (bottom-left origin, unrotated page space, 1/72 inch units),
 * so they are resolution independent and survive zoom and rotation.
 */

export type Tool = 'select' | 'highlight' | 'pen' | 'note' | 'rect' | 'text' | 'signature';

export interface PdfRect {
  x: number;
  /** Bottom edge in PDF user space. */
  y: number;
  w: number;
  h: number;
}

interface AnnotationBase {
  id: string;
  pageId: string;
  /** Hex color, e.g. "#ffd400". */
  color: string;
}

export interface RectAnnotation extends AnnotationBase {
  kind: 'rect' | 'highlight';
  rect: PdfRect;
  strokeWidth: number;
}

export interface PenAnnotation extends AnnotationBase {
  kind: 'pen';
  /** Flat point list [x1, y1, x2, y2, ...] in PDF user space. */
  points: number[];
  strokeWidth: number;
}

export interface NoteAnnotation extends AnnotationBase {
  kind: 'note';
  /** Anchor point; y is the top edge of the note marker. */
  x: number;
  y: number;
  text: string;
}

export interface TextAnnotation extends AnnotationBase {
  kind: 'text';
  /** Top-left of the first line. */
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

/** One OCR word/run produced by tesseract; flattened as invisible searchable text. */
export interface OcrRun {
  text: string;
  rect: PdfRect;
  fontSize: number;
}

export interface OcrAnnotation extends AnnotationBase {
  kind: 'ocr';
  runs: OcrRun[];
}

/** Drawn or uploaded signature image, placed as a resizable stamp. */
export interface SignatureAnnotation extends AnnotationBase {
  kind: 'signature';
  rect: PdfRect;
  /** PNG (or rasterized SVG) data URL. */
  imageDataUrl: string;
}

export type Annotation =
  | RectAnnotation
  | PenAnnotation
  | NoteAnnotation
  | TextAnnotation
  | OcrAnnotation
  | SignatureAnnotation;

/** Editable annotation fields (Omit over the union collapses to shared keys only). */
export type AnnotationPatch = Partial<{
  color: string;
  strokeWidth: number;
  rect: PdfRect;
  points: number[];
  x: number;
  y: number;
  text: string;
  fontSize: number;
  runs: OcrRun[];
  imageDataUrl: string;
}>;

export interface SearchMatch {
  pageId: string;
  pageIndex: number;
  /** One rect per text item the match spans, in PDF user space. */
  rects: PdfRect[];
}

export interface PageInfo {
  id: string;
  /** Display-space size at scale 1 (page rotation applied). */
  width: number;
  height: number;
}

export type FitMode = 'width' | 'page' | 'custom';
