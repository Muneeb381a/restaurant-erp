import { useId } from 'react';

/** An eight-point star: the same figure is the logo mark and the pattern on the sign-in panel. */
export function Mark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect
        x="6"
        y="6"
        width="20"
        height="20"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <rect
        x="6"
        y="6"
        width="20"
        height="20"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        transform="rotate(45 16 16)"
      />
      <circle cx="16" cy="16" r="3.2" fill="currentColor" />
    </svg>
  );
}

/** Tiled star lattice (jali) for dark panels; very low contrast so it reads as texture, not decoration. */
export function Jali({ className = '' }: { className?: string }) {
  const id = useId();
  return (
    <svg className={className} width="100%" height="100%" aria-hidden="true">
      <defs>
        <pattern id={id} width="72" height="72" patternUnits="userSpaceOnUse">
          <g fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="18" y="18" width="36" height="36" />
            <rect x="18" y="18" width="36" height="36" transform="rotate(45 36 36)" />
            <circle cx="36" cy="36" r="6" />
            <path d="M0 0h72M0 72h72M0 0v72M72 0v72" opacity=".35" />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <Mark />
      <span>Restaurant POS</span>
    </span>
  );
}
