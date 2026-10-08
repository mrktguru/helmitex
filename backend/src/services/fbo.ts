import { FboStatus } from '@prisma/client';
import prisma from '../prisma/client';
import { StockError, consume, nextDocNumber, nextNumber } from './stock';
import { ozon, ozonGetFile, poll } from './ozon';
import { uploadFile } from './s3';

const MAX_BOXES = 30;            // /v1/cargoes/create: не больше 30 коробок
const DRAFT_TTL_MS = 29 * 60_000; // черновик Ozon живёт 30 минут

async function load(id: string) {
  const s = await prisma.fboShipment.findUnique({
    where: { id },
    include: {
      cargoes: {
        orderBy: { sort: 'asc' },
        include: { quant: { include: { lot: true, quantType: { include: { productItem: { include: { spec: true } } } } } } },
      },
    },
  });
  if (!s) throw new StockError('Поставка не найдена');
  return s;
}
type Shipment = Awaited<ReturnType<typeof load>>;

const STATUS_LABEL: Record<FboStatus, string> = {
  DRAFT: 'кванты подобраны', OZON_DRAFT: 'черновик в Ozon', BOOKED: 'слот забронирован', CARGOES_SET: 'грузоместа переданы',
  LABELS_READY: 'этикетки готовы', SHIPPED: 'отгружена', COMPLETED: 'принята Ozon', CANCELLED: 'отменена',
};

function expect(s: Shipment, ...allowed: FboStatus[]) {
  if (!allowed.includes(s.status)) throw new StockError(`Сейчас это действие недоступно: поставка в статусе «${STATUS_LABEL[s.status]}»`);
}

async function fail(id: string, err: unknown): Promise<never> {
  const msg = err instanceof Error ? err.message : String(err);
  await prisma.fboShipment.update({ where: { id }, data: { lastError: msg } }).catch(() => {});
  throw err instanceof StockError ? err : new StockError(msg);
}

// Состав поставки по SKU Ozon
function itemsBySku(s: Shipment) {
  const m = new Map<string, { sku: string; offerId: string; name: string; quantity: number }>();
  for (const c of s.cargoes) {
    const spec = c.quant.quantType.productItem.spec;
    const name = c.quant.quantType.productItem.name;
    if (!spec?.ozonOfferId || !spec.ozonSku) throw new StockError(`У SKU «${name}» не указан артикул Ozon или не сверен SKU`);
    const v = m.get(spec.ozonSku) ?? { sku: spec.ozonSku, offerId: spec.ozonOfferId, name, quantity: 0 };
    v.quantity += c.quant.units;
    m.set(spec.ozonSku, v);
  }
  return [...m.values()];
}

// 1. Подбор и резерв квантов: по каждому типу — нужное количество, старые партии первыми (FEFO)
export async function createShipment(userId: string, picks: { quantTypeId: string; count: number }[], comment?: string | null) {
  return prisma.$transaction(async (tx) => {
    const quantIds: string[] = [];
    for (const p of picks.filter((x) => x.count > 0)) {
      const qt = await tx.quantType.findUnique({ where: { id: p.quantTypeId }, include: { productItem: { include: { spec: true } } } });
      if (!qt) throw new StockError('Тип кванта не найден');
      if (!qt.productItem.spec?.ozonOfferId || !qt.productItem.spec.ozonSku) {
        throw new StockError(`У SKU «${qt.productItem.name}» не указан артикул Ozon или не сверен SKU (Карточки SKU)`);
      }
      const free = await tx.quant.findMany({
        where: { quantTypeId: qt.id, status: 'ASSEMBLED' },
        include: { lot: true },
        orderBy: { number: 'asc' },
      });
      free.sort((a, b) => (a.lot.expiresAt?.getTime() ?? Infinity) - (b.lot.expiresAt?.getTime() ?? Infinity) || a.number.localeCompare(b.number));
      if (free.length < p.count) throw new StockError(`«${qt.name}»: на складе ${free.length} кв., нужно ${p.count}`);
      quantIds.push(...free.slice(0, p.count).map((q) => q.id));
    }
    if (quantIds.length === 0) throw new StockError('Не выбрано ни одного кванта');
    if (quantIds.length > MAX_BOXES) throw new StockError(`Ozon принимает не больше ${MAX_BOXES} коробок в поставке, выбрано ${quantIds.length}. Разбейте на несколько поставок.`);

    const { count } = await tx.quant.updateMany({ where: { id: { in: quantIds }, status: 'ASSEMBLED' }, data: { status: 'RESERVED' } });
    if (count !== quantIds.length) throw new StockError('Часть квантов уже зарезервирована другой поставкой, повторите');
    const number = await nextNumber('ПС', async (startsWith) => {
      const last = await tx.fboShipment.findFirst({ where: { number: { startsWith } }, orderBy: { number: 'desc' } });
      return last?.number ?? null;
    });
    return tx.fboShipment.create({
      data: {
        number, userId, comment: comment || null,
        cargoes: { create: quantIds.map((quantId, sort) => ({ quantId, sort })) },
      },
    });
  }, { isolationLevel: 'Serializable' });
}

// 2. Черновик в Ozon и расчёт складов
export async function createOzonDraft(id: string, opt: {
  supplyType: 'CROSSDOCK' | 'DIRECT'; clusterId: string; clusterName?: string | null;
  dropOffWarehouseId?: string | null; dropOffName?: string | null; dropOffType?: string | null;
}) {
  const s = await load(id);
  expect(s, 'DRAFT', 'OZON_DRAFT');
  try {
    const items = itemsBySku(s).map((i) => ({ sku: Number(i.sku), quantity: i.quantity }));
    const cluster_info = { macrolocal_cluster_id: Number(opt.clusterId), items };
    let created: any;
    if (opt.supplyType === 'CROSSDOCK') {
      if (!opt.dropOffWarehouseId) throw new StockError('Для кросс-докинга выберите пункт отгрузки');
      created = await ozon('/v1/draft/crossdock/create', {
        cluster_info, deletion_sku_mode: 'PARTIAL',
        delivery_info: {
          type: 'DROPOFF',
          drop_off_warehouse: { warehouse_id: Number(opt.dropOffWarehouseId), warehouse_type: (opt.dropOffType ?? 'DELIVERY_POINT').replace(/^WAREHOUSE_TYPE_/, '') },
        },
      }, id);
    } else {
      created = await ozon('/v1/draft/direct/create', { cluster_info, deletion_sku_mode: 'PARTIAL' }, id);
    }
    if (created.errors?.length) throw new StockError(describeDraftErrors(created.errors));
    const draftId = created.draft_id;
    const info = await poll(() => ozon('/v2/draft/create/info', { draft_id: draftId }, id), (r: any) => r.status !== 'IN_PROGRESS');
    if (info.status !== 'SUCCESS') throw new StockError(info.errors?.length ? describeDraftErrors(info.errors) : `Черновик не создан: ${info.status}`);
    const cluster = info.clusters?.[0];
    return prisma.fboShipment.update({
      where: { id },
      data: {
        status: 'OZON_DRAFT', supplyType: opt.supplyType,
        clusterId: String(opt.clusterId), clusterName: cluster?.cluster_name ?? opt.clusterName ?? null,
        dropOffWarehouseId: opt.supplyType === 'CROSSDOCK' ? String(opt.dropOffWarehouseId) : null,
        dropOffName: opt.supplyType === 'CROSSDOCK' ? opt.dropOffName ?? null : null,
        dropOffType: opt.supplyType === 'CROSSDOCK' ? opt.dropOffType ?? null : null,
        ozonDraftId: String(draftId), draftCreatedAt: new Date(), draftWarehouses: cluster?.warehouses ?? [],
        lastError: null,
      },
    });
  } catch (e) { return fail(id, e); }
}

function describeDraftErrors(errors: any[]): string {
  return errors.map((e) => {
    const rejected = (e.items_validation ?? []).flatMap((v: any) => (v.rejected_items ?? []).map((r: any) => `SKU ${r.sku}: ${(r.reasons ?? []).join(', ')}`));
    return [e.error_message, e.message, ...(e.error_reasons ?? []), ...rejected].filter((x) => x && x !== 'UNSPECIFIED').join('; ');
  }).join(' | ') || 'Ozon отклонил черновик';
}

function draftAlive(s: Shipment) {
  if (!s.ozonDraftId || !s.draftCreatedAt) throw new StockError('Черновик Ozon не создан');
  if (Date.now() - s.draftCreatedAt.getTime() > DRAFT_TTL_MS) throw new StockError('Черновик Ozon устарел (живёт 30 минут) — создайте его заново');
}

function clusterWarehouses(s: Shipment, storageWarehouseId?: string | null) {
  const w: any = { macrolocal_cluster_id: Number(s.clusterId) };
  if (s.supplyType === 'DIRECT') {
    if (!storageWarehouseId) throw new StockError('Выберите склад размещения');
    w.storage_warehouse_id = Number(storageWarehouseId);
  }
  return [w];
}

// 3. Свободные тайм-слоты (на 28 дней вперёд)
export async function getTimeslots(id: string, storageWarehouseId?: string | null) {
  const s = await load(id);
  expect(s, 'OZON_DRAFT');
  draftAlive(s);
  const from = new Date();
  const to = new Date(Date.now() + 27 * 86400_000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const r = await ozon('/v2/draft/timeslot/info', {
    draft_id: Number(s.ozonDraftId), date_from: ymd(from), date_to: ymd(to),
    supply_type: s.supplyType, selected_cluster_warehouses: clusterWarehouses(s, storageWarehouseId),
  }, id);
  if (r.error_reason && r.error_reason !== 'UNSPECIFIED') throw new StockError(`Ozon: ${r.error_reason}`);
  const t = r.result?.drop_off_warehouse_timeslots;
  return {
    timezone: t?.warehouse_timezone ?? null,
    days: (t?.days ?? []).map((d: any) => ({
      date: d.date_in_timezone,
      slots: (d.timeslots ?? []).map((x: any) => ({ from: x.from_in_timezone, to: x.to_in_timezone })),
    })).filter((d: any) => d.slots.length),
  };
}

// 4. Заявка по черновику с выбранным слотом
export async function book(id: string, opt: { from: string; to: string; storageWarehouseId?: string | null; storageName?: string | null }) {
  const s = await load(id);
  expect(s, 'OZON_DRAFT');
  draftAlive(s);
  try {
    const r = await ozon('/v2/draft/supply/create', {
      draft_id: Number(s.ozonDraftId), supply_type: s.supplyType,
      selected_cluster_warehouses: clusterWarehouses(s, opt.storageWarehouseId),
      timeslot: { from_in_timezone: opt.from, to_in_timezone: opt.to },
    }, id);
    const errs = (r.error_reasons ?? []).filter((x: string) => x !== 'UNSPECIFIED');
    if (errs.length) throw new StockError(`Ozon не создал заявку: ${errs.join(', ')}`);
    const st = await poll(() => ozon('/v2/draft/supply/create/status', { draft_id: Number(s.ozonDraftId) }, id), (x: any) => x.status !== 'IN_PROGRESS', 20);
    if (st.status !== 'SUCCESS' || !st.order_id) {
      throw new StockError(`Заявка не создана: ${st.status}${st.error_reasons?.length ? ' — ' + st.error_reasons.join(', ') : ''}`);
    }
    await prisma.fboShipment.update({
      where: { id },
      data: {
        status: 'BOOKED', ozonOrderId: String(st.order_id), timeslotFrom: opt.from, timeslotTo: opt.to,
        storageWarehouseId: opt.storageWarehouseId ?? null, storageName: opt.storageName ?? null, lastError: null,
      },
    });
    return syncShipment(id);
  } catch (e) { return fail(id, e); }
}

// 5. Грузоместа: 1 квант = 1 коробка с составом
export async function setCargoes(id: string) {
  let s = await load(id);
  expect(s, 'BOOKED', 'CARGOES_SET');
  try {
    if (!s.ozonSupplyId) { await syncShipment(id); s = await load(id); }
    if (!s.ozonSupplyId) throw new StockError('Ozon ещё не выдал номер поставки — повторите через минуту');
    const cargoes = s.cargoes.map((c) => ({
      key: c.quant.number,
      value: {
        type: 'BOX',
        items: [{
          offer_id: c.quant.quantType.productItem.spec!.ozonOfferId!,
          quantity: c.quant.units,
          ...(c.quant.lot.expiresAt ? { expires_at: c.quant.lot.expiresAt.toISOString() } : {}),
        }],
      },
    }));
    const r = await ozon('/v1/cargoes/create', { supply_id: Number(s.ozonSupplyId), delete_current_version: true, cargoes }, id);
    if (r.errors && (r.errors.error_reasons?.length || r.errors.items_validation?.length)) throw new StockError(describeCargoErrors(r.errors));
    const info = await poll(() => ozon('/v2/cargoes/create/info', { operation_id: r.operation_id }, id), (x: any) => x.status !== 'IN_PROGRESS', 20);
    if (info.status !== 'SUCCESS') throw new StockError(info.errors ? describeCargoErrors(info.errors) : `Грузоместа не установлены: ${info.status}`);
    const byKey = new Map<string, string>((info.result?.cargoes ?? []).map((c: any) => [c.key, String(c.value?.cargo_id)]));
    for (const c of s.cargoes) {
      await prisma.fboCargo.update({ where: { id: c.id }, data: { ozonCargoId: byKey.get(c.quant.number) ?? null } });
    }
    return prisma.fboShipment.update({ where: { id }, data: { status: 'CARGOES_SET', labelS3Key: null, lastError: null } });
  } catch (e) { return fail(id, e); }
}

function describeCargoErrors(errors: any): string {
  const v = (errors.items_validation ?? []).map((x: any) => `${x.cargo_key ?? ''} ${x.item ?? x.barcode ?? ''}: ${x.type}`.trim());
  return ['Ozon отклонил грузоместа', ...(errors.error_reasons ?? []), ...v].join('; ');
}

// 6. Этикетки грузомест: PDF из Ozon сохраняется в S3
export async function makeLabels(id: string) {
  const s = await load(id);
  expect(s, 'CARGOES_SET', 'LABELS_READY');
  try {
    const ids = s.cargoes.map((c) => c.ozonCargoId).filter(Boolean);
    if (ids.length !== s.cargoes.length) throw new StockError('Не у всех квантов есть номер грузоместа — передайте грузоместа заново');
    const r = await ozon('/v1/cargoes-label/create', { supply_id: Number(s.ozonSupplyId), cargoes: ids.map((x) => ({ cargo_id: Number(x) })) }, id);
    if (r.errors?.error_reasons?.length) throw new StockError(`Ozon: ${r.errors.error_reasons.join(', ')}`);
    const g = await poll(() => ozon('/v1/cargoes-label/get', { operation_id: r.operation_id }, id), (x: any) => x.status !== 'IN_PROGRESS', 20);
    if (g.status !== 'SUCCESS' || !g.result?.file_url) throw new StockError(`Этикетки не сформированы: ${g.status} ${g.errors?.error_reasons?.join(', ') ?? ''}`);
    const pdf = await ozonGetFile(g.result.file_url);
    const key = `fbo/${id}/cargo-labels.pdf`;
    await uploadFile(key, pdf, 'application/pdf');
    return prisma.fboShipment.update({ where: { id }, data: { status: 'LABELS_READY', labelS3Key: key, lastError: null } });
  } catch (e) { return fail(id, e); }
}

// 7. Отгрузка: кванты списываются со склада документом «Отгрузка»
export async function ship(id: string, userId: string) {
  const s = await load(id);
  expect(s, 'LABELS_READY', 'CARGOES_SET', 'BOOKED');
  return prisma.$transaction(async (tx) => {
    const doc = await tx.stockDoc.create({
      data: {
        type: 'SHIPMENT', status: 'POSTED', postedAt: new Date(), number: await nextDocNumber(tx, 'SHIPMENT'),
        userId, comment: `FBO ${s.number}${s.ozonOrderNumber ? ` · заявка Ozon ${s.ozonOrderNumber}` : ''}`,
      },
    });
    for (const c of s.cargoes) {
      const q = await tx.quant.findUnique({ where: { id: c.quantId } });
      if (q?.status !== 'RESERVED') throw new StockError(`Квант ${c.quant.number} не в резерве этой поставки`);
      await consume(tx, doc.id, c.quant.lotId, 'IN_QUANT', c.quant.units, c.quant.quantType.productItem.name);
    }
    await tx.quant.updateMany({ where: { id: { in: s.cargoes.map((c) => c.quantId) } }, data: { status: 'SHIPPED' } });
    return tx.fboShipment.update({ where: { id }, data: { status: 'SHIPPED', shippedAt: new Date(), stockDocId: doc.id, lastError: null } });
  }, { isolationLevel: 'Serializable' });
}

// Отмена: заявка в Ozon (если создана) отменяется, кванты возвращаются на склад
export async function cancelShipment(id: string) {
  const s = await load(id);
  if (s.status === 'SHIPPED' || s.status === 'COMPLETED') throw new StockError('Поставка уже отгружена — отменить нельзя');
  if (s.status === 'CANCELLED') return s;
  try {
    if (s.ozonOrderId && s.ozonState !== 'CANCELLED') {
      const r = await ozon('/v1/supply-order/cancel', { order_id: Number(s.ozonOrderId) }, id);
      const st = await poll(() => ozon('/v1/supply-order/cancel/status', { operation_id: r.operation_id }, id), (x: any) => x.status !== 'IN_PROGRESS', 15);
      if (st.status !== 'SUCCESS' && !st.result?.is_order_cancelled) {
        throw new StockError(`Ozon не отменил заявку: ${(st.error_reasons ?? []).join(', ') || st.status}`);
      }
    }
    await prisma.$transaction([
      prisma.quant.updateMany({ where: { id: { in: s.cargoes.map((c) => c.quantId) }, status: 'RESERVED' }, data: { status: 'ASSEMBLED' } }),
      prisma.fboShipment.update({ where: { id }, data: { status: 'CANCELLED', lastError: null } }),
    ]);
    return load(id);
  } catch (e) { return fail(id, e); }
}

// Обновление статуса заявки из Ozon
export async function syncShipment(id: string) {
  const s = await load(id);
  if (!s.ozonOrderId) return s;
  const r = await ozon('/v3/supply-order/get', { order_ids: [Number(s.ozonOrderId)] }, id);
  const o = r.orders?.[0];
  if (!o) return s;
  const supply = o.supplies?.[0];
  const ts = o.timeslot?.timeslot;
  await prisma.fboShipment.update({
    where: { id },
    data: {
      ozonOrderNumber: o.order_number ?? s.ozonOrderNumber,
      ozonSupplyId: supply?.supply_id ? String(supply.supply_id) : s.ozonSupplyId,
      ozonState: o.state, ozonStateAt: o.state_updated_date ? new Date(o.state_updated_date) : new Date(),
      storageName: supply?.storage_warehouse?.name ?? s.storageName,
      dropOffName: o.drop_off_warehouse?.name ?? s.dropOffName,
      ...(ts && !s.timeslotFrom ? { timeslotFrom: ts.from, timeslotTo: ts.to } : {}),
      ...(o.state === 'COMPLETED' && s.status === 'SHIPPED' ? { status: 'COMPLETED' } : {}),
    },
  });
  return load(id);
}

// Фоновая синхронизация всех активных поставок
export async function syncAllShipments(): Promise<void> {
  const active = await prisma.fboShipment.findMany({
    where: { ozonOrderId: { not: null }, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
    select: { id: true },
  });
  for (const a of active) {
    try { await syncShipment(a.id); } catch (e) { console.warn('[fbo sync]', a.id, (e as Error).message); }
  }
}

// Сверка карточек SKU с Ozon по артикулам: SKU Ozon и название
export async function syncSkus(): Promise<{ updated: number; notFound: string[] }> {
  const specs = await prisma.productSpec.findMany({ where: { ozonOfferId: { not: null } } });
  if (specs.length === 0) return { updated: 0, notFound: [] };
  const r = await ozon('/v3/product/info/list', { offer_id: specs.map((s) => s.ozonOfferId!) });
  const byOffer = new Map<string, any>((r.items ?? []).map((it: any) => [it.offer_id, it]));
  const notFound: string[] = [];
  let updated = 0;
  for (const sp of specs) {
    const it = byOffer.get(sp.ozonOfferId!);
    if (!it) { notFound.push(sp.ozonOfferId!); continue; }
    // Обычный (не коробочный) SKU товара
    const general = (it.sources ?? []).find((x: any) => x.shipment_type === 'SHIPMENT_TYPE_GENERAL' && x.source !== 'fbs');
    const sku = String(general?.sku ?? it.sku);
    await prisma.productSpec.update({ where: { id: sp.id }, data: { ozonSku: sku, ozonName: it.name } });
    updated++;
  }
  return { updated, notFound };
}
