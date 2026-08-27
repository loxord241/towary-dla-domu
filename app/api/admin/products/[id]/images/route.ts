import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, numOrNull, isUuid, dbErrorResponse } from '@/app/lib/admin-api';
import { sanitizeUploadFileName, IMAGE_EXT_BY_MIME } from '@/app/lib/upload-filename';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB — mirrored by the Storage bucket limit (migration 025)
const ALLOWED_MIME = Object.keys(IMAGE_EXT_BY_MIME);

/**
 * Magic-byte sniffing: the multipart Content-Type is client-controlled, so
 * the actual file header must match one of the allowed image formats.
 */
async function detectImageMime(file: File): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const has = (offset: number, bytes: string) => {
    for (let i = 0; i < bytes.length; i++) {
      if (head[offset + i] !== bytes.charCodeAt(i)) return false;
    }
    return true;
  };
  const hex = (offset: number, ...values: number[]) => {
    for (let i = 0; i < values.length; i++) {
      if (head[offset + i] !== values[i]) return false;
    }
    return true;
  };

  if (hex(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'; // JPEG SOI
  if (hex(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (has(0, 'GIF8')) return 'image/gif'; // GIF87a/GIF89a
  if (hex(0, 0x52, 0x49, 0x46, 0x46) && has(8, 'WEBP')) return 'image/webp';
  if (has(4, 'ftyp')) {
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
    if (['avif', 'avis', 'mif1', 'msf1'].includes(brand)) return 'image/avif';
  }
  return null;
}

// GET /api/admin/products/<id>/images — list product images.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id товару' }, { status: 400 });
  }

  try {
    const { data, error } = await ctx.serviceClient
      .from('product_images')
      .select('*')
      .eq('product_id', id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('admin images list failed:', error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }

    return NextResponse.json({ images: data ?? [] });
  } catch (err) {
    console.error('Product images API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

// POST /api/admin/products/<id>/images — upload an image (multipart/form-data:
// file, alt?, sort_order?, is_main?) into the product_images storage bucket.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id товару' }, { status: 400 });
  }

  try {
    // Ensure the product exists.
    const { data: product } = await ctx.serviceClient
      .from('products')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!product) {
      return NextResponse.json({ error: 'Товар не знайдено' }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Файл обов’язковий' }, { status: 400 });
    }
    if (!ALLOWED_MIME.includes(file.type)) {
      return NextResponse.json(
        { error: 'Непідтримуваний тип файлу. Дозволено: JPEG, PNG, WebP, GIF, AVIF.' },
        { status: 400 }
      );
    }

    // Reject files whose bytes do not match the declared image type
    // (protects against Content-Type spoofing).
    const detectedMime = await detectImageMime(file);
    if (detectedMime !== file.type) {
      return NextResponse.json(
        { error: 'Вміст файлу не відповідає заявленому формату зображення.' },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: 'Файл завеликий. Максимальний розмір — 5 МБ.' },
        { status: 400 }
      );
    }

    const alt = strOrNull(formData.get('alt'));
    const sortOrder = numOrNull(formData.get('sort_order')) ?? 0;
    const isMain = formData.get('is_main') === 'true';

    const safeName = sanitizeUploadFileName(file.name, detectedMime);
    if (!safeName) {
      // Defense in depth: unreachable while ALLOWED_MIME mirrors
      // IMAGE_EXT_BY_MIME, but never build a path from an unknown type.
      return NextResponse.json(
        { error: 'Непідтримуваний тип файлу.' },
        { status: 400 }
      );
    }
    const storagePath = `products/${id}/${Date.now()}-${safeName}`;

    // Upload + insert FIRST, and only then clear the siblings' main flag:
    // clearing first would leave the product with ZERO main images whenever
    // the upload or insert fails. A failed sibling-update below merely
    // leaves two main rows for a moment (cosmetic, self-healing).
    const { error: uploadError } = await ctx.serviceClient.storage
      .from('product_images')
      .upload(storagePath, file, { contentType: file.type });

    if (uploadError) {
      console.error('Image upload failed:', uploadError.message);
      return NextResponse.json(
        { error: 'Не вдалося завантажити файл у сховище' },
        { status: 500 }
      );
    }

    const { data: inserted, error: insertError } = await ctx.serviceClient
      .from('product_images')
      .insert({
        product_id: id,
        image_url: storagePath,
        alt,
        sort_order: Math.trunc(sortOrder),
        is_main: isMain,
      })
      .select('*')
      .single();

    if (insertError) {
      // Do not leave orphaned files behind when the DB insert fails.
      await ctx.serviceClient.storage.from('product_images').remove([storagePath]);
      return dbErrorResponse(insertError, 'Не вдалося зберегти зображення');
    }

    if (isMain) {
      const { error: unsetError } = await ctx.serviceClient
        .from('product_images')
        .update({ is_main: false })
        .eq('product_id', id)
        .eq('is_main', true)
        .neq('id', inserted.id);
      if (unsetError) {
        console.error('Failed to clear previous main image flags:', unsetError.message);
      }
    }

    return NextResponse.json({ image: inserted }, { status: 201 });
  } catch (err) {
    console.error('Product images API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
