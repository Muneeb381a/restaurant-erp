import type { SVGProps } from 'react';

/**
 * A small hand-drawn icon set (24 px grid, 1.75 stroke, round caps) so the app needs no icon
 * library and no network. Icons always sit next to a text label; they never carry meaning alone.
 */
const PATHS = {
  tables: 'M4 6h16M4 6v12M20 6v12M7 18v-3M17 18v-3M4 11h16',
  bag: 'M6 8h12l-1 12H7L6 8ZM9 8V7a3 3 0 0 1 6 0v1',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6M9 12h6',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4ZM5 17a3 3 0 0 1 3-3h11',
  cash: 'M3 7h18v10H3V7ZM12 10v4M9.5 12h5M6 10v.01M18 14v.01',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 5v4M7 15v4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20a7.5 7.5 0 0 1 15 0',
  globe:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9S14.5 18.4 12 21c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z',
  logout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
  chevronRight: 'M9 5l7 7-7 7',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronDown: 'M5 9l7 7 7-7',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  more: 'M5 12v.01M12 12v.01M19 12v.01',
  printer: 'M7 9V4h10v5M7 17H5V9h14v8h-2M7 14h10v6H7v-6Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  alert: 'M12 4l9 16H3L12 4ZM12 10v4M12 17v.01',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7ZM10 20a2 2 0 0 0 4 0',
  bellOff: 'M6 9a6 6 0 0 1 9-5.2M18 9c0 4 1 5.5 1.7 6.4M4 16s2-1 2-7M10 20a2 2 0 0 0 4 0M4 4l16 16',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8v.01',
  flame: 'M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9Z',
  pause: 'M8 5v14M16 5v14',
  swap: 'M7 7h12l-3-3M17 17H5l3 3',
  merge: 'M6 4v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4M18 4v4a4 4 0 0 1-4 4',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4V8ZM4 8l8 4 8-4M12 12v8',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.4a7 7 0 0 0-2.2 1.3l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .9.1 1.3l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.4a7 7 0 0 0 2.2-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.9.1-1.3Z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 22,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 rtl:[&[data-flip]]:-scale-x-100"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
