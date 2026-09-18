#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Конвертер ручной выгрузки 1С 7.7 (ЛИНОЛЕУМ) в формат приёмника сайта.

Первый реальный файл (2026-09-18, «Остатки 18,09,26.xls») — по этому
триггеру runbook (AGENTS.md, «Синк линолеума») и написан. Зеркало
xls-report-to-ingest-csv.py, но контракт другой:

  a) <дата>-linoleum.csv — code;name;width_m;price_sqm;qty_m
     (app/api/ingest/1c-linoleum, parseLinoleumCsv)
  b) category-map НЕ нужен: linoleum-import группирует по дизайну сам.

Формат отчёта (проверен на «Остатки 18,09,26.xls»): строки-секции ширин
в колонке B — «1,5 МЕТРА» … «4 МЕТРА» (запятая или точка); строка-товар =
код в A, название в B, цена в C (грн/м², розница), остаток в D (погонные
метры, 1С отдаёт ДРОБНЫЕ — распилы/полотна). Контракт приёмника требует
ЦЕЛЫЕ метры: остаток floor'ится (0.2 → 0), дробная часть печатается в
сводку, ничего не молча теряется. Ширина берётся ИЗ СЕКЦИИ (не из
названия — в названиях бывают опечатки), вне {1.5, 2, 2.5, 3, 3.5, 4}
скрипт падает (fail-closed), а не подставляет молча корень.

Имя дизайна в CSV (колонка name) чистится (clean_design_title):
вырезается хвост ширины «(2,5м)/(4m)» и ценовой хвост «1750грн/м.п.»,
подчёркивания → пробелы, пробелы схлопываются — иначе импортёр
(linoleum-import, группировка по имени дизайна) делает каждую ширину
отдельной карточкой (53 скрытых мусорных карточки на проде 2026-09-18).
ПРАВИЛО ПРОТИВОРЕЧИЯ: если в исходном имени есть явная ширина «(Xm)»
и X ≠ ширине секции («(0,5m)» в секции 3,5) — строка идёт в errors
(offcut/мислейбл), НЕ в CSV. Ширина проверяется по ИСХОДНОМУ имени,
до чистки. Unit-тесты чистки: --self-check.

Зависимость: xlrd 2.x через PYTHONPATH=/tmp/xlrdlib (как у обоев).
"""
import csv
import math
import re
import sys
from datetime import date
from pathlib import Path

import xlrd  # PYTHONPATH=/tmp/xlrdlib

ALLOWED_WIDTHS = {1.5, 2, 2.5, 3, 3.5, 4}
SECTION_RE = re.compile(r'^(\d+(?:[.,]\d+)?)\s*МЕТРА$', re.IGNORECASE)
WIDTH_TAIL_RE = re.compile(r'\s*\(\s*(\d+(?:[.,]\d+)?)\s*[mм]\s*\)\s*', re.IGNORECASE)
PRICE_TAIL_RE = re.compile(r'\s*\(?\s*\d+(?:[.,]\d+)?\s*грн.*$', re.IGNORECASE)

# Нормализация написаний одного и того же дизайна у поставщика (слитно/раздельно,
# кириллические омоглифы в коде дизайна). Применяется к чистому тайтлу.
TITLE_NORMALIZE_MAP = [
    ('Havanna', 'Havana'),   # Inspire Havana/Havanna Oak 967M — один дизайн
    ('967М', '967M'),        # кириллическая М в суффиксе кода → латиница
]


def normalize_title(title: str) -> str:
    for src, dst in TITLE_NORMALIZE_MAP:
        title = title.replace(src, dst)
    return title


def named_width_m(name: str):
    """Ширина, явно указанная в имени («(2,5м)», «(4m)»), или None."""
    m = WIDTH_TAIL_RE.search(name)
    return float(m.group(1).replace(',', '.')) if m else None


def clean_design_title(name: str) -> str:
    """Хвост ширины + ценовой хвост → долой; «_» → пробел; пробелы схлопнуть."""
    cleaned = WIDTH_TAIL_RE.sub(' ', name)
    cleaned = PRICE_TAIL_RE.sub(' ', cleaned)
    cleaned = cleaned.replace('_', ' ')
    return normalize_title(re.sub(r'\s+', ' ', cleaned).strip())


def main(xls_path: str, out_dir: str) -> None:
    wb = xlrd.open_workbook(xls_path, encoding_override='cp1251')
    sh = wb.sheet_by_index(0)

    items = []            # (code, clean_name, price, qty_float, width, qty_floor)
    width = None
    unknown_headers = set()
    width_conflicts = []  # (code, raw_name, section_width, named_width)
    for r in range(sh.nrows):
        label = str(sh.cell_value(r, 1)).strip()
        m = SECTION_RE.match(label)
        if m:
            value = float(m.group(1).replace(',', '.'))
            if value not in ALLOWED_WIDTHS:
                sys.exit(f'FAIL: секция ширины «{label}» вне сетки {sorted(ALLOWED_WIDTHS)}')
            width = value
            continue
        code = str(sh.cell_value(r, 0)).strip()
        name = str(sh.cell_value(r, 1)).strip()
        price, qty = sh.cell_value(r, 2), sh.cell_value(r, 3)
        is_item = (
            code not in ('', 'Код')
            and isinstance(price, float)
            and isinstance(qty, float)
        )
        if not is_item:
            if label and label not in ('Итого:',) and not code:
                unknown_headers.add(label)
            continue
        if width is None:
            sys.exit(f'FAIL: строка-товар до первой секции ширины (строка {r + 1}): {name!r}')
        # Порядок: конфликт ширины проверяем по ИСХОДНОМУ имени, чистим после.
        named_w = named_width_m(name)
        if named_w is not None and named_w != width:
            width_conflicts.append((code, name, width, named_w))
            continue
        items.append((code, clean_design_title(name), float(price), float(qty), width, math.floor(qty)))

    if not items:
        sys.exit('FAIL: ни одной строки-товара — формат отчёта изменился?')

    stamp = date.fromtimestamp(Path(xls_path).stat().st_mtime).strftime('%Y%m%d')
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    csv_path = out_path / f'linoleum-{stamp}.csv'
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, delimiter=';', lineterminator='\n')
        w.writerow(['code', 'name', 'width_m', 'price_sqm', 'qty_m'])
        for code, name, price, _qty, width_v, qty_floor in items:
            w.writerow([code, name, f'{width_v:g}', f'{price:g}', str(qty_floor)])

    by_width = {}
    fractional = [(c, q) for c, _n, _p, q, _w, qf in items if q != qf]
    zeroed = [c for c, _n, _p, q, _w, qf in items if q > 0 and qf == 0]
    for _c, _n, _p, _q, w_v, _qf in items:
        by_width[w_v] = by_width.get(w_v, 0) + 1
    print(f'items: {len(items)}, суммарный остаток: {sum(q for *_x, q, _ in [(0,)] ) if False else sum(i[3] for i in items):.1f} м.п. (после floor: {sum(i[5] for i in items)} м)')
    print('по ширинам:', {f'{k:g}': v for k, v in sorted(by_width.items())})
    print(f'дробные остатки (floor): {len(fractional)}; из них обнулились (<1 м): {len(zeroed)}')
    for c, q in fractional:
        print(f'  {c}: {q:g}')
    dup_codes = {c for c, *_ in items if [x[0] for x in items].count(c) > 1}
    if dup_codes:
        print(f'!! дубликаты кодов (не дедуплицируются, решает import-plan): {sorted(dup_codes)}')
    if width_conflicts:
        print(f'!! ширина в имени ≠ ширине секции — исключено из CSV (offcut/мислейбл): {len(width_conflicts)}')
        for c, n, sec_w, named_w in width_conflicts:
            print(f'  {c}: в имени {named_w:g}м, секция {sec_w:g}м — {n!r}')
    if unknown_headers:
        print('прочие заголовки вне секций (пропущены):', sorted(unknown_headers))
    print('CSV :', csv_path)


def self_check() -> None:
    """Детерміновані unit-тести чистки імен дизайну (без xls-файлу).

    Кейси — реальні назви з «Остатки 18,09,26.xls»/прод-карток 2026-09-18.
    Запуск: PYTHONPATH=/tmp/xlrdlib python xls-linoleum-to-ingest-csv.py --self-check
    """
    cases = [
        ('Лінолеум Beauflor Hightex Warm Oak 090S(2,5м) 1750грн/м.п.',
         'Лінолеум Beauflor Hightex Warm Oak 090S', 2.5),
        ('Лінолеум Beauflor CRACKED OAK 496М(4м)(2600грн/м.п)',
         'Лінолеум Beauflor CRACKED OAK 496М', 4.0),
        ('Лінолеум  IVC Floortex Helsinki_582 (0,5m) 175 грн/м.п',
         'Лінолеум IVC Floortex Helsinki 582', 0.5),
        ('Лінолеум Beauflor Smartex Pure_oak 190L(4м) 1960 грн/м.п.',
         'Лінолеум Beauflor Smartex Pure oak 190L', 4.0),
    ]
    for raw, expected_clean, expected_width in cases:
        got = clean_design_title(raw)
        assert got == expected_clean, (
            f'clean_design_title({raw!r}) -> {got!r}, очікувалось {expected_clean!r}')
        assert named_width_m(raw) == expected_width, (
            f'named_width_m({raw!r}) -> {named_width_m(raw)!r}, очікувалось {expected_width}')
    # Подвійний пробіл схлопується (кейс 3: «Лінолеум  IVC»).
    assert '  ' not in clean_design_title(cases[2][0])
    # Чисте ім'я без хвостів не ламається.
    plain = 'Лінолеум Beauflor Plain Oak'
    assert clean_design_title(plain) == plain
    assert named_width_m(plain) is None
    # Конфлікт ширини: 0.5м у секції 3.5м — рядок має вилучатись (див. main).
    assert named_width_m(cases[2][0]) != 3.5
    print('self-check: OK (4 реальні назви, чисте ім\'я, конфлікт ширини)')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--self-check':
        self_check()
    else:
        main(sys.argv[1], sys.argv[2])
