import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db.js';

type Identity = { id: string; role: string; houses: string[] };
type Location = { locationType: string; houseCode: string | null; room: string | null };
const u = (request: unknown) => (request as { identity: Identity }).identity;
const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode });
};
const admin = (who: Identity) => who.role === 'ADMIN';
const writable = (who: Identity) => {
  if (who.role === 'KETOAN') fail('Kế toán chỉ có quyền xem tài sản', 403);
};
const canHouse = (who: Identity, house: string | null) => admin(who) || !!house && who.houses.includes(house);
const requireHouse = (who: Identity, house: string | null) => {
  if (!canHouse(who, house)) fail('Tòa nhà nằm ngoài phạm vi được cấp quyền', 403);
};
const requireAdmin = (who: Identity) => {
  if (!admin(who)) fail('Chỉ quản trị viên được thực hiện', 403);
};
const date = z.iso.date().nullable().optional();
const locationInput = z.object({
  locationType: z.enum(['CENTRAL', 'BUILDING', 'ROOM', 'COMMON', 'REPAIR', 'OTHER']),
  houseCode: z.string().trim().min(1).nullable().optional(),
  room: z.string().trim().min(1).nullable().optional()
});
const assetFields = z.object({
  category: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(160),
  brand: z.string().trim().max(100).default(''),
  model: z.string().trim().max(100).default(''),
  purchaseDate: date,
  purchaseCost: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  warrantyUntil: date,
  conditionPct: z.coerce.number().int().min(0).max(100).default(100),
  note: z.string().max(2000).default(''),
  imageUrl: z.union([z.url().max(2000), z.literal('')]).nullable().optional()
});
const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).default(''),
  house: z.string().trim().default('')
});
const loc = (data: z.infer<typeof locationInput>): Location => ({
  locationType: data.locationType,
  houseCode: data.houseCode?.trim() || null,
  room: data.locationType === 'ROOM' ? data.room?.trim() || null : null
});
const num = (n: bigint | number | null | undefined) => n == null ? null : Number(n);
const serialize = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item));
const scope = (who: Identity): Prisma.AssetWhereInput => admin(who) ? {} : {
  houseCode: { in: who.houses }
};
const stockScope = (who: Identity) => admin(who) ? {} : {
  OR: who.houses.flatMap(house => [
    { locationKey: `BUILDING:${house}` },
    { locationKey: { startsWith: `ROOM:${house}:` } }
  ])
};
async function validateLocation(location: Location) {
  if (location.locationType === 'CENTRAL') {
    if (location.houseCode || location.room) fail('Kho trung tâm không gắn tòa nhà hoặc phòng');
    return;
  }
  if (!location.houseCode) fail('Vị trí yêu cầu mã tòa nhà');
  const house = await db.house.findFirst({ where: { code: location.houseCode!, active: true } });
  if (!house) fail('Tòa nhà không tồn tại hoặc đã ngừng hoạt động');
  if (location.locationType === 'ROOM') {
    if (!location.room) fail('Chưa chọn phòng');
    const room = await db.due.findFirst({ where: { houseCode: location.houseCode!, room: location.room! }, select: { id: true } });
    if (!room) fail('Phòng chưa xuất hiện trong dữ liệu hóa đơn');
  }
}
function requireLocation(who: Identity, location: Location, write: boolean) {
  if (write) writable(who);
  if (location.locationType === 'CENTRAL') {
    if (write) requireAdmin(who);
  } else requireHouse(who, location.houseCode);
}
function keyLocation(value: string): { key: string; house: string | null } {
  if (value === 'CENTRAL') return { key: value, house: null };
  const match = /^(BUILDING|ROOM):([^:]+)(?::([^:]+))?$/.exec(value);
  if (!match || match[1] === 'ROOM' && !match[3] || match[1] === 'BUILDING' && match[3]) fail('Vị trí kho không hợp lệ');
  return { key: value, house: match![2] };
}
async function validateStockLocation(who: Identity, key: string, write: boolean) {
  const place = keyLocation(key);
  if (write) writable(who);
  if (place.house) {
    requireHouse(who, place.house);
    const house = await db.house.findFirst({ where: { code: place.house, active: true } });
    if (!house) fail('Tòa nhà không tồn tại');
    const segments = key.split(':');
    if (segments[0] === 'ROOM' && !await db.due.findFirst({ where: { houseCode: place.house, room: segments[2] }, select: { id: true } }))
      fail('Phòng chưa xuất hiện trong dữ liệu hóa đơn');
  } else if (write) requireAdmin(who);
}
async function transaction<T>(task: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(task, { isolationLevel: 'Serializable', timeout: 12000 });
}
async function lock(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'vincent-assets:'+key}))`;
}
const movementInput = locationInput.extend({
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(2).max(500),
  requestKey: z.uuid()
});
const rentalInput = z.object({
  assetId: z.uuid(), houseCode: z.string().min(1), room: z.string().min(1),
  startAt: z.iso.date(), expectedEndAt: date,
  monthlyFee: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  included: z.boolean().default(false),
  handoverNote: z.string().max(2000).default(''),
  handoverDoc: z.string().max(2000).nullable().optional(),
  requestKey: z.uuid()
});

export function registerAssetsRoutes(app: FastifyInstance) {
  app.get('/api/assets/overview', async request => {
    const who = u(request);
    const [assets, rentals, supplies, maintenance, counts] = await Promise.all([
      db.asset.findMany({ where: scope(who), select: { id: true, category: true, houseCode: true, purchaseCost: true, warrantyUntil: true, status: true } }),
      db.equipmentRental.findMany({ where: { endedAt: null, ...(admin(who) ? {} : { houseCode: { in: who.houses } }) }, select: { monthlyFee: true, included: true } }),
      db.stockBalance.findMany({ where: stockScope(who), include: { supply: { select: { name: true, sku: true, minimumQty: true } } } }),
      db.assetMaintenance.count({ where: { status: 'OPEN', asset: scope(who) } }),
      db.stockCount.count({ where: { status: 'DRAFT', ...(admin(who) ? {} : { OR: who.houses.flatMap(h => [
        { locationKey: `BUILDING:${h}` }, { locationKey: { startsWith: `ROOM:${h}:` } }
      ]) }) } })
    ]);
    const byHouse: Record<string, number> = {}, byCategory: Record<string, number> = {};
    for (const item of assets) {
      const house = item.houseCode || 'Kho trung tâm';
      byHouse[house] = (byHouse[house] || 0) + 1;
      byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    }
    return {
      totalAssets: assets.length, available: assets.filter(a => a.status === 'AVAILABLE').length,
      rented: assets.filter(a => a.status === 'RENTED').length,
      repairing: maintenance,
      purchaseValue: admin(who) ? assets.reduce((sum, a) => sum + Number(a.purchaseCost || 0n), 0) : null,
      activeRentals: rentals.length, monthlyEstimate: admin(who) ? rentals.reduce((sum, r) => sum + (r.included ? 0 : Number(r.monthlyFee)), 0) : null,
      expiringWarranty: assets.filter(a => a.warrantyUntil && a.warrantyUntil >= new Date() && a.warrantyUntil <= new Date(Date.now() + 30 * 86400000)).length,
      lowStock: supplies.filter(s => s.quantity < s.supply.minimumQty).length, openCounts: counts, byHouse, byCategory
    };
  });

  app.get('/api/assets/items', async request => {
    const who = u(request), q = pagination.extend({ category: z.string().default(''), status: z.string().default('') }).parse(request.query);
    const where: Prisma.AssetWhereInput = {
      AND: [scope(who), q.house ? { houseCode: q.house } : {}, q.category ? { category: q.category } : {}, q.status ? { status: q.status } : {},
        q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }, { brand: { contains: q.search, mode: 'insensitive' } }] } : {}]
    };
    const [total, rows] = await Promise.all([
      db.asset.count({ where }),
      db.asset.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.size, take: q.size })
    ]);
    return { total, page: q.page, rows: rows.map(r => ({
      ...r, purchaseCost: admin(who) ? num(r.purchaseCost) : null
    })) };
  });

  app.post('/api/assets/items', async request => {
    const who = u(request);
    writable(who);
    const body = assetFields.merge(locationInput).parse(request.body);
    const place = loc(body);
    await validateLocation(place);
    requireLocation(who, place, true);
    if (!admin(who) && body.purchaseCost != null) fail('Nhân viên không được nhập giá trị tài sản', 403);
    const prefix: Record<string, string> = { 'Tủ lạnh': 'TL', 'Máy giặt': 'MG', 'Bếp từ': 'BT' };
    const categoryPrefix = prefix[body.category] || 'TS';
    return transaction(async tx => {
      await lock(tx, 'asset-sequence:' + categoryPrefix);
      const sequence = await tx.assetSequence.upsert({
        where: { prefix: categoryPrefix }, create: { prefix: categoryPrefix, nextNo: 2 },
        update: { nextNo: { increment: 1 } }
      });
      const code = `${categoryPrefix}-${String(sequence.nextNo - 1).padStart(4, '0')}`;
      const row = await tx.asset.create({
        data: {
          code, category: body.category, name: body.name, brand: body.brand, model: body.model,
          purchaseDate: body.purchaseDate ? new Date(body.purchaseDate) : null,
          purchaseCost: body.purchaseCost == null ? null : BigInt(body.purchaseCost),
          warrantyUntil: body.warrantyUntil ? new Date(body.warrantyUntil) : null,
          conditionPct: body.conditionPct, note: body.note, imageUrl: body.imageUrl || null,
          ...place, createdById: who.id, updatedById: who.id
        }
      });
      await tx.assetMovement.create({
        data: { assetId: row.id, fromType: 'NEW', toType: place.locationType, toHouse: place.houseCode,
          toRoom: place.room, reason: 'Đăng ký tài sản', actorId: who.id, requestKey: crypto.randomUUID() }
      });
      return serialize(row);
    });
  });

  app.patch('/api/assets/items/:id', async request => {
    const who = u(request), { id } = z.object({ id: z.uuid() }).parse(request.params);
    writable(who);
    const body = assetFields.partial().extend({ expectedVersion: z.number().int().min(1) }).parse(request.body);
    const original = await db.asset.findUnique({ where: { id } });
    if (!original) fail('Không tìm thấy tài sản', 404);
    requireLocation(who, original!, true);
    if (!admin(who) && body.purchaseCost !== undefined) fail('Nhân viên không được sửa giá trị tài sản', 403);
    if (original!.status === 'DISPOSED') fail('Tài sản đã thanh lý', 409);
    return transaction(async tx => {
      const result = await tx.asset.updateMany({
        where: { id, version: body.expectedVersion },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.category !== undefined && { category: body.category }),
          ...(body.brand !== undefined && { brand: body.brand }),
          ...(body.model !== undefined && { model: body.model }),
          ...(body.note !== undefined && { note: body.note }),
          ...(body.imageUrl !== undefined && { imageUrl: body.imageUrl }),
          ...(body.conditionPct !== undefined && { conditionPct: body.conditionPct }),
          ...(body.purchaseDate !== undefined && { purchaseDate: body.purchaseDate ? new Date(body.purchaseDate) : null }),
          ...(body.warrantyUntil !== undefined && { warrantyUntil: body.warrantyUntil ? new Date(body.warrantyUntil) : null }),
          ...(body.purchaseCost !== undefined && { purchaseCost: body.purchaseCost == null ? null : BigInt(body.purchaseCost) }),
          version: { increment: 1 }, updatedById: who.id
        }
      });
      if (!result.count) fail('Tài sản đã được thay đổi bởi người khác', 409);
      return serialize(await tx.asset.findUniqueOrThrow({ where: { id } }));
    });
  });

  app.post('/api/assets/items/:id/move', async request => {
    const who = u(request), { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = movementInput.parse(request.body), target = loc(body);
    writable(who);
    await validateLocation(target);
    return transaction(async tx => {
      await lock(tx, 'asset:' + id);
      const duplicate = await tx.assetMovement.findUnique({ where: { requestKey: body.requestKey } });
      if (duplicate) {
        if (duplicate.assetId !== id) fail('Mã thao tác đã được sử dụng', 409);
        return { id: duplicate.id, repeated: true };
      }
      const item = await tx.asset.findUnique({ where: { id } });
      if (!item) fail('Không tìm thấy tài sản', 404);
      const from: Location = { locationType: item!.locationType, houseCode: item!.houseCode, room: item!.room };
      requireLocation(who, from, true);
      requireLocation(who, target, true);
      if (item!.status === 'RENTED' || item!.status === 'DISPOSED') fail('Tài sản đang thuê hoặc đã thanh lý', 409);
      if (item!.version !== body.expectedVersion) fail('Tài sản đã được thay đổi', 409);
      if (JSON.stringify(from) === JSON.stringify(target)) fail('Vị trí mới trùng vị trí hiện tại');
      const changed = await tx.asset.updateMany({ where: { id, version: item!.version }, data: { ...target, version: { increment: 1 }, updatedById: who.id } });
      if (!changed.count) fail('Xung đột điều chuyển tài sản', 409);
      return tx.assetMovement.create({ data: {
        assetId: id, fromType: from.locationType, fromHouse: from.houseCode, fromRoom: from.room,
        toType: target.locationType, toHouse: target.houseCode, toRoom: target.room,
        reason: body.reason, actorId: who.id, requestKey: body.requestKey
      } });
    });
  });

  app.post('/api/assets/items/:id/dispose', async request => {
    const who = u(request), { id } = z.object({ id: z.uuid() }).parse(request.params);
    requireAdmin(who);
    const body = z.object({ reason: z.string().trim().min(3).max(500), expectedVersion: z.number().int().min(1) }).parse(request.body);
    return transaction(async tx => {
      await lock(tx, 'asset:' + id);
      const item = await tx.asset.findUnique({ where: { id } });
      if (!item) fail('Không tìm thấy tài sản', 404);
      if (item!.status === 'RENTED' || item!.status === 'DISPOSED') fail('Không thể thanh lý tài sản này', 409);
      const result = await tx.asset.updateMany({ where: { id, version: body.expectedVersion }, data: { status: 'DISPOSED', version: { increment: 1 }, updatedById: who.id } });
      if (!result.count) fail('Tài sản đã được thay đổi', 409);
      return tx.assetMovement.create({ data: {
        assetId: id, fromType: item!.locationType, fromHouse: item!.houseCode, fromRoom: item!.room,
        toType: 'DISPOSED', reason: body.reason, actorId: who.id, requestKey: crypto.randomUUID()
      } });
    });
  });

  app.get('/api/assets/rentals', async request => {
    const who = u(request), q = pagination.extend({ active: z.enum(['true', 'false', 'all']).default('all') }).parse(request.query);
    const where: Prisma.EquipmentRentalWhereInput = {
      AND: [admin(who) ? {} : { houseCode: { in: who.houses } },
        q.house ? { houseCode: q.house } : {},
        q.active === 'all' ? {} : { endedAt: q.active === 'true' ? null : { not: null } },
        q.search ? { OR: [{ room: { contains: q.search, mode: 'insensitive' } }, { asset: { code: { contains: q.search, mode: 'insensitive' } } }] } : {}]
    };
    const [total, rows] = await Promise.all([db.equipmentRental.count({ where }), db.equipmentRental.findMany({
      where, include: { asset: { select: { code: true, name: true } } }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.size, take: q.size
    })]);
    return { total, rows: rows.map(r => ({ ...r, monthlyFee: admin(who) ? Number(r.monthlyFee) : null })) };
  });

  app.post('/api/assets/rentals', async request => {
    const who = u(request), body = rentalInput.parse(request.body);
    writable(who);
    requireHouse(who, body.houseCode);
    if (!admin(who) && body.monthlyFee) fail('Nhân viên không được cập nhật đơn giá thuê', 403);
    const target: Location = { locationType: 'ROOM', houseCode: body.houseCode, room: body.room };
    await validateLocation(target);
    if (body.expectedEndAt && body.expectedEndAt < body.startAt) fail('Ngày kết thúc dự kiến không hợp lệ');
    return transaction(async tx => {
      await lock(tx, 'asset:' + body.assetId);
      const duplicate = await tx.assetMovement.findUnique({ where: { requestKey: body.requestKey } });
      if (duplicate) {
        if (duplicate.assetId !== body.assetId) fail('Mã thao tác đã được sử dụng', 409);
        return { repeated: true };
      }
      const item = await tx.asset.findUnique({ where: { id: body.assetId } });
      if (!item) fail('Không tìm thấy tài sản', 404);
      requireLocation(who, { locationType: item!.locationType, houseCode: item!.houseCode, room: item!.room }, true);
      if (item!.status !== 'AVAILABLE') fail('Thiết bị không khả dụng để cho thuê', 409);
      if (await tx.equipmentRental.findFirst({ where: { assetId: body.assetId, endedAt: null } })) fail('Thiết bị đã có hợp đồng đang thuê', 409);
      const rental = await tx.equipmentRental.create({ data: {
        assetId: body.assetId, houseCode: body.houseCode, room: body.room, startAt: new Date(body.startAt),
        expectedEndAt: body.expectedEndAt ? new Date(body.expectedEndAt) : null,
        monthlyFee: BigInt(body.monthlyFee), included: body.included,
        handoverNote: body.handoverNote, handoverDoc: body.handoverDoc || null, actorId: who.id
      } });
      await tx.asset.update({ where: { id: body.assetId }, data: { status: 'RENTED', ...target, version: { increment: 1 }, updatedById: who.id } });
      await tx.assetMovement.create({ data: {
        assetId: body.assetId, fromType: item!.locationType, fromHouse: item!.houseCode, fromRoom: item!.room,
        toType: 'ROOM', toHouse: body.houseCode, toRoom: body.room,
        reason: 'Bàn giao thuê ' + rental.id, actorId: who.id, requestKey: body.requestKey
      } });
      return serialize(rental);
    });
  });

  app.post('/api/assets/rentals/:id/return', async request => {
    const who = u(request), { id } = z.object({ id: z.uuid() }).parse(request.params);
    writable(who);
    const body = z.object({ endedAt: z.iso.date(), note: z.string().max(2000).default(''), to: locationInput, requestKey: z.uuid() }).parse(request.body);
    const target = loc(body.to);
    await validateLocation(target);
    return transaction(async tx => {
      const existing = await tx.equipmentRental.findUnique({ where: { id } });
      if (!existing) fail('Không tìm thấy lượt thuê', 404);
      await lock(tx, 'asset:' + existing!.assetId);
      requireHouse(who, existing!.houseCode);
      requireLocation(who, target, true);
      const duplicate = await tx.assetMovement.findUnique({ where: { requestKey: body.requestKey } });
      if (duplicate) return { repeated: true };
      const rental = await tx.equipmentRental.findUniqueOrThrow({ where: { id } });
      if (rental.endedAt) fail('Thiết bị đã được trả', 409);
      if (new Date(body.endedAt) < rental.startAt) fail('Ngày trả trước ngày thuê');
      await tx.equipmentRental.update({ where: { id }, data: { endedAt: new Date(body.endedAt), returnNote: body.note } });
      await tx.asset.update({ where: { id: rental.assetId }, data: { status: 'AVAILABLE', ...target, version: { increment: 1 }, updatedById: who.id } });
      return tx.assetMovement.create({ data: {
        assetId: rental.assetId, fromType: 'ROOM', fromHouse: rental.houseCode, fromRoom: rental.room,
        toType: target.locationType, toHouse: target.houseCode, toRoom: target.room,
        reason: 'Thu hồi thuê ' + id + (body.note ? ': ' + body.note : ''), actorId: who.id, requestKey: body.requestKey
      } });
    });
  });

  app.get('/api/assets/supplies', async request => {
    const who = u(request), q = pagination.parse(request.query);
    const where: Prisma.SupplyWhereInput = q.search ? { OR: [
      { sku: { contains: q.search, mode: 'insensitive' } },
      { name: { contains: q.search, mode: 'insensitive' } }
    ] } : {};
    const [total, rows] = await Promise.all([db.supply.count({ where }), db.supply.findMany({
      where, include: { balances: { where: stockScope(who) } }, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.size, take: q.size
    })]);
    return { total, rows: rows.map(row => ({ ...row, referencePrice: admin(who) ? num(row.referencePrice) : null })) };
  });

  app.post('/api/assets/supplies', async request => {
    const who = u(request);
    requireAdmin(who);
    const body = z.object({
      sku: z.string().trim().min(2).max(50), name: z.string().trim().min(2).max(150),
      category: z.string().trim().min(1).max(80), unit: z.string().trim().min(1).max(40),
      referencePrice: z.number().int().min(0).default(0), minimumQty: z.number().int().min(0).default(0),
      note: z.string().max(2000).default('')
    }).parse(request.body);
    return serialize(await db.supply.create({ data: { ...body, referencePrice: BigInt(body.referencePrice) } }));
  });
  app.patch('/api/assets/supplies/:id', async request => {
    const who = u(request), { id } = z.object({ id: z.uuid() }).parse(request.params);
    requireAdmin(who);
    const body = z.object({
      name: z.string().trim().min(1).max(150).optional(), category: z.string().trim().min(1).optional(),
      unit: z.string().trim().min(1).optional(), minimumQty: z.number().int().min(0).optional(),
      referencePrice: z.number().int().min(0).optional(), note: z.string().max(2000).optional(), active: z.boolean().optional()
    }).parse(request.body);
    return serialize(await db.supply.update({ where: { id }, data: { ...body, referencePrice: body.referencePrice === undefined ? undefined : BigInt(body.referencePrice) } }));
  });

  app.get('/api/assets/stock', async request => {
    const who = u(request), q = pagination.parse(request.query);
    const where: Prisma.StockBalanceWhereInput = { AND: [
      stockScope(who), q.house ? { locationKey: { startsWith: `BUILDING:${q.house}` } } : {},
      q.search ? { supply: { OR: [{ sku: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }] } } : {}
    ] };
    const [total, rows] = await Promise.all([db.stockBalance.count({ where }), db.stockBalance.findMany({
      where, include: { supply: { select: { sku: true, name: true, unit: true, minimumQty: true } } },
      orderBy: { updatedAt: 'desc' }, skip: (q.page - 1) * q.size, take: q.size
    })]);
    return { total, rows };
  });
  const stockInput = z.object({
    supplyId: z.uuid(), operation: z.enum(['IN', 'OUT', 'TRANSFER', 'RETURN', 'ADJUST']),
    quantity: z.number().int().refine(v => v !== 0 && Math.abs(v) <= 1000000),
    fromKey: z.string().nullable().optional(), toKey: z.string().nullable().optional(),
    reason: z.string().trim().min(2).max(500), workRef: z.string().max(100).nullable().optional(),
    requestKey: z.uuid()
  });
  app.post('/api/assets/stock/movements', async request => {
    const who = u(request), body = stockInput.parse(request.body);
    writable(who);
    if (body.operation === 'ADJUST') requireAdmin(who);
    if (body.operation !== 'ADJUST' && body.quantity <= 0) fail('Số lượng phải lớn hơn 0');
    if (body.operation === 'IN' || body.operation === 'RETURN') {
      if (!body.toKey || body.fromKey) fail('Nhập kho yêu cầu vị trí nhận');
    } else if (body.operation === 'OUT') {
      if (!body.fromKey || body.toKey) fail('Xuất kho yêu cầu vị trí xuất');
    } else if (body.operation === 'TRANSFER') {
      if (!body.fromKey || !body.toKey || body.fromKey === body.toKey) fail('Điều chuyển cần hai kho khác nhau');
    } else if (!body.toKey || body.fromKey) fail('Điều chỉnh cần một vị trí');
    if (body.fromKey) await validateStockLocation(who, body.fromKey, true);
    if (body.toKey) await validateStockLocation(who, body.toKey, true);
    return transaction(async tx => {
      const duplicate = await tx.stockMovement.findUnique({ where: { requestKey: body.requestKey } });
      if (duplicate) {
        if (duplicate.supplyId !== body.supplyId) fail('Mã thao tác đã được sử dụng', 409);
        return { repeated: true, movement: duplicate };
      }
      const supply = await tx.supply.findUnique({ where: { id: body.supplyId } });
      if (!supply?.active) fail('Vật tư không tồn tại hoặc đã dừng sử dụng', 404);
      for (const item of [body.fromKey, body.toKey].filter(Boolean).sort()) await lock(tx, 'stock:' + body.supplyId + ':' + item);
      const increase = async (locationKey: string, quantity: number) => {
        await tx.stockBalance.upsert({
          where: { supplyId_locationKey: { supplyId: body.supplyId, locationKey } },
          create: { supplyId: body.supplyId, locationKey, quantity },
          update: { quantity: { increment: quantity } }
        });
      };
      const decrease = async (locationKey: string, quantity: number) => {
        const result = await tx.stockBalance.updateMany({
          where: { supplyId: body.supplyId, locationKey, quantity: { gte: quantity } },
          data: { quantity: { decrement: quantity } }
        });
        if (!result.count) fail('Tồn kho không đủ để xuất hoặc điều chuyển', 409);
      };
      if (body.fromKey) await decrease(body.fromKey, body.quantity);
      if (body.toKey && body.operation !== 'ADJUST') await increase(body.toKey, body.quantity);
      if (body.operation === 'ADJUST') {
        if (body.quantity > 0) await increase(body.toKey!, body.quantity);
        else await decrease(body.toKey!, -body.quantity);
      }
      return tx.stockMovement.create({ data: {
        supplyId: body.supplyId, operation: body.operation, quantity: body.quantity,
        fromKey: body.fromKey || null, toKey: body.toKey || null,
        reason: body.reason, workRef: body.workRef || null, actorId: who.id,
        approverId: body.operation === 'ADJUST' ? who.id : null, requestKey: body.requestKey
      } });
    });
  });

  app.get('/api/assets/counts', async request => {
    const who = u(request);
    const q = pagination.parse(request.query);
    const where: Prisma.StockCountWhereInput = admin(who) ? {} : { OR: who.houses.flatMap(h => [
      { locationKey: `BUILDING:${h}` }, { locationKey: { startsWith: `ROOM:${h}:` } }
    ]) };
    const [total, rows] = await Promise.all([
      db.stockCount.count({ where }),
      db.stockCount.findMany({ where, include: { lines: { include: { supply: { select: { sku: true, name: true, unit: true } } } } }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.size, take: q.size })
    ]);
    return { total, rows };
  });
  app.post('/api/assets/counts', async request => {
    const who = u(request);
    writable(who);
    const body = z.object({
      locationKey: z.string(), note: z.string().max(2000).default(''),
      lines: z.array(z.object({ supplyId: z.uuid(), actualQty: z.number().int().min(0) })).min(1).max(500)
    }).parse(request.body);
    await validateStockLocation(who, body.locationKey, true);
    if (new Set(body.lines.map(l => l.supplyId)).size !== body.lines.length) fail('Vật tư trùng trong phiếu kiểm kê');
    return transaction(async tx => {
      await lock(tx, 'count:' + body.locationKey);
      const balances = await tx.stockBalance.findMany({ where: { locationKey: body.locationKey, supplyId: { in: body.lines.map(l => l.supplyId) } } });
      const expected = new Map(balances.map(b => [b.supplyId, b.quantity]));
      const count = await tx.stockCount.create({ data: {
        locationKey: body.locationKey, note: body.note, actorId: who.id,
        lines: { create: body.lines.map(l => ({ ...l, expectedQty: expected.get(l.supplyId) || 0 })) }
      } });
      return count;
    });
  });
  app.post('/api/assets/counts/:id/approve', async request => {
    const who = u(request);
    requireAdmin(who);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(async tx => {
      await lock(tx, 'count-id:' + id);
      const count = await tx.stockCount.findUnique({ where: { id }, include: { lines: true } });
      if (!count) fail('Không có phiếu kiểm kê', 404);
      if (count!.status !== 'DRAFT') fail('Phiếu đã được duyệt', 409);
      for (const line of count!.lines.sort((a, b) => a.supplyId.localeCompare(b.supplyId))) {
        await lock(tx, 'stock:' + line.supplyId + ':' + count!.locationKey);
        const balance = await tx.stockBalance.findUnique({ where: { supplyId_locationKey: { supplyId: line.supplyId, locationKey: count!.locationKey } } });
        if ((balance?.quantity || 0) !== line.expectedQty) fail('Tồn kho đã thay đổi sau khi kiểm kê, cần lập phiếu mới', 409);
        const delta = line.actualQty - line.expectedQty;
        if (delta) {
          await tx.stockBalance.upsert({ where: { supplyId_locationKey: { supplyId: line.supplyId, locationKey: count!.locationKey } },
            create: { supplyId: line.supplyId, locationKey: count!.locationKey, quantity: line.actualQty },
            update: { quantity: line.actualQty } });
          await tx.stockMovement.create({ data: {
            supplyId: line.supplyId, operation: 'COUNT', quantity: delta, toKey: count!.locationKey,
            reason: 'Duyệt kiểm kê ' + id, actorId: count!.actorId, approverId: who.id,
            requestKey: `count:${id}:${line.supplyId}`
          } });
        }
      }
      return tx.stockCount.update({ where: { id }, data: { status: 'APPROVED', approverId: who.id, approvedAt: new Date() } });
    });
  });

  app.get('/api/assets/maintenance', async request => {
    const who = u(request), q = pagination.parse(request.query);
    const where: Prisma.AssetMaintenanceWhereInput = { asset: scope(who) };
    const [total, rows] = await Promise.all([
      db.assetMaintenance.count({ where }),
      db.assetMaintenance.findMany({ where, include: { asset: { select: { code: true, name: true, houseCode: true } } }, orderBy: { startedAt: 'desc' }, skip: (q.page - 1) * q.size, take: q.size })
    ]);
    return { total, rows: rows.map(r => ({ ...r, cost: admin(who) ? Number(r.cost) : null })) };
  });
  app.post('/api/assets/maintenance', async request => {
    const who = u(request);
    writable(who);
    const body = z.object({
      assetId: z.uuid(), kind: z.enum(['REPAIR', 'WARRANTY', 'MAINTENANCE']),
      description: z.string().trim().min(2).max(2000), cost: z.number().int().min(0).default(0), note: z.string().max(2000).default('')
    }).parse(request.body);
    if (!admin(who) && body.cost) fail('Nhân viên không có quyền nhập chi phí', 403);
    return transaction(async tx => {
      await lock(tx, 'asset:' + body.assetId);
      const item = await tx.asset.findUnique({ where: { id: body.assetId } });
      if (!item) fail('Không tìm thấy tài sản', 404);
      requireLocation(who, { locationType: item!.locationType, houseCode: item!.houseCode, room: item!.room }, true);
      if (item!.status !== 'AVAILABLE') fail('Thiết bị đang thuê, sửa chữa hoặc thanh lý', 409);
      await tx.asset.update({ where: { id: body.assetId }, data: { status: 'REPAIR', version: { increment: 1 }, updatedById: who.id } });
      return serialize(await tx.assetMaintenance.create({ data: { ...body, cost: BigInt(body.cost), actorId: who.id } }));
    });
  });
  app.post('/api/assets/maintenance/:id/complete', async request => {
    const who = u(request), { id } = z.object({ id: z.uuid() }).parse(request.params);
    writable(who);
    const body = z.object({ note: z.string().max(2000).default('') }).parse(request.body);
    return transaction(async tx => {
      const record = await tx.assetMaintenance.findUnique({ where: { id } });
      if (!record) fail('Không có phiếu bảo trì', 404);
      await lock(tx, 'asset:' + record!.assetId);
      const asset = await tx.asset.findUniqueOrThrow({ where: { id: record!.assetId } });
      requireLocation(who, { locationType: asset.locationType, houseCode: asset.houseCode, room: asset.room }, true);
      if (record!.status !== 'OPEN') fail('Phiếu đã hoàn tất', 409);
      await tx.asset.update({ where: { id: record!.assetId }, data: { status: 'AVAILABLE', version: { increment: 1 }, updatedById: who.id } });
      return tx.assetMaintenance.update({ where: { id }, data: { status: 'DONE', completedAt: new Date(), note: body.note } });
    });
  });

  app.get('/api/assets/history', async request => {
    const who = u(request), q = pagination.parse(request.query);
    const [assets, stock] = await Promise.all([
      db.assetMovement.findMany({ where: { asset: scope(who) }, include: { asset: { select: { code: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: q.page * q.size }),
      db.stockMovement.findMany({ where: admin(who) ? {} : { OR: [
        { fromKey: { in: who.houses.map(h => `BUILDING:${h}`) } },
        { toKey: { in: who.houses.map(h => `BUILDING:${h}`) } },
        ...who.houses.flatMap(h => [{ fromKey: { startsWith: `ROOM:${h}:` } }, { toKey: { startsWith: `ROOM:${h}:` } }])
      ] }, include: { supply: { select: { sku: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: q.page * q.size })
    ]);
    return { rows: [
      ...assets.map(row => ({ id: row.id, type: 'ASSET', subject: row.asset.code + ' · ' + row.asset.name, operation: row.toType, reason: row.reason, createdAt: row.createdAt, actorId: row.actorId })),
      ...stock.map(row => ({ id: row.id, type: 'STOCK', subject: row.supply.sku + ' · ' + row.supply.name, operation: row.operation, reason: row.reason, createdAt: row.createdAt, actorId: row.actorId }))
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice((q.page - 1) * q.size, q.page * q.size) };
  });
}
