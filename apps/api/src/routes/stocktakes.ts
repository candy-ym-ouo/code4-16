import type { FastifyInstance } from "fastify";
import {
  addQuantities,
  compareQuantities,
  computeVariance,
  stocktakeCancelSchema,
  stocktakeCountSchema,
  stocktakeCreateSchema,
  stocktakeNotePatchSchema,
  stocktakeSubmitSchema,
  subtractQuantities
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction, type DbClient } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { getIdempotencyKey } from "../lib/idempotency.js";

type Query = Record<string, string | undefined>;

const LINE_SELECT = `
  SELECT sl.id, sl.stocktake_id AS "stocktakeId", sl.batch_id AS "batchId",
         b.batch_code AS "batchCode", m.id AS "materialId", m.name AS "materialName",
         sl.book_quantity::text AS "bookQuantity", sl.counted_quantity::text AS "countedQuantity",
         sl.variance_quantity::text AS "varianceQuantity", sl.stock_unit AS "stockUnit",
         sl.status, sl.counted_at AS "countedAt", sl.reconciled_at AS "reconciledAt",
         sm.type AS "movementType"
    FROM stocktake_lines sl
    JOIN batches b ON b.id = sl.batch_id
    JOIN materials m ON m.id = b.material_id
    LEFT JOIN stock_movements sm ON sm.id = sl.movement_id`;

async function loadStocktake(client: DbClient, id: string, lock = false) {
  const result = await client.query<{
    id: string;
    location_id: string;
    status: string;
    version: number;
  }>(`SELECT id, location_id, status, version FROM stocktakes WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  return result.rows[0];
}

function assertCounting(status: string | undefined): void {
  if (!status) throw new AppError(404, "NOT_FOUND", "盘点单不存在");
  if (status === "COMPLETED") throw new AppError(409, "STOCKTAKE_COMPLETED", "盘点单已提交核销，不能再修改");
  if (status === "CANCELLED") throw new AppError(409, "STOCKTAKE_CANCELLED", "盘点单已取消，不能再修改");
}

/**
 * 常规库存写操作入口的冻结前置检查（数据库触发器是最终防线）。
 * 覆盖批次移动、调整、消耗、撤销、归档等。
 */
export async function assertLocationNotFrozen(client: DbClient, locationId: string | null | undefined): Promise<void> {
  if (!locationId) return;
  const frozen = await client.query<{ stocktake_id: string }>(
    "SELECT id AS stocktake_id FROM stocktakes WHERE location_id = $1 AND status = 'COUNTING' LIMIT 1",
    [locationId]
  );
  if (frozen.rows[0]) {
    throw new AppError(409, "LOCATION_FROZEN", "该库位正在盘点中已冻结，盘点提交或取消后才能修改库存");
  }
}

export async function stocktakeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/stocktakes", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["1 = 1"];
    if (request.query.status) {
      if (!["COUNTING", "COMPLETED", "CANCELLED"].includes(request.query.status)) {
        throw new AppError(422, "INVALID_STOCKTAKE_STATUS", "盘点单状态筛选值无效");
      }
      values.push(request.query.status);
      conditions.push(`s.status = $${values.length}::stocktake_status`);
    }
    if (request.query.locationId) {
      values.push(request.query.locationId);
      conditions.push(`s.location_id = $${values.length}::uuid`);
    }
    if (request.query.q?.trim()) {
      values.push(`%${request.query.q.trim()}%`);
      conditions.push("(l.name ILIKE $" + (values.length + 1) + " OR s.notes ILIKE $" + (values.length + 1) + ")");
    }
    const where = conditions.join(" AND ");
    const total = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM stocktakes s JOIN storage_locations l ON l.id = s.location_id WHERE ${where}`,
      values
    );
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT s.id, s.location_id AS "locationId", l.name AS "locationName", s.status, s.notes,
              s.frozen_at AS "frozenAt", s.completed_at AS "completedAt", s.cancelled_at AS "cancelledAt",
              s.cancel_reason AS "cancelReason", s.created_at AS "createdAt", s.updated_at AS "updatedAt",
              s.version,
              count(sl.id)::int AS "lineCount",
              count(sl.id) FILTER (WHERE sl.status = 'PENDING')::int AS "pendingCount",
              count(sl.id) FILTER (WHERE sl.counted_quantity IS NOT NULL
                AND round(sl.counted_quantity - sl.book_quantity, 6) <> 0)::int AS "varianceCount",
              coalesce(sum(abs(sl.counted_quantity - sl.book_quantity)) FILTER (WHERE sl.status = 'RECONCILED'), 0)::text AS "reconciledVarianceTotal"
         FROM stocktakes s
         JOIN storage_locations l ON l.id = s.location_id
         LEFT JOIN stocktake_lines sl ON sl.stocktake_id = s.id
        WHERE ${where}
        GROUP BY s.id, l.name
        ORDER BY s.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/stocktakes/:id", async (request) => {
    const result = await pool.query(
      `SELECT s.id, s.location_id AS "locationId", l.name AS "locationName", s.status, s.notes,
              s.frozen_at AS "frozenAt", s.completed_at AS "completedAt", s.cancelled_at AS "cancelledAt",
              s.cancel_reason AS "cancelReason", s.created_by AS "createdBy", s.completed_by AS "completedBy",
              s.created_at AS "createdAt", s.updated_at AS "updatedAt", s.version
         FROM stocktakes s JOIN storage_locations l ON l.id = s.location_id
        WHERE s.id = $1`,
      [request.params.id]
    );
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "盘点单不存在");
    const lines = await pool.query(
      `${LINE_SELECT} WHERE sl.stocktake_id = $1 ORDER BY m.name, b.created_at, b.id`,
      [request.params.id]
    );
    return { data: { ...result.rows[0], lines: lines.rows } };
  });

  // 创建盘点单：冻结库位并按当前账面快照逐批生成盘点行。
  app.post("/stocktakes", async (request, reply) => {
    const input = parseInput(stocktakeCreateSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      // 串行化对同一库位的建单，防止并发产生两张进行中的盘点单。
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`stocktake-location:${input.locationId}`]);
      const location = await client.query(
        "SELECT id, name FROM storage_locations WHERE id = $1 AND archived_at IS NULL FOR UPDATE",
        [input.locationId]
      );
      if (!location.rows[0]) throw new AppError(422, "INVALID_LOCATION", "存放位置不存在或已归档");
      const active = await client.query(
        "SELECT id FROM stocktakes WHERE location_id = $1 AND status = 'COUNTING' LIMIT 1",
        [input.locationId]
      );
      if (active.rows[0]) throw new AppError(409, "LOCATION_ALREADY_FROZEN", "该库位已有进行中的盘点单，请先完成或取消");

      const stocktake = await client.query(
        `INSERT INTO stocktakes(location_id, notes, frozen_at, created_by)
         VALUES ($1, $2, now(), $3)
         RETURNING id, location_id AS "locationId", status, notes, frozen_at AS "frozenAt",
                   created_at AS "createdAt", updated_at AS "updatedAt", version`,
        [input.locationId, input.notes ?? null, user.id]
      );
      const stocktakeId = stocktake.rows[0]?.id as string;

      // 冻结时的账面快照：只纳入该库位下未归档批次。
      const batches = await client.query<{ id: string; remaining_quantity: string; stock_unit: string }>(
        `SELECT id, remaining_quantity, stock_unit FROM batches
          WHERE location_id = $1 AND status <> 'ARCHIVED'
          ORDER BY created_at, id`,
        [input.locationId]
      );
      if (!batches.rowCount) {
        throw new AppError(422, "LOCATION_EMPTY", "该库位下没有可盘点的批次");
      }
      for (const batch of batches.rows) {
        await client.query(
          `INSERT INTO stocktake_lines(stocktake_id, batch_id, book_quantity, stock_unit)
           VALUES ($1, $2, $3, $4::stock_unit)`,
          [stocktakeId, batch.id, batch.remaining_quantity, batch.stock_unit]
        );
      }
      await writeAudit(client, {
        actorUserId: user.id,
        action: "CREATE",
        entityType: "STOCKTAKE",
        entityId: stocktakeId,
        afterData: { locationId: input.locationId, lineCount: batches.rowCount, notes: input.notes ?? null },
        requestId: request.id
      });
      await writeAudit(client, {
        actorUserId: user.id,
        action: "FREEZE",
        entityType: "LOCATION",
        entityId: input.locationId,
        afterData: { stocktakeId, frozenBatchCount: batches.rowCount },
        requestId: request.id
      });
      return stocktake.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/stocktakes/:id", async (request) => {
    const input = parseInput(stocktakeNotePatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const current = await loadStocktake(client, request.params.id, true);
      assertCounting(current?.status);
      if (current!.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "盘点单已被其他操作修改，请刷新后重试");
      const result = await client.query(
        "UPDATE stocktakes SET notes = $1, version = version + 1 WHERE id = $2 RETURNING id, notes, version",
        [input.notes, request.params.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "UPDATE", entityType: "STOCKTAKE", entityId: request.params.id,
        beforeData: { version: input.version }, afterData: result.rows[0], requestId: request.id
      });
      return { data: result.rows[0] };
    });
  });

  // 逐批录入实盘数：只记录与重算差异，不动库存、不动账面。
  app.post<{ Params: { id: string } }>("/stocktakes/:id/counts", async (request) => {
    const input = parseInput(stocktakeCountSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const current = await loadStocktake(client, request.params.id, true);
      assertCounting(current?.status);
      if (current!.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "盘点单已被其他操作修改，请刷新后重试");

      const saved: unknown[] = [];
      for (const item of input.items) {
        const lineResult = await client.query<{
          id: string;
          batch_id: string;
          book_quantity: string;
          stock_unit: string;
        }>(
          "SELECT id, batch_id, book_quantity, stock_unit FROM stocktake_lines WHERE stocktake_id = $1 AND batch_id = $2 FOR UPDATE",
          [request.params.id, item.batchId]
        );
        const line = lineResult.rows[0];
        if (!line) throw new AppError(422, "BATCH_NOT_IN_STOCKTAKE", `批次 ${item.batchId} 不属于本盘点单`);
        // 批次账面单位固定；数量按 6 位小数非负数接收，兼容单位无需转换（实盘即该批次库存单位）。
        const { variance } = computeVariance(line.book_quantity, item.countedQuantity);
        const updated = await client.query(
          `UPDATE stocktake_lines
              SET counted_quantity = $1,
                  variance_quantity = $2,
                  status = 'COUNTED',
                  counted_at = now(),
                  counted_by = $3
            WHERE id = $4
            RETURNING id, batch_id AS "batchId", book_quantity::text AS "bookQuantity",
                      counted_quantity::text AS "countedQuantity", variance_quantity::text AS "varianceQuantity",
                      stock_unit AS "stockUnit", status, counted_at AS "countedAt"`,
          [item.countedQuantity, variance, user.id, line.id]
        );
        saved.push(updated.rows[0]);
      }
      await client.query("UPDATE stocktakes SET version = version + 1 WHERE id = $1", [request.params.id]);
      await writeAudit(client, {
        actorUserId: user.id, action: "COUNT", entityType: "STOCKTAKE", entityId: request.params.id,
        afterData: { itemCount: input.items.length, batchIds: input.items.map((item) => item.batchId) },
        requestId: request.id
      });
      return { data: saved };
    });
  });

  // 提交核销：在同一事务内重算差异、逐批调整库存并写盘点流水。只能成功一次。
  app.post<{ Params: { id: string } }>("/stocktakes/:id/submit", async (request) => {
    const input = parseInput(stocktakeSubmitSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    // 提交是一次性核销动作，强制要求幂等键，保证网络重试不重复调整库存。
    const key = getIdempotencyKey(request.headers);
    if (!key) throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED", "提交核销必须携带 Idempotency-Key 请求头");

    const submitted = await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      // 一次提交可能产生多条流水，幂等性由 stocktake_submissions 单独登记。
      // 同一 Idempotency-Key 重复提交时回放首次核销结果，不再调整库存或写审计。
      const replay = await client.query<{ stocktake_id: string }>(
        "SELECT stocktake_id FROM stocktake_submissions WHERE idempotency_key = $1",
        [key]
      );
      if (replay.rows[0]) {
        const stocktakeId = replay.rows[0].stocktake_id;
        if (stocktakeId !== request.params.id) {
          throw new AppError(422, "IDEMPOTENCY_KEY_MISMATCH", "该幂等键属于另一张盘点单");
        }
        const summary = await client.query(
          `SELECT count(*)::int AS "lineCount",
                  count(*) FILTER (WHERE status = 'RECONCILED')::int AS "reconciledCount",
                  count(*) FILTER (WHERE movement_id IS NOT NULL AND sm.type = 'STOCKTAKE_IN')::int AS "gainCount",
                  count(*) FILTER (WHERE movement_id IS NOT NULL AND sm.type = 'STOCKTAKE_OUT')::int AS "lossCount",
                  coalesce(sum(abs(sl.variance_quantity)) FILTER (WHERE sl.status = 'RECONCILED'), 0)::text AS "varianceTotal"
             FROM stocktake_lines sl
             LEFT JOIN stock_movements sm ON sm.id = sl.movement_id
            WHERE sl.stocktake_id = $1`,
          [stocktakeId]
        );
        return { id: stocktakeId, idempotent: true, ...summary.rows[0] };
      }

      const current = await loadStocktake(client, request.params.id, true);
      assertCounting(current?.status);
      if (current!.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "盘点单已被其他操作修改，请刷新后重试");

      const lines = await client.query<{
        id: string;
        batch_id: string;
        book_quantity: string;
        counted_quantity: string | null;
        stock_unit: string;
      }>(
        `SELECT id, batch_id, book_quantity, counted_quantity, stock_unit
           FROM stocktake_lines WHERE stocktake_id = $1 ORDER BY id FOR UPDATE`,
        [request.params.id]
      );
      const pending = lines.rows.filter((line) => line.counted_quantity === null);
      if (pending.length) {
        throw new AppError(409, "STOCKTAKE_INCOMPLETE", `还有 ${pending.length} 个批次未录入实盘数`);
      }

      // 放行本事务对冻结库位批次的写操作（设置随事务结束失效）。
      await client.query("SET LOCAL handcraft.bypassing_freeze = 'on'");

      let gainCount = 0;
      let lossCount = 0;
      let matchCount = 0;
      let varianceTotal = "0.000000";

      for (const line of lines.rows) {
        const counted = line.counted_quantity as string;
        // 提交时重新快照账面并再次重算差异，杜绝录入后账面被读取偏差影响。
        const batchResult = await client.query<{
          id: string;
          remaining_quantity: string;
          stock_unit: string;
          status: string;
          material_id: string;
        }>(
          "SELECT id, remaining_quantity, stock_unit, status, material_id FROM batches WHERE id = $1 FOR UPDATE",
          [line.batch_id]
        );
        const batch = batchResult.rows[0];
        if (!batch) throw new AppError(409, "BATCH_MISSING", "盘点行对应的批次已不存在");
        if (batch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", `批次 ${line.batch_id} 已归档，不能核销`);
        const material = await client.query("SELECT id FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE", [batch.material_id]);
        if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能核销盘点差异");
        if (batch.stock_unit !== line.stock_unit) throw new AppError(409, "UNIT_CHANGED", `批次 ${line.batch_id} 库存单位发生变化`);

        // 冻结期间账面不应变动；若被绕过则以冻结快照为准核对，当前账面必须仍等于快照。
        if (compareQuantities(batch.remaining_quantity, line.book_quantity) !== 0) {
          throw new AppError(409, "BOOK_DRIFT", `批次 ${line.batch_id} 冻结期间账面发生变动，请取消盘点后重建`);
        }

        const before = batch.remaining_quantity;
        const { direction, variance } = computeVariance(line.book_quantity, counted);
        let movementId: string | null = null;
        let after = before;

        if (direction === "GAIN") {
          after = addQuantities(before, variance);
          const movement = await client.query(
            `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
               reference_type, reference_id, reason, actor_user_id)
             VALUES ($1, 'STOCKTAKE_IN', $2, $3::stock_unit, $4, $5, 'STOCKTAKE', $6, $7, $8)
             RETURNING id`,
            [batch.id, variance, batch.stock_unit, before, after, request.params.id, "盘点盘盈入库", user.id]
          );
          movementId = movement.rows[0]?.id ?? null;
          gainCount += 1;
          varianceTotal = addQuantities(varianceTotal, variance);
        } else if (direction === "LOSS") {
          if (compareQuantities(variance, before) > 0) throw new AppError(409, "INSUFFICIENT_STOCK", `批次 ${line.batch_id} 账面不足，无法核销盘亏`);
          after = subtractQuantities(before, variance);
          const movement = await client.query(
            `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
               reference_type, reference_id, reason, actor_user_id)
             VALUES ($1, 'STOCKTAKE_OUT', $2, $3::stock_unit, $4, $5, 'STOCKTAKE', $6, $7, $8)
             RETURNING id`,
            [batch.id, `-${variance}`, batch.stock_unit, before, after, request.params.id, "盘点盘亏出库", user.id]
          );
          movementId = movement.rows[0]?.id ?? null;
          lossCount += 1;
          varianceTotal = addQuantities(varianceTotal, variance);
        } else {
          matchCount += 1;
        }

        if (direction !== "MATCH") {
          await client.query(
            "UPDATE batches SET remaining_quantity = $1, status = $2, version = version + 1 WHERE id = $3",
            [after, compareQuantities(after, "0") === 0 ? "DEPLETED" : "ACTIVE", batch.id]
          );
        }
        await client.query(
          `UPDATE stocktake_lines
              SET counted_quantity = $1, variance_quantity = $2, status = 'RECONCILED', reconciled_at = now(), movement_id = $3
            WHERE id = $4`,
          [counted, direction === "MATCH" ? "0.000000" : variance, movementId, line.id]
        );
      }

      if (input.notes !== undefined) {
        await client.query("UPDATE stocktakes SET notes = $1 WHERE id = $2", [input.notes ?? null, request.params.id]);
      }
      const finalised = await client.query(
        `UPDATE stocktakes SET status = 'COMPLETED', completed_at = now(), completed_by = $1,
                version = version + 1
          WHERE id = $2 AND status = 'COUNTING'
          RETURNING id, status, completed_at AS "completedAt", version`,
        [user.id, request.params.id]
      );
      if (!finalised.rows[0]) throw new AppError(409, "STOCKTAKE_COMPLETED", "盘点单已提交核销，不能重复提交");

      // 幂等登记作为最后兜底：即使单据状态检查被并发绕过，唯一索引也会让重复键回滚整个事务。
      await client.query(
        "INSERT INTO stocktake_submissions(stocktake_id, idempotency_key, actor_user_id) VALUES ($1, $2, $3)",
        [request.params.id, key, user.id]
      );

      await writeAudit(client, {
        actorUserId: user.id,
        action: "SUBMIT",
        entityType: "STOCKTAKE",
        entityId: request.params.id,
        afterData: { lineCount: lines.rows.length, gainCount, lossCount, matchCount, varianceTotal, version: input.version },
        requestId: request.id
      });

      return {
        id: request.params.id,
        idempotent: false,
        lineCount: lines.rows.length,
        reconciledCount: gainCount + lossCount,
        gainCount,
        lossCount,
        matchCount,
        varianceTotal
      };
    });

    return { data: submitted };
  });

  // 取消盘点：释放冻结，不产生任何库存调整。
  app.post<{ Params: { id: string } }>("/stocktakes/:id/cancel", async (request) => {
    const input = parseInput(stocktakeCancelSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const current = await loadStocktake(client, request.params.id, true);
      assertCounting(current?.status);
      if (current!.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "盘点单已被其他操作修改，请刷新后重试");
      const result = await client.query(
        `UPDATE stocktakes SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $1,
                version = version + 1
          WHERE id = $2
          RETURNING id, status, cancelled_at AS "cancelledAt", cancel_reason AS "cancelReason", version`,
        [input.reason, request.params.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "CANCEL", entityType: "STOCKTAKE", entityId: request.params.id,
        afterData: { reason: input.reason, version: input.version }, requestId: request.id
      });
      await writeAudit(client, {
        actorUserId: user.id, action: "UNFREEZE", entityType: "LOCATION",
        entityId: current!.location_id, afterData: { stocktakeId: request.params.id }, requestId: request.id
      });
      return { data: result.rows[0] };
    });
  });
}
