#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Конвертер ручной выгрузки 1С 7.7 в формат приёмника сайта.

Ритуал (ручной режим, решение владельца 2026-09-10):
  1. Владелец: 1С 7.7 -> отчёт «Звіт з інвентаризації товару» ->
     Сохранить как Excel -> передать файл оркестратору (data/ или чат).
  2. Оркестратор: этот скрипт превращает отчёт в
     a) <дата>-wallpapers.csv  — формат ingest-эндпоинта (code;name;article;unit;price_retail;qty)
     b) category-map-<дата>.json — {код 1С: slug категории} для импортера (--category-map)
  3. Импортер: wallpaper-import.ts --plan -> --run --category-map ...

Зависимость: xlrd 2.x (чистый python, wheel с PyPI):
  PYTHONPATH=/tmp/xlrdlib python3 xls-report-to-ingest-csv.py <отчет.xls> <выходная_папка>
  (если /tmp/xlrdlib пуст — скачать wheel xlrd и распаковать, см. историю 2026-09-10)

Формат отчёта (проверен на «Остатки10,09 обои.xls»): строка-товар =
код в колонке A, название в B, цена в C, остаток в D; строки-группы
(Акрил, Винил 10 м, ... ФЛИЗЕЛИН, ШЕЛКОГРАФИЯ, Мойка простая, Обои простые,
Супермойка, Метровые) — текст в B без кода; «Итого:» пропускается.
"""
import csv
import json
import re
import sys
from pathlib import Path

import xlrd  # PYTHONPATH=/tmp/xlrdlib

SUBGROUP_TO_SLUG = {
    'Акрил': 'shpaleri-akryl',
    'Винил 10 м': 'shpaleri-vinyl-10m',
    'Винил 15 м': 'shpaleri-vinyl-15m',
    'Дуплекс': 'shpaleri-duplex',
    'Метровые': 'shpaleri-metrovi',
    'ФЛИЗЕЛИН': 'shpaleri-flizelin',
    'ШЕЛКОГРАФИЯ': 'shpaleri-shovkografiya',
    'Мойка простая': 'shpaleri-miika-prosta',
    'Обои простые': 'shpaleri-prosti',
    'Супермойка': 'shpaleri-supermiika',
}
ROOT_SLUG = 'shpaleri'


def main(xls_path: str, out_dir: str) -> None:
    wb = xlrd.open_workbook(xls_path, encoding_override='cp1251')
    sh = wb.sheet_by_index(0)

    items = []          # (code, name, price, qty, subgroup)
    subgroup = None
    skipped_groups = set()
    for r in range(sh.nrows):
        label = str(sh.cell_value(r, 1)).strip()
        if label in SUBGROUP_TO_SLUG:
            subgroup = label
            continue
        code = sh.cell_value(r, 0)
        name = str(sh.cell_value(r, 1)).strip()
        price, qty = sh.cell_value(r, 2), sh.cell_value(r, 3)
        is_item = (
            str(code).strip() not in ('', 'Код')
            and isinstance(price, float)
            and isinstance(qty, float)
        )
        if not is_item:
            if label and label not in ('Итого:',) and not str(code).strip():
                skipped_groups.add(label)
            continue
        items.append((str(code).strip(), name, float(price), float(qty), subgroup))

    slug_by_subgroup = SUBGROUP_TO_SLUG
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    stamp = Path(xls_path).stat().st_mtime
    import datetime
    date_stamp = datetime.date.fromtimestamp(stamp).strftime('%Y%m%d')

    csv_path = out_path / f'{date_stamp}-wallpapers.csv'
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, delimiter=';', lineterminator='\n')
        w.writerow(['code', 'name', 'article', 'unit', 'price_retail', 'qty'])
        for code, name, price, qty, _sg in items:
            # xlrd отдаёт числа float; контракт парсера требует qty целым
            # (`\d+`), цена — «просто число» (допустим и int-вид `171`).
            w.writerow([code, name, '', 'рулон', f'{price:g}', f'{qty:g}'])

    cat_map = {}
    unknown_subgroups = {}
    for code, name, price, qty, sg in items:
        slug = slug_by_subgroup.get(sg, ROOT_SLUG)
        if sg not in slug_by_subgroup:
            unknown_subgroups[sg] = unknown_subgroups.get(sg, 0) + 1
        cat_map.setdefault(code, slug)

    map_path = out_path / f'category-map-{date_stamp}.json'
    with open(map_path, 'w', encoding='utf-8') as f:
        json.dump(cat_map, f, ensure_ascii=False, indent=1)

    zero_qty = sum(1 for i in items if i[3] == 0)
    total_qty = sum(i[3] for i in items)
    print(f'items: {len(items)} (нулевой остаток: {zero_qty}), суммарный остаток: {total_qty:.0f} рул.')
    by_sg = {}
    for _c, _n, _p, _q, sg in items:
        by_sg[sg] = by_sg.get(sg, 0) + 1
    print('по подгруппам:', by_sg)
    if unknown_subgroups:
        print('!! подгруппы без категории (ушли в корень shpaleri):', unknown_subgroups)
    if skipped_groups:
        print('прочие заголовки вне групп (пропущены):', sorted(skipped_groups))
    print('CSV :', csv_path)
    print('MAP :', map_path)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
