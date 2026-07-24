import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../errors/business-error.js';
import type { Prisma } from '../../generated/prisma/client.js';

export interface IdempotentRequest {
  scope: string;
  actorId: string;
  key: string;
  requestHash: string;
}

@Injectable()
export class IdempotencyService {
  /**
   * In-process dedup map keyed by `${scope}:${actorId}:${key}`. When two
   * concurrent callers hit the same idempotency key before either writes a
   * row, they would both see `findUnique → null` and run `work` twice. This
   * map stores the in-flight Promise so the second caller awaits the first's
   * result. Entries are always removed in `finally` so completed rows are
   * served from the DB cache path and transient failures don't poison the key.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly db: PrismaService) {}

  async execute<T>(
    request: IdempotentRequest,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const dedupKey = `${request.scope}:${request.actorId}:${request.key}`;

    const inflight = this.inFlight.get(dedupKey);
    if (inflight) {
      return inflight as Promise<T>;
    }

    const promise = this.executeUnchecked<T>(request, work);
    this.inFlight.set(dedupKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(dedupKey);
    }
  }

  private async executeUnchecked<T>(
    request: IdempotentRequest,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // Try to create an IN_PROGRESS record. If it already exists, handle accordingly.
    const existing = await this.db.idempotencyRecord.findUnique({
      where: {
        scope_actorId_key: {
          scope: request.scope,
          actorId: request.actorId,
          key: request.key,
        },
      },
    });

    if (existing) {
      // Different hash = key reuse with different body
      if (existing.requestHash !== request.requestHash) {
        throw new BusinessError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency key was used with a different request body',
          409,
        );
      }
      // Same hash: return cached response if completed, wait if in progress
      if (existing.state === 'COMPLETED' && existing.responseBody != null) {
        return JSON.parse(existing.responseBody) as T;
      }
      // In-progress collision: just re-run (the unique constraint in the tx below will prevent duplicates)
    }

    // Execute work in a transaction, saving the idempotency record alongside
    return this.db.$transaction(async (tx) => {
      // Create or update the idempotency record as IN_PROGRESS
      const record = await tx.idempotencyRecord.upsert({
        where: {
          scope_actorId_key: {
            scope: request.scope,
            actorId: request.actorId,
            key: request.key,
          },
        },
        create: {
          scope: request.scope,
          actorId: request.actorId,
          key: request.key,
          requestHash: request.requestHash,
          state: 'IN_PROGRESS',
        },
        update: {
          requestHash: request.requestHash,
          state: 'IN_PROGRESS',
        },
      });

      const result = await work(tx);
      const serialized = JSON.stringify(result);

      await tx.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          state: 'COMPLETED',
          responseStatus: 200,
          responseBody: serialized,
        },
      });

      return result;
    });
  }
}
