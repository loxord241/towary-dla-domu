import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="card max-w-md w-full p-10 text-center">
        <p aria-hidden className="mb-3 text-5xl font-extrabold text-gray-300">
          404
        </p>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          Сторінку не знайдено
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          Можливо, посилання застаріло або введено з помилкою.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/catalog" className="btn btn-primary">
            До каталогу
          </Link>
          <Link href="/" className="btn btn-secondary">
            На головну
          </Link>
        </div>
      </div>
    </div>
  );
}
