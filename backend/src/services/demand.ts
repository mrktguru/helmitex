import prisma from '../prisma/client';
import { ozon } from './ozon';

// Потребность Ozon по кластерам: продажи, остатки и рекомендации по каждому SKU с артикулом Ozon
export interface DemandRow {
  clusterId: string; clusterName: string;
  ads: number; stock: number; transit: number; idc: number; grade: string; rec: number | null;
}
export interface DemandSku {
  itemId: string; name: string; offerId: string; sku: string;
  variants: { id: string; name: string; units: number; inStock: number }[];
  loose: number; // единиц россыпью (без ЧЗ + с ЧЗ), из которых можно собрать кванты
  rows: DemandRow[];
}

let cache: { at: number; data: { updatedAt: string; skus: DemandSku[]; recError: string | null } } | null = null;
const TTL = 10 * 60_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function getDemand(refresh = false) {
  if (!refresh && cache && Date.now() - cache.at < TTL) return { ...cache.data, ...(await ourStock(cache.data.skus)) };

  const specs = await prisma.productSpec.findMany({ where: { ozonSku: { not: null }, item: { archived: false } }, include: { item: true } });
  const bySku = new Map(specs.map((s) => [s.ozonSku!, s]));
  const skus = [...bySku.keys()];

  // Остатки и продажи по складам → агрегируем по кластеру
  const agg = new Map<string, DemandRow & { sku: string }>();
  for (let i = 0; i < skus.length; i += 100) {
    const r = await ozon('/v1/analytics/stocks', { skus: skus.slice(i, i + 100) });
    for (const it of r.items ?? []) {
      const clusterId = String(it.macrolocal_cluster_id ?? it.cluster_id);
      const key = `${it.sku}|${clusterId}`;
      const a = agg.get(key) ?? { sku: String(it.sku), clusterId, clusterName: it.cluster_name, ads: 0, stock: 0, transit: 0, idc: 0, grade: '', rec: null };
      a.stock += (it.available_stock_count ?? 0) + (it.valid_stock_count ?? 0);
      a.transit += (it.transit_stock_count ?? 0) + (it.requested_stock_count ?? 0);
      a.ads = it.ads_cluster ?? 0;
      a.idc = it.idc_cluster ?? 0;
      a.grade = it.turnover_grade_cluster ?? '';
      agg.set(key, a);
    }
  }

  // Рекомендации Ozon (бета-метод «Локальность продаж») — если недоступен, работаем без них
  let recError: string | null = null;
  try {
    const to = new Date(Date.now() - 86400_000);
    const from = new Date(to.getTime() - 27 * 86400_000);
    for (let offset = 0; offset < 2000; offset += 500) {
      const r = await ozon('/v1/analytics/local-sale/items-clusters/info', {
        filter: { skus, period: { from: ymd(from), to: ymd(to) }, delivery_schema: 'FBO', supply_period: 'FOUR_WEEKS' },
        limit: 500, offset,
      });
      for (const it of r.items ?? []) {
        const a = agg.get(`${it.sku}|${it.macrolocal_cluster_to_id}`);
        if (a) a.rec = it.metrics?.recommended_supply ?? null;
      }
      if ((r.items ?? []).length < 500) break;
    }
  } catch (e) { recError = (e as Error).message; }

  const result: DemandSku[] = specs.map((s) => ({
    itemId: s.itemId, name: s.item.name, offerId: s.ozonOfferId!, sku: s.ozonSku!, variants: [], loose: 0,
    rows: [...agg.values()].filter((a) => a.sku === s.ozonSku).map(({ sku: _s, ...r }) => r)
      .filter((r) => r.ads > 0.04 || r.stock > 0 || r.transit > 0)
      .sort((a, b) => (a.ads > 0.04 ? a.idc : 1e9) - (b.ads > 0.04 ? b.idc : 1e9) || b.ads - a.ads),
  })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const data = { updatedAt: new Date().toISOString(), skus: result, recError };
  cache = { at: Date.now(), data };
  return { ...data, ...(await ourStock(result)) };
}

// Наши кванты по вариантам и россыпь — считаются заново при каждом запросе
async function ourStock(skus: DemandSku[]) {
  const ids = skus.map((s) => s.itemId);
  const types = await prisma.quantType.findMany({ where: { productItemId: { in: ids }, archived: false }, orderBy: { unitsPerQuant: 'desc' } });
  const counts = await prisma.quant.groupBy({ by: ['quantTypeId'], where: { status: 'ASSEMBLED', quantTypeId: { in: types.map((t) => t.id) } }, _count: true });
  const loose = await prisma.stockMove.groupBy({ by: ['lotId'], where: { state: { in: ['UNLABELED', 'LABELED'] }, lot: { itemId: { in: ids } } }, _sum: { qty: true } });
  const lots = await prisma.lot.findMany({ where: { id: { in: loose.map((l) => l.lotId) } }, select: { id: true, itemId: true } });
  const lotItem = new Map(lots.map((l) => [l.id, l.itemId]));
  const looseBy = new Map<string, number>();
  for (const l of loose) looseBy.set(lotItem.get(l.lotId)!, (looseBy.get(lotItem.get(l.lotId)!) ?? 0) + (l._sum.qty ?? 0));
  return {
    skus: skus.map((s) => ({
      ...s,
      loose: Math.round(looseBy.get(s.itemId) ?? 0),
      variants: types.filter((t) => t.productItemId === s.itemId).map((t) => ({
        id: t.id, name: t.name, units: t.unitsPerQuant, inStock: counts.find((c) => c.quantTypeId === t.id)?._count ?? 0,
      })),
    })),
  };
}
