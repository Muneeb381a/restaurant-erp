import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('') || '?';

/** A person's photo, fetched with the staff sign-in. `version` changes when they upload a new one. */
function usePhoto(path: string | null, version: number | null | undefined) {
  return useQuery({
    queryKey: ['photo', path, version],
    enabled: !!path && version != null,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    queryFn: async () => URL.createObjectURL(await api<Blob>(path!, { responseType: 'blob' })),
  });
}

/**
 * A round badge: their photo when they have one (pass `userId` and `version`), else their initials.
 * The initials show while the photo loads and whenever it cannot be loaded.
 */
export function Avatar({
  name,
  size = 36,
  userId,
  version,
}: {
  name: string;
  size?: number;
  userId?: string | undefined;
  version?: number | null | undefined;
}) {
  const photo = usePhoto(userId ? `/users/${userId}/avatar` : null, version);
  if (photo.data)
    return (
      <img
        src={photo.data}
        alt=""
        aria-hidden="true"
        style={{ width: size, height: size }}
        className="inline-block shrink-0 rounded-full object-cover"
      />
    );
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-emerald-700 font-semibold text-white"
    >
      {initials(name)}
    </span>
  );
}
