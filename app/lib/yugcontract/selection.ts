/**
 * User-approved subset of the Yugcontract category tree (dry-run scope).
 *
 * Pure data + helpers only: no I/O. IDs come from the get-categories
 * preview confirmed on 2026-08 and are matched against the live tree
 * at runtime — unknown ids are reported, never guessed.
 */

export interface YcSelectedCategory {
  id: string;
  name: string;
  children: YcSelectedCategory[];
}

export const SELECTED_CATEGORIES: YcSelectedCategory[] = [
  {
    id: '1186',
    name: 'ПОБУТОВА ТЕХНІКА',
    children: [
      {
        id: '740',
        name: 'Кліматична техніка',
        children: [
          { id: '498', name: 'Водонагрівачі', children: [] },
          { id: '180', name: 'Кондиціонери', children: [] },
          { id: '1522', name: 'Сушарки для рушників', children: [] },
          {
            id: '190',
            name: 'Обігрівачі',
            children: [
              { id: '1523', name: 'Обігрівачі оливного типу', children: [] },
              { id: '1526', name: 'Обігрівачі інфрачервоні', children: [] },
              { id: '1524', name: 'Тепловентилятори', children: [] },
              { id: '1525', name: 'Конвектори', children: [] },
              { id: '1527', name: 'Керамічні панелі', children: [] },
              { id: '1528', name: 'Аксесуари до обігрівачів', children: [] },
            ],
          },
          { id: '177', name: 'Вентилятори', children: [] },
          { id: '196', name: 'Зволожувачі', children: [] },
          { id: '552', name: 'Очищувачі повітря', children: [] },
          { id: '1463', name: 'Осушувачі повітря', children: [] },
          { id: '1661', name: 'Кліматичні комплекси', children: [] },
          { id: '1332', name: 'Аксесуари до кліматичної техніки', children: [] },
        ],
      },
      {
        id: '1304',
        name: 'Вбудована техніка',
        children: [
          { id: '197', name: 'Поверхні', children: [] },
          { id: '202', name: 'Духові шафи', children: [] },
          { id: '1646', name: 'Комплекти', children: [] },
          { id: '1216', name: 'Холодильники', children: [] },
          { id: '1217', name: 'СВЧ печі', children: [] },
          { id: '1215', name: 'Витяжки', children: [] },
          { id: '205', name: 'Посудомийні машини', children: [] },
          { id: '1600', name: 'Пральні машини', children: [] },
          { id: '1333', name: 'Аксесуари до вбудованої техніки', children: [] },
        ],
      },
      {
        id: '739',
        name: 'Велика побутова техніка',
        children: [
          { id: '490', name: 'Холодильники', children: [] },
          { id: '488', name: 'Пральні машини', children: [] },
          { id: '94', name: 'Посудомийні машини', children: [] },
          {
            id: '89',
            name: 'Плити',
            children: [
              { id: '1536', name: 'Індукційні', children: [] },
              { id: '1535', name: 'Газові', children: [] },
              { id: '1538', name: 'Електричні', children: [] },
              { id: '1537', name: 'Склокерамічні', children: [] },
              { id: '1539', name: 'Комбіновані', children: [] },
            ],
          },
          { id: '217', name: 'Морозильні камери та ларі', children: [] },
          { id: '1123', name: 'Сушильні машини', children: [] },
          {
            id: '1334',
            name: 'Аксесуари до великої побутової техніки',
            children: [
              { id: '1653', name: 'Аксесуари для холодильників', children: [] },
              { id: '1471', name: 'Для посудомийних та пральних машин', children: [] },
              { id: '1470', name: 'Різні аксесуари для ВПТ', children: [] },
              { id: '1469', name: 'Хімія для побутової техніки', children: [] },
            ],
          },
          { id: '1515', name: 'Запчастини та комплектуючі', children: [] },
        ],
      },
      {
        id: '69',
        name: 'Мала кухонна техніка',
        children: [
          { id: '85', name: 'СВЧ печі', children: [] },
          {
            id: '218',
            name: 'Подрібнення та змішування',
            children: [
              { id: '1401', name: 'Комбайни', children: [] },
              { id: '1402', name: 'Блендери', children: [] },
              { id: '1403', name: 'Міксери', children: [] },
              { id: '1466', name: 'Тертки електричні', children: [] },
              { id: "1404", name: "М'ясорубки", children: [] },
              { id: '1405', name: 'Ломтерізки', children: [] },
            ],
          },
          {
            id: '129',
            name: 'Приготування їжі',
            children: [
              { id: '1419', name: 'Електропечі', children: [] },
              { id: '1406', name: 'Мультиварки', children: [] },
              { id: '1642', name: 'Мультипечі', children: [] },
              { id: '1407', name: 'Хлібопічки', children: [] },
              { id: '1464', name: 'Пароварки', children: [] },
            ],
          },
          {
            id: '494',
            name: 'Для чаю та кави',
            children: [
              { id: '1408', name: 'Кавоварки', children: [] },
              { id: '1462', name: 'Кавомолки', children: [] },
              { id: '1409', name: 'Електрочайники', children: [] },
            ],
          },
          { id: '142', name: 'Для соків', children: [] },
          {
            id: '493',
            name: 'Інша кухонна техніка',
            children: [
              { id: '1411', name: 'Бутербродниці та вафельниці', children: [] },
              { id: '1420', name: 'Ваги кухонні', children: [] },
              { id: '1412', name: 'Гриль', children: [] },
              { id: '1415', name: 'Електросушарки', children: [] },
              { id: '1413', name: 'Йогуртниці', children: [] },
              { id: '1410', name: 'Млинниці', children: [] },
              { id: '1414', name: 'Настільні плити', children: [] },
              { id: '1417', name: 'Тостери', children: [] },
              { id: '1416', name: 'Фритюрниці', children: [] },
              { id: '1418', name: 'Інше', children: [] },
            ],
          },
          { id: '1335', name: 'Аксесуари до кухонної техніки', children: [] },
        ],
      },
      {
        id: '210',
        name: 'Догляд за домом та речами',
        children: [
          { id: '98', name: 'Пилосмоки з мішком', children: [] },
          { id: '99', name: 'Пилосмоки з контейнером', children: [] },
          { id: '102', name: 'Пилосмоки вологого прибирання', children: [] },
          { id: '1247', name: 'Пилосмоки акумуляторні та/або роботизовані', children: [] },
          { id: '1665', name: 'Пилосмоки ручні', children: [] },
          { id: '1633', name: 'Очищувачі скла', children: [] },
          { id: '103', name: 'Праски, парові системи', children: [] },
          { id: '560', name: 'Пароочищувачі', children: [] },
          { id: '1248', name: 'Швейні машини', children: [] },
          { id: '1421', name: 'Машинки для чищення від катишів', children: [] },
          { id: '1336', name: 'Аксесуари до техніки для дому', children: [] },
        ],
      },
      {
        id: '491',
        name: "Краса та здоров'я",
        children: [
          { id: '1547', name: 'Дарсонваль', children: [] },
          {
            id: '492',
            name: 'Догляд за волоссям',
            children: [
              { id: '1433', name: 'Бігуді', children: [] },
              { id: '1431', name: 'Вирівнювачі для волосся', children: [] },
              { id: '1432', name: 'Мультісталери', children: [] },
              { id: '1428', name: 'Фени', children: [] },
              { id: '1429', name: 'Фени-щітки', children: [] },
              { id: '1430', name: 'Щипці для завивки', children: [] },
            ],
          },
          { id: '118', name: 'Електрощітки зубні', children: [] },
          { id: '1546', name: 'Ірригатори', children: [] },
          {
            id: '111',
            name: 'Видалення волосся',
            children: [
              { id: '1424', name: 'Електробритви', children: [] },
              { id: '1423', name: 'Епілятори', children: [] },
              { id: '1425', name: 'Машинки для стрижки', children: [] },
              { id: '1445', name: 'Станки для гоління', children: [] },
            ],
          },
          {
            id: '225',
            name: 'Догляд за руками та ногами',
            children: [
              { id: '1426', name: 'Масажери та ванночки', children: [] },
              { id: '1427', name: 'Набори для педикюра, манікюра', children: [] },
            ],
          },
          { id: '1514', name: 'Диспенсери', children: [] },
          { id: '106', name: 'Ваги', children: [] },
          { id: '1422', name: 'Електроковдри', children: [] },
          { id: '1337', name: "Аксесуари в групі Краса та здоров'я", children: [] },
        ],
      },
      {
        id: '884',
        name: 'Кухонне приладдя',
        children: [
          { id: '1347', name: 'Глечики', children: [] },
          { id: '1346', name: 'Дошка для нарізання', children: [] },
          { id: '1348', name: 'Кухонні аксесуари', children: [] },
          { id: '1349', name: 'Мірні склянки й кухлі', children: [] },
          { id: '1350', name: 'Миски', children: [] },
          { id: '1351', name: 'Питні набори (пластик)', children: [] },
          { id: '1353', name: 'Склянки (пластик)', children: [] },
          { id: '1352', name: 'Спецівники', children: [] },
          { id: '1354', name: 'Тарілки (пластик)', children: [] },
          { id: '1355', name: 'Тортівниці (пластик)', children: [] },
          { id: '1356', name: 'Фрешниці', children: [] },
          { id: '1357', name: 'Хлібниці', children: [] },
        ],
      },
      {
        id: '155',
        name: 'Кухонний посуд',
        children: [
          { id: '1465', name: 'Гусятниці', children: [] },
          { id: '1364', name: 'Кавоварки', children: [] },
          { id: '1363', name: 'Каструлі та ковші', children: [] },
          { id: '1365', name: 'Кришки', children: [] },
          { id: '1366', name: 'Набори посуду', children: [] },
          { id: '1367', name: 'Сковорідки та сотейники', children: [] },
          { id: '1368', name: 'Форми для випікання', children: [] },
          { id: '1369', name: 'Френч-преси', children: [] },
          { id: '1370', name: 'Чайники', children: [] },
        ],
      },
      {
        id: '900',
        name: 'Ножі та аксессуари',
        children: [
          { id: '1358', name: 'Барбекю', children: [] },
          { id: '1359', name: 'Набори ножів', children: [] },
          { id: '1360', name: 'Ножі', children: [] },
          { id: '1361', name: 'Ножиці', children: [] },
          { id: '1362', name: 'Приналежності для ножів', children: [] },
        ],
      },
      {
        id: '1253',
        name: 'Питне скло',
        children: [
          { id: '1373', name: 'Глечики', children: [] },
          { id: '1658', name: 'Диспенсери', children: [] },
          { id: '1371', name: 'Келихи, фужери, кухолі', children: [] },
          { id: '1374', name: 'Набори для напоїв', children: [] },
          { id: '1375', name: 'Склянки', children: [] },
          { id: '1376', name: 'Чарки', children: [] },
          { id: '1479', name: 'Пляшки-штоф', children: [] },
        ],
      },
      {
        id: '1115',
        name: 'Посуд для зберігання',
        children: [
          { id: '1377', name: 'Банки', children: [] },
          { id: '1380', name: 'Контейнери', children: [] },
          { id: '1378', name: 'Пляшки', children: [] },
          { id: '1513', name: 'Пляшки для масла та оцет', children: [] },
          { id: '1381', name: 'Термокружки та термоси', children: [] },
        ],
      },
      {
        id: '861',
        name: 'Столовий посуд',
        children: [
          { id: '1383', name: 'Маслянки', children: [] },
          { id: '1384', name: 'Молочники, сливочники', children: [] },
          { id: '1645', name: 'Попільнички', children: [] },
          { id: '1387', name: 'Столові прибори', children: [] },
          { id: '1388', name: 'Столові сервізи', children: [] },
          { id: '1382', name: 'Тарілки, салатники, блюда', children: [] },
          { id: '1385', name: 'Таці сервирувальні', children: [] },
          { id: '1389', name: 'Тортівниці', children: [] },
          { id: '1386', name: 'Цукорниці', children: [] },
          { id: '1390', name: 'Чайники заварочні', children: [] },
          { id: '1391', name: 'Чашки', children: [] },
          { id: '1481', name: 'Соусники', children: [] },
          { id: '1480', name: 'Відерця сервірувальні', children: [] },
        ],
      },
      { id: '1520', name: 'Текстиль для кухні', children: [] },
      {
        id: '1205',
        name: 'Декор',
        children: [
          { id: '1258', name: 'Вази', children: [] },
          { id: '1542', name: 'Підсвічники', children: [] },
          { id: '545', name: 'Фотоальбоми', children: [] },
          { id: '1434', name: 'Фоторамки', children: [] },
          { id: '1313', name: 'Подарункові коробки', children: [] },
          { id: '1207', name: 'Дизайнерські Рамки і Підрамники FUJIFILM', children: [] },
        ],
      },
      {
        id: '1609',
        name: 'Кошики та органайзери',
        children: [
          { id: '731', name: 'Кошики та коробки універсальні', children: [] },
          { id: '1308', name: 'Кошики для білизни', children: [] },
          { id: '1309', name: 'Кошики для пікніка', children: [] },
          { id: '1324', name: 'Кошики для сміття', children: [] },
          { id: '1534', name: 'Органайзери', children: [] },
        ],
      },
      {
        id: '1451',
        name: 'Господарчі товари',
        children: [
          { id: '1472', name: 'Стойки та вішалки для одягу', children: [] },
          {
            id: '1453',
            name: 'Товари для прибирання',
            children: [
              { id: '1628', name: 'Вікномийки', children: [] },
              { id: '1452', name: 'Відра', children: [] },
              { id: '1502', name: 'Тази', children: [] },
              { id: '1505', name: 'Скребки', children: [] },
              { id: '1503', name: 'Совки', children: [] },
              { id: '1504', name: 'Швабри', children: [] },
              { id: '1521', name: 'Щітки', children: [] },
              { id: '1531', name: 'Запаски', children: [] },
              { id: '1644', name: 'Набори для прибирання', children: [] },
            ],
          },
          {
            id: '1447',
            name: 'Для ванної та туалету',
            children: [
              { id: '1509', name: 'Ванночки дитячі', children: [] },
              { id: '1507', name: 'Горщики дитячі', children: [] },
              { id: '1510', name: 'Стільчаки', children: [] },
              { id: '1508', name: 'Аксесуари', children: [] },
              { id: '1506', name: 'Набори для ванної', children: [] },
            ],
          },
          { id: '1517', name: 'Сушарки для білизни', children: [] },
          { id: '1518', name: 'Дошки для прасування', children: [] },
        ],
      },
    ],
  },
];

/** Depth-first flatten of the selection into unique ids (feed order). */
export function flattenSelectedIds(
  nodes: YcSelectedCategory[] = SELECTED_CATEGORIES
): string[] {
  const out: string[] = [];
  const walk = (list: YcSelectedCategory[]): void => {
    for (const node of list) {
      if (!out.includes(node.id)) out.push(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function countSelectedNodes(
  nodes: YcSelectedCategory[] = SELECTED_CATEGORIES
): number {
  let count = 0;
  for (const node of nodes) count += 1 + countSelectedNodes(node.children);
  return count;
}

// ---------------------------------------------------------------------------
// Live-tree expansion (pure)
// ---------------------------------------------------------------------------

/** Minimal node shape needed for expansion — satisfied by YcCategoryNode. */
export interface ExpandableNode {
  externalId: string;
  parentId: string | null;
}

export interface ExpansionResult {
  /** every id inside the selected subtrees, including the selected ids */
  expanded: Set<string>;
  /** selected ids missing from the live tree */
  unknownSelected: string[];
}

/**
 * Expand each approved id to its full subtree against the LIVE tree.
 * Unknown ids are reported, never guessed; cycles are tolerated by the
 * visited-set so a malformed feed cannot loop us forever.
 */
export function collectExpandedIds(
  nodes: readonly ExpandableNode[],
  selectedIds: readonly string[]
): ExpansionResult {
  const byId = new Set(nodes.map((n) => n.externalId));
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId === null || !byId.has(n.parentId)) continue;
    const list = childrenOf.get(n.parentId);
    if (list) list.push(n.externalId);
    else childrenOf.set(n.parentId, [n.externalId]);
  }

  const expanded = new Set<string>();
  const unknownSelected: string[] = [];
  for (const id of selectedIds) {
    if (!byId.has(id)) {
      unknownSelected.push(id);
      continue;
    }
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (expanded.has(cur)) continue;
      expanded.add(cur);
      for (const child of childrenOf.get(cur) ?? []) stack.push(child);
    }
  }
  return { expanded, unknownSelected };
}
