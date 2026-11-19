import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Mark } from './Brand';

/** The restaurant's own logo if it uploaded one, else the house mark. `size` is the tile in px. */
export function BrandMark({ version, size = 32 }: { version: number | null; size?: number }) {
  const logo = useQuery({
    queryKey: ['logo', version],
    enabled: version != null,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    queryFn: async () =>
      URL.createObjectURL(await api<Blob>('/branch/logo', { responseType: 'blob' })),
  });
  if (logo.data)
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white"
        style={{ width: size, height: size }}
      >
        <img src={logo.data} alt="" aria-hidden="true" className="size-full object-contain" />
      </span>
    );
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white"
      style={{ width: size, height: size }}
    >
      <Mark size={Math.round(size * 0.64)} />
    </span>
  );
}
