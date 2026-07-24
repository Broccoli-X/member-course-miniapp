import { describe, it, expect, vi } from 'vitest';
import { IdempotencyService, type IdempotentRequest } from './idempotency.service.js';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

// Mock PrismaService — the full integration test uses real MySQL
type IdempotencyRecordRow = {
  id: string;
  scope: string;
  actorId: string;
  key: string;
  requestHash: string;
  state: string;
  responseStatus?: number;
  responseBody: string | null;
};

interface CompositeWhere {
  scope_actorId_key: { scope: string; actorId: string; key: string };
}

interface UpdateWhere {
  id: string;
}

function createMockDb(): PrismaService {
  const records = new Map<string, IdempotencyRecordRow>();

  const compositeKey = (r: { scope: string; actorId: string; key: string }): string =>
    `${r.scope}:${r.actorId}:${r.key}`;

  const idempotencyRecord = {
    findUnique: vi.fn(async ({ where }: { where: CompositeWhere }): Promise<IdempotencyRecordRow | null> => {
      const k = compositeKey(where.scope_actorId_key);
      return records.get(k) ?? null;
    }),
    upsert: vi.fn(async ({
      where,
      create,
    }: {
      where: CompositeWhere;
      create: Omit<IdempotencyRecordRow, 'id' | 'responseBody'> & { responseBody?: string | null };
    }): Promise<IdempotencyRecordRow> => {
      const k = compositeKey(where.scope_actorId_key);
      if (!records.has(k)) {
        records.set(k, { id: k, responseBody: null, ...create });
      }
      return records.get(k) as IdempotencyRecordRow;
    }),
    update: vi.fn(async ({
      where,
      data,
    }: {
      where: UpdateWhere;
      data: Partial<IdempotencyRecordRow>;
    }): Promise<IdempotencyRecordRow> => {
      const rec = records.get(where.id);
      if (rec) Object.assign(rec, data);
      return rec as IdempotencyRecordRow;
    }),
  };

  const transactionClient = {
    idempotencyRecord: {
      upsert: idempotencyRecord.upsert,
      update: idempotencyRecord.update,
    },
  };

  return {
    idempotencyRecord,
    $transaction: vi.fn(async <T>(fn: (tx: typeof transactionClient) => Promise<T>): Promise<T> =>
      fn(transactionClient),
    ),
  } as unknown as PrismaService;
}

describe('IdempotencyService', () => {
  it('executes work once and returns the result', async () => {
    const mockDb = createMockDb();
    const service = new IdempotencyService(mockDb);
    const request: IdempotentRequest = { scope: 'order-confirm', actorId: 'admin-1', key: 'order-1', requestHash: 'abc123' };
    const work = vi.fn(async () => ({ orderId: 'order-1' }));

    const result = await service.execute(request, work);
    expect(result).toEqual({ orderId: 'order-1' });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('returns cached result for same hash', async () => {
    const mockDb = createMockDb();
    const service = new IdempotencyService(mockDb);
    const request: IdempotentRequest = { scope: 'order-confirm', actorId: 'admin-1', key: 'order-1', requestHash: 'abc123' };
    const work = vi.fn(async () => ({ orderId: 'order-1' }));

    const first = await service.execute(request, work);
    const second = await service.execute(request, work);
    expect(first).toEqual(second);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('rejects key reuse with a different body hash', async () => {
    const mockDb = createMockDb();
    const service = new IdempotencyService(mockDb);
    const request: IdempotentRequest = { scope: 'order-confirm', actorId: 'admin-1', key: 'order-1', requestHash: 'abc123' };
    const work = vi.fn(async () => ({ orderId: 'order-1' }));

    await service.execute(request, work);
    await expect(
      service.execute({ ...request, requestHash: 'other' }, work),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 409 });
  });
});
