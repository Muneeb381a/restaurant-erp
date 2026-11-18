import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * A dish photo for the till. The staff photo route needs the signed-in token, so the picture is fetched
 * with it and shown from a local object URL. It is only fetched once the tile scrolls into view, and it
 * is kept for the session (the version number changes when the photo is replaced).
 */
export function ItemPhoto({
  itemId,
  version,
  className = '',
}: {
  itemId: string;
  version: number;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const photo = useQuery({
    queryKey: ['item-photo', itemId, version],
    enabled: seen,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async () =>
      URL.createObjectURL(await api<Blob>(`/items/${itemId}/image`, { responseType: 'blob' })),
  });

  return (
    <div ref={box} className={`overflow-hidden bg-slate-100 ${className}`} aria-hidden="true">
      {photo.data && (
        <img
          src={photo.data}
          alt=""
          draggable={false}
          className="size-full object-cover"
          loading="lazy"
        />
      )}
    </div>
  );
}
