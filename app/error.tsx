'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Global runtime-error boundary. Users never see stack traces or
 * framework internals — only a friendly recovery screen.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side log capture; nothing sensitive is shown to the user.
    console.error('Unhandled UI error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="card max-w-md w-full p-8 text-center">
        <p aria-hidden className="mb-3 text-4xl">
          ⚠️
        </p>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          Щось пішло не так
        </h1>
        <p className="text-gray-500 mb-6">
          Спробуйте оновити сторінку або повернутися до каталогу.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <button type="button" onClick={reset} className="btn btn-primary">
            Оновити сторінку
          </button>
          <Link href="/catalog" className="btn btn-secondary">
            До каталогу
          </Link>
        </div>
      </div>
    </div>
  );
}
