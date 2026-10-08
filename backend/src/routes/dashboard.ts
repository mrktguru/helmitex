import { Router, Response } from 'express';
import prisma from '../prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { availableCodes } from '../services/quants';

const router = Router();
router.use(authMiddleware);

interface Alert { level: 'crit' | 'warn' | 'info'; title: string; text: string; action?: { label: string; to: string } }

// GET /api/stock/dashboard — цепочка «сырьё → бочки → ГП → кванты → FBO» и что требует внимания
router.get('/dashboard', async (_req: AuthRequest, res: Response) => {
  const groups = await prisma.stockMove.groupBy({ by: ['lotId', 'state'], _sum: { qty: true } });
  const live = groups.filter((g) => (g._sum.qty ?? 0) > 1e-6);
  const lots = await prisma.lot.findMany({ where: { id: { in: live.map((g) => g.lotId) } }, include: { item: true } });
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const rows = live.map((g) => ({ lot: lotById.get(g.lotId)!, state: g.state, qty: g._sum.qty ?? 0 }));

  const byType = (t: string) => rows.filter((r) => r.lot.item.type === t);
  const materials = rows.filter((r) => ['RAW', 'CONTAINER', 'PACKAGING', 'LABEL'].includes(r.lot.item.type));
  const barrels = byType('SEMI');
  const product = byType('PRODUCT');
  const sum = (rs: typeof rows) => Math.round(rs.reduce((t, r) => t + r.qty, 0) * 1000) / 1000;

  const quantTypes = await prisma.quantType.findMany({ where: { archived: false }, include: { productItem: true, project: true } });
  const quantsInStock = await prisma.quant.groupBy({ by: ['quantTypeId'], where: { status: 'ASSEMBLED' }, _count: true, _sum: { units: true } });
  const fboActive = await prisma.fboShipment.findMany({
    where: { status: { notIn: ['CANCELLED', 'COMPLETED'] } },
    include: { cargoes: { include: { quant: { select: { units: true } } } } },
    orderBy: { createdAt: 'desc' },
  });

  const alerts: Alert[] = [];

  // Ниже минимального остатка
  const items = await prisma.item.findMany({ where: { archived: false, minStock: { not: null } } });
  for (const it of items) {
    const have = sum(rows.filter((r) => r.lot.itemId === it.id));
    if (have < it.minStock!) {
      alerts.push({ level: have === 0 ? 'crit' : 'warn', title: `${it.name} — ниже минимума`, text: `Остаток ${have} ${it.unit} при минимуме ${it.minStock} ${it.unit}`, action: { label: 'Приход', to: '/stock/docs/new?type=RECEIPT' } });
    }
  }
  // Сроки годности
  const soon = Date.now() + 30 * 86400_000;
  for (const r of rows) {
    const exp = r.lot.expiresAt?.getTime();
    if (exp == null || exp > soon) continue;
    const expired = exp < Date.now();
    alerts.push({
      level: expired ? 'crit' : 'warn',
      title: `${r.lot.item.name} · лот ${r.lot.number}${r.lot.barrel ? ` (${r.lot.barrel})` : ''}`,
      text: `${expired ? 'Просрочен' : 'Истекает'} ${r.lot.expiresAt!.toLocaleDateString('ru-RU')} · остаток ${Math.round(r.qty * 1000) / 1000} ${r.lot.item.unit}`,
      action: { label: 'Открыть', to: `/stock/moves?lotId=${r.lot.id}` },
    });
  }
  // ГП без ЧЗ ждёт сборки в кванты
  const unlabeled = new Map<string, { name: string; qty: number }>();
  for (const r of product.filter((x) => x.state === 'UNLABELED')) {
    const v = unlabeled.get(r.lot.itemId) ?? { name: r.lot.item.name, qty: 0 };
    v.qty += r.qty;
    unlabeled.set(r.lot.itemId, v);
  }
  for (const [itemId, v] of unlabeled) {
    const qt = quantTypes.find((t) => t.productItemId === itemId);
    alerts.push({
      level: 'info', title: `${v.name}: ${Math.round(v.qty)} шт ждут сборки`,
      text: qt ? `Хватит на ${Math.floor(v.qty / qt.unitsPerQuant)} кв. «${qt.name}»` : 'Для SKU не настроен тип кванта',
      action: qt ? { label: 'Собрать кванты', to: '/stock/quant/new' } : { label: 'Настроить', to: `/stock/catalog/${itemId}` },
    });
  }
  // Коды ЧЗ заканчиваются
  for (const t of quantTypes.filter((x) => x.trackCz)) {
    if (!t.projectId) {
      alerts.push({ level: 'warn', title: `«${t.name}»: не выбран проект этикетки ЧЗ`, text: 'Без проекта кванты не собрать', action: { label: 'Настроить', to: `/stock/catalog/${t.productItemId}` } });
      continue;
    }
    const free = await availableCodes(prisma, t.projectId);
    if (free < t.unitsPerQuant * 5) {
      alerts.push({
        level: free < t.unitsPerQuant ? 'crit' : 'warn', title: `Коды ЧЗ «${t.project?.name}»: ${free === 0 ? 'нет' : `осталось ${free}`}`,
        text: `Хватит на ${Math.floor(free / t.unitsPerQuant)} кв. по ${t.unitsPerQuant} шт. Загрузите коды в проект.`,
        action: { label: 'К проекту', to: `/projects/${t.projectId}` },
      });
    }
  }
  // Поставки FBO
  for (const s of fboActive) {
    if (s.lastError) alerts.push({ level: 'crit', title: `Поставка ${s.number}: ошибка Ozon`, text: s.lastError.slice(0, 200), action: { label: 'Открыть', to: `/stock/fbo/${s.id}` } });
    else if (s.timeslotFrom && ['BOOKED', 'CARGOES_SET', 'LABELS_READY'].includes(s.status)) {
      alerts.push({ level: 'info', title: `Поставка ${s.number}: слот ${s.timeslotFrom.slice(8, 10)}.${s.timeslotFrom.slice(5, 7)} ${s.timeslotFrom.slice(11, 16)}`, text: s.dropOffName ? `Отгрузка в ${s.dropOffName}` : (s.clusterName ?? ''), action: { label: 'Открыть', to: `/stock/fbo/${s.id}` } });
    }
  }
  // Незавершённые черновики производства
  const drafts = await prisma.stockDoc.findMany({ where: { status: 'DRAFT', type: { in: ['MIX', 'FILL'] } }, include: { outputItem: true } });
  for (const d of drafts) {
    alerts.push({ level: 'info', title: `${d.type === 'MIX' ? 'Замес' : 'Фасовка'} ${d.number} не проведён`, text: d.outputItem?.name ?? '', action: { label: 'Продолжить', to: d.type === 'MIX' ? `/stock/mix/${d.id}` : `/stock/fill/${d.id}` } });
  }

  const order = { crit: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  res.json({
    flow: {
      materials: { lots: materials.length, items: new Set(materials.map((r) => r.lot.itemId)).size },
      barrels: { count: barrels.length, kg: sum(barrels) },
      unlabeled: { units: sum(product.filter((r) => r.state === 'UNLABELED')), labeled: sum(product.filter((r) => r.state === 'LABELED')) },
      quants: {
        count: quantsInStock.reduce((t, q) => t + q._count, 0),
        units: quantsInStock.reduce((t, q) => t + (q._sum.units ?? 0), 0),
        byType: quantsInStock.map((q) => ({ name: quantTypes.find((t) => t.id === q.quantTypeId)?.name ?? '?', count: q._count })),
      },
      fbo: { active: fboActive.length, boxes: fboActive.reduce((t, s) => t + s.cargoes.length, 0) },
    },
    alerts,
  });
});

export default router;
