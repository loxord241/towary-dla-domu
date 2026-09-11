import type { Metadata } from 'next';
import WallVisualizerApp from '@/app/components/WallVisualizerApp';
import { fetchWallpaperSwatches } from '@/app/lib/catalog';

// Страница-примерочная (бриф владельца 2026-09-11): комната + панель
// образцов, тап — шпалеры «сами клеятся». Deep-link
// /vizualizator?wallpaper=<slug>&room=<id> шарится покупателями.
export const metadata: Metadata = {
  title: `Візуалізатор шпалер в інтер'єрі — Товари для дому`,
  description:
    'Оберіть шпалери на панелі — і подивіться, як вони виглядають на стіні кімнати. Вітальня, спальня, дитяча, кухня.',
  alternates: { canonical: '/vizualizator' },
};

export default async function VisualizerPage({
  searchParams,
}: {
  searchParams: Promise<{ wallpaper?: string; room?: string }>;
}) {
  const params = await searchParams;
  const swatches = await fetchWallpaperSwatches();
  return (
    <WallVisualizerApp
      swatches={swatches}
      initialSlug={params.wallpaper ?? null}
      initialRoom={params.room ?? null}
    />
  );
}
