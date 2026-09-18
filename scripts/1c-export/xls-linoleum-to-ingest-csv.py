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


def main(xls_path: str, out_dir: str) -> None:
    wb = xlrd.open_workbook(xls_path, encoding_override='cp1251')
    sh = wb.sheet_by_index(0)

    items = []            # (code, name, price, qty_float, width, qty_floor)
    width = None
    unknown_headers = set()
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
        items.append((code, name, float(price), float(qty), width, math.floor(qty)))

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
    if unknown_headers:
        print('прочие заголовки вне секций (пропущены):', sorted(unknown_headers))
    print('CSV :', csv_path)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
