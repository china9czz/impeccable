import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function icon(paths: ReactNode) {
  return function Icon(props: IconProps) {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const IconOpen = icon(
  <>
    <path d="M2 4.5v8h12v-7H7.4L5.9 4.5H2Z" />
    <path d="M2 6.5V4.5" />
  </>,
);

export const IconSave = icon(
  <>
    <path d="M3 2.5h7.5L13 5v8H3v-10.5Z" />
    <path d="M5.5 2.5v3h4.5v-3" />
    <path d="M5.5 13V9.5h5V13" />
  </>,
);

export const IconSaveAs = icon(
  <>
    <path d="M8 2.5v7" />
    <path d="M5 6.5 8 9.5l3-3" />
    <path d="M3 11v2.5h10V11" />
  </>,
);

export const IconMerge = icon(
  <>
    <path d="M2 3.5h3.2L11 8l-5.8 4.5H2" />
    <path d="M9 5.5 11.5 8 9 10.5" />
    <path d="M11.5 8H14" />
  </>,
);

export const IconSplit = icon(
  <>
    <circle cx="4" cy="4" r="1.8" />
    <circle cx="4" cy="12" r="1.8" />
    <path d="M5.5 5.3 13.5 12.5" />
    <path d="M5.5 10.7 13.5 3.5" />
  </>,
);

export const IconSearch = icon(
  <>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 14 14" />
  </>,
);

export const IconChevronUp = icon(<path d="m4 10 4-4 4 4" />);
export const IconChevronDown = icon(<path d="m4 6 4 4 4-4" />);
export const IconMinus = icon(<path d="M3 8h10" />);
export const IconPlus = icon(
  <>
    <path d="M3 8h10" />
    <path d="M8 3v10" />
  </>,
);

export const IconFitPage = icon(
  <>
    <path d="M2.5 6V2.5H6" />
    <path d="M10 2.5h3.5V6" />
    <path d="M13.5 10v3.5H10" />
    <path d="M6 13.5H2.5V10" />
  </>,
);

export const IconFitWidth = icon(
  <>
    <path d="M2.5 8h11" />
    <path d="M5 5.5 2.5 8 5 10.5" />
    <path d="m11 5.5 2.5 2.5-2.5 2.5" />
  </>,
);

export const IconSelect = icon(<path d="M4.5 2.5l7 6-3.6.4-1.9 3.4L4.5 2.5Z" />);

export const IconHighlight = icon(
  <>
    <path d="M3 11.5 9.5 5 11 6.5 4.5 13H3v-1.5Z" />
    <path d="m8.5 4 1.8-1.8 2.4 2.4L11 6.5" />
    <path d="M1.5 14.5h13" />
  </>,
);

export const IconPen = icon(
  <>
    <path d="M2.5 13.5l.8-3L11 3l2 2-7.7 7.7-2.8.8Z" />
    <path d="m10 4 2 2" />
  </>,
);

export const IconNote = icon(
  <>
    <path d="M3 2.5h10v8l-3 3H3v-11Z" />
    <path d="M10 13.5v-3h3" />
  </>,
);

export const IconRect = icon(<rect x="2.5" y="3.5" width="11" height="9" rx="0.5" />);

export const IconText = icon(
  <>
    <path d="M3 3.5h10" />
    <path d="M8 3.5v9" />
    <path d="M5.5 12.5h5" />
  </>,
);

export const IconRotateCcw = icon(
  <>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
    <path d="M2.5 1.5v3h3" />
  </>,
);

export const IconUndo = icon(
  <>
    <path d="M6.5 3.5 3 7l3.5 3.5" />
    <path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H7" />
  </>,
);

export const IconRedo = icon(
  <>
    <path d="m9.5 3.5 3.5 3.5-3.5 3.5" />
    <path d="M13 7H6.5a3.5 3.5 0 0 0 0 7H9" />
  </>,
);

export const IconRotateCw = icon(
  <>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 1.5v3h-3" />
  </>,
);

export const IconPagePlus = icon(
  <>
    <path d="M3.5 1.5h5.5L13 5.5V14.5H3.5v-13Z" />
    <path d="M9 1.5V5.5H13" />
    <path d="M8 7.5v4.5" />
    <path d="M5.75 9.75h4.5" />
  </>,
);

export const IconTrash = icon(
  <>
    <path d="M3 4.5h10" />
    <path d="M6.5 4.5V3h3v1.5" />
    <path d="m4.5 4.5.6 8.5h5.8l.6-8.5" />
  </>,
);

export const IconX = icon(
  <>
    <path d="m4 4 8 8" />
    <path d="m12 4-8 8" />
  </>,
);

export const IconGrip = icon(
  <>
    <circle cx="5.5" cy="4" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="4" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="5.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="5.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
  </>,
);

export const IconFilePdf = icon(
  <>
    <path d="M3.5 1.5h5.5L13 5.5V14.5H3.5v-13Z" />
    <path d="M9 1.5V5.5H13" />
    <path d="M5.5 9.5v3M5.5 9.5h1.6a1.2 1.2 0 0 1 0 2.4H5.5" strokeWidth="1.1" />
  </>,
);
