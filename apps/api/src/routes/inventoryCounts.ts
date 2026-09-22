import type { FastifyInstance } from "fastify";
import { compareQuantities, compareSignedQuantities, inventoryCountCreateSchema, inventoryCountEntrySchema, inventoryCountStatuses, subtractQuantities } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction, type DbClient } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";

type Query = Record<string, string | undefined>;

type CountItemRow = {
  id: string;
  batch_id: string;
  counted_quantity: string;
  stock_unit: string;
  remaining_quantity: string;
  batch_status: string;
};

type SubmitDifference = {
  itemId: string;
  batchId: string;
  systemQuantity: string;
  countedQuantity: string;
  differenceQuantity: string;
};

async function loadSubmitResult(client: DbClient, countId: string): Promise<{ differences: SubmitDifference[]; adjustedCount: number }> {
  const items = await client.query<{
    id: string;
    batch_id: string;
    system_quantity: string;
    counted_quantity: string;
    difference_quantity: string;
  }>(
    `SELECT i.id, i.batch_id, i.system_quantity::text AS system_quantity,
            i.counted_quantity::text AS counted_quantity, i.difference_quantity::text AS difference_quantity
       FROM inventory_count_items i
      WHERE i.count_id = $1
      ORDER BY i.batch_id`,
    [countId]
  );
  const differences = items.rows.map((row) => ({
    itemId: row.id,
    batchId: row.batch_id,
    systemQuantity: row.system_quantity,
    countedQuantity: row.counted_quantity,
    differenceQuantity: row.difference_quantity
  }));
  return {
    differences,
    adjustedCount: differences.filter((item) => compareSignedQuantities(item.differenceQuantity, "0") !== 0).length
  };
}

export async function inventoryCountRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/inventory-counts", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["1 = 1"];
    if (request.query.status) {
      if (!inventoryCountStatuses.includes(request.query.status as never)) {
        throw new AppError(422, "INVALID_COUNT_STATUS", "盘点状态筛选值无效");
      }
      values.push(request.query.status);
      conditions.push(`c.status = $${values.length}::inventory_count_status`);
    }
    if (request.query.q?.trim()) {
      values.push(`%${request.query.q.trim()}%`);
      conditions.push(`c.name ILIKE $${values.length}`);
    }
    const where = conditions.join(" AND ");
    const base = `FROM inventory_counts c JOIN users u ON u.id = c.started_by WHERE ${where}`;
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${base}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT c.id, c.name, c.status, c.notes, u.display_name AS "startedByName",
              c.created_at AS "createdAt", c.submitted_at AS "submittedAt", c.cancelled_at AS "cancelledAt", c.version,
              (SELECT count(*)::int FROM inventory_count_locations l WHERE l.count_id = c.id) AS "locationCount",
              (SELECT count(*)::int FROM inventory_count_items i WHERE i.count_id = c.id) AS "itemCount",
              (SELECT count(*)::int FROM inventory_count_items i WHERE i.count_id = c.id AND i.counted_quantity IS NOT NULL) AS "countedItemCount",
              (SELECT count(*)::int FROM inventory_count_items i WHERE i.count_id = c.id AND i.difference_quantity IS NOT NULL AND i.difference_quantity <> 0) AS "differenceCount"
         ${base} ORDER BY c.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.post("/inventory-counts", async (request, reply) => {
    const input = parseInput(inventoryCountCreateSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const locationIds = [...new Set(input.locationIds)].sort();
    const created = await withTransaction(async (client) => {
      // 按固定顺序对库位加咨询锁，序列化并发创建，防止同一库位被两个任务同时冻结
      for (const locationId of locationIds) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory-count-location:${locationId}`]);
      }
      const locations = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM storage_locations WHERE id = ANY($1::uuid[]) AND archived_at IS NULL FOR SHARE",
        [locationIds]
      );
      if (locations.rows.length !== locationIds.length) {
        throw new AppError(422, "INVALID_LOCATION", "部分库位不存在或已归档");
      }
      const conflict = await client.query<{ name: string }>(
        `SELECT c.name
           FROM inventory_count_locations l
           JOIN inventory_counts c ON c.id = l.count_id
          WHERE l.location_id = ANY($1::uuid[]) AND c.status = 'COUNTING'
          LIMIT 1`,
        [locationIds]
      );
      if (conflict.rows[0]) {
        throw new AppError(409, "LOCATION_ALREADY_FROZEN", `部分库位已被进行中的盘点任务「${conflict.rows[0].name}」冻结`);
      }
      const count = await client.query<{ id: string }>(
        "INSERT INTO inventory_counts(name, notes, started_by) VALUES ($1, $2, $3) RETURNING id",
        [input.name, input.notes || null, user.id]
      );
      const countId = count.rows[0]!.id;
      await client.query(
        "INSERT INTO inventory_count_locations(count_id, location_id) SELECT $1, unnest($2::uuid[])",
        [countId, locationIds]
      );
      // 快照时锁定批次：并发的消耗或调整要么先提交（反映进快照），要么等冻结生效后被拒绝
      const items = await client.query<{ id: string }>(
        `INSERT INTO inventory_count_items(count_id, batch_id, system_quantity, stock_unit)
           SELECT $1, b.id, b.remaining_quantity, b.stock_unit
             FROM batches b
            WHERE b.location_id = ANY($2::uuid[]) AND b.status <> 'ARCHIVED'
            ORDER BY b.id
            FOR UPDATE OF b
          RETURNING id`,
        [countId, locationIds]
      );
      const detail = await client.query(
        `SELECT c.id, c.name, c.status, c.notes, c.created_at AS "createdAt", c.version
           FROM inventory_counts c WHERE c.id = $1`,
        [countId]
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: "CREATE",
        entityType: "INVENTORY_COUNT",
        entityId: countId,
        afterData: { ...detail.rows[0], locationIds, itemCount: items.rowCount ?? 0 },
        requestId: request.id
      });
      return { ...detail.rows[0], locationCount: locationIds.length, itemCount: items.rowCount ?? 0 };
    });
    return reply.status(201).send({ data: created });
  });

  app.get<{ Params: { id: string } }>("/inventory-counts/:id", async (request) => {
    const count = await pool.query(
      `SELECT c.id, c.name, c.status, c.notes, u.display_name AS "startedByName",
              c.created_at AS "createdAt", c.submitted_at AS "submittedAt", c.cancelled_at AS "cancelledAt", c.version
         FROM inventory_counts c JOIN users u ON u.id = c.started_by
        WHERE c.id = $1`,
      [request.params.id]
    );
    if (!count.rows[0]) throw new AppError(404, "NOT_FOUND", "盘点任务不存在");
    const [locations, items] = await Promise.all([
      pool.query(
        `SELECT l.id, l.name
           FROM inventory_count_locations cl JOIN storage_locations l ON l.id = cl.location_id
          WHERE cl.count_id = $1 ORDER BY l.name`,
        [request.params.id]
      ),
      pool.query(
        `SELECT i.id, i.batch_id AS "batchId", b.batch_code AS "batchCode",
                m.id AS "materialId", m.name AS "materialName", m.code AS "materialCode",
                l.name AS "locationName", b.status AS "batchStatus",
                i.system_quantity::text AS "systemQuantity", i.counted_quantity::text AS "countedQuantity",
                i.difference_quantity::text AS "differenceQuantity", i.stock_unit AS "stockUnit",
                i.counted_at AS "countedAt"
           FROM inventory_count_items i
           JOIN batches b ON b.id = i.batch_id
           JOIN materials m ON m.id = b.material_id
           LEFT JOIN storage_locations l ON l.id = b.location_id
          WHERE i.count_id = $1
          ORDER BY m.name, b.batch_code NULLS LAST, b.id`,
        [request.params.id]
      )
    ]);
    return { data: { ...count.rows[0], locations: locations.rows, items: items.rows } };
  });

  app.put<{ Params: { id: string; itemId: string } }>("/inventory-counts/:id/items/:itemId", async (request) => {
    const input = parseInput(inventoryCountEntrySchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const count = await client.query<{ status: string }>(
        "SELECT status FROM inventory_counts WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      if (!count.rows[0]) throw new AppError(404, "NOT_FOUND", "盘点任务不存在");
      if (count.rows[0].status !== "COUNTING") {
        throw new AppError(409, "COUNT_NOT_EDITABLE", "盘点任务已结束，不能继续录入实盘数");
      }
      const item = await client.query<{ id: string; counted_quantity: string | null }>(
        "SELECT id, counted_quantity::text AS counted_quantity FROM inventory_count_items WHERE id = $1 AND count_id = $2 FOR UPDATE",
        [request.params.itemId, request.params.id]
      );
      if (!item.rows[0]) throw new AppError(404, "NOT_FOUND", "盘点明细不存在");
      const updated = await client.query(
        `UPDATE inventory_count_items SET counted_quantity = $1, counted_at = now()
          WHERE id = $2
          RETURNING id, batch_id AS "batchId", system_quantity::text AS "systemQuantity",
                    counted_quantity::text AS "countedQuantity", counted_at AS "countedAt"`,
        [input.countedQuantity, request.params.itemId]
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: "COUNT_ENTRY",
        entityType: "INVENTORY_COUNT",
        entityId: request.params.id,
        beforeData: { itemId: request.params.itemId, countedQuantity: item.rows[0].counted_quantity },
        afterData: { itemId: request.params.itemId, countedQuantity: input.countedQuantity },
        requestId: request.id
      });
      return { data: updated.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/inventory-counts/:id/submit", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    const result = await withTransaction(async (client) => {
      const countResult = await client.query<{
        id: string;
        name: string;
        status: string;
        submitted_at: string | null;
      }>("SELECT id, name, status, submitted_at FROM inventory_counts WHERE id = $1 FOR UPDATE", [request.params.id]);
      const count = countResult.rows[0];
      if (!count) throw new AppError(404, "NOT_FOUND", "盘点任务不存在");
      if (count.status === "CANCELLED") throw new AppError(409, "COUNT_CANCELLED", "盘点任务已取消，不能提交核销");
      if (count.status === "COMPLETED") {
        // 重复提交：只返回首次核销的结果，不再调整库存、不再写审计日志
        const summary = await loadSubmitResult(client, count.id);
        return {
          id: count.id,
          status: "COMPLETED",
          submittedAt: count.submitted_at,
          itemCount: summary.differences.length,
          adjustedCount: summary.adjustedCount,
          differences: summary.differences,
          idempotent: true
        };
      }
      const pending = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM inventory_count_items WHERE count_id = $1 AND counted_quantity IS NULL",
        [count.id]
      );
      const pendingCount = Number(pending.rows[0]?.count ?? 0);
      if (pendingCount > 0) {
        throw new AppError(422, "COUNT_INCOMPLETE", `还有 ${pendingCount} 个批次未录入实盘数，不能提交`);
      }
      // 提交时按批次当前余额重算差异；冻结保证其与快照一致，重算是最后一道防线
      const items = await client.query<CountItemRow>(
        `SELECT i.id, i.batch_id, i.counted_quantity, i.stock_unit,
                b.remaining_quantity, b.status AS batch_status
           FROM inventory_count_items i
           JOIN batches b ON b.id = i.batch_id
          WHERE i.count_id = $1
          ORDER BY i.batch_id
          FOR UPDATE OF b, i`,
        [count.id]
      );
      for (const item of items.rows) {
        if (item.batch_status === "ARCHIVED") {
          throw new AppError(409, "BATCH_ARCHIVED", "盘点期间有批次被归档，无法完成核销");
        }
        const current = item.remaining_quantity;
        const counted = item.counted_quantity;
        const difference = subtractQuantities(counted, current);
        if (compareSignedQuantities(difference, "0") !== 0) {
          const surplus = compareSignedQuantities(difference, "0") > 0;
          await client.query(
            `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
               reference_type, reference_id, reason, actor_user_id)
             VALUES ($1, $2, $3, $4::stock_unit, $5, $6, 'INVENTORY_COUNT', $7, $8, $9)`,
            [
              item.batch_id,
              surplus ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
              difference,
              item.stock_unit,
              current,
              counted,
              count.id,
              `盘点差异核销：${count.name}`,
              user.id
            ]
          );
          await client.query(
            "UPDATE batches SET remaining_quantity = $1, status = $2, version = version + 1 WHERE id = $3",
            [counted, compareQuantities(counted, "0") === 0 ? "DEPLETED" : "ACTIVE", item.batch_id]
          );
        }
        await client.query("UPDATE inventory_count_items SET difference_quantity = $1 WHERE id = $2", [difference, item.id]);
      }
      const completed = await client.query<{ submitted_at: string }>(
        `UPDATE inventory_counts SET status = 'COMPLETED', submitted_at = now(), version = version + 1
          WHERE id = $1 AND status = 'COUNTING'
          RETURNING submitted_at`,
        [count.id]
      );
      if (!completed.rowCount) throw new AppError(409, "COUNT_STATE_CHANGED", "盘点任务状态已变化，请刷新后重试");
      const summary = await loadSubmitResult(client, count.id);
      await writeAudit(client, {
        actorUserId: user.id,
        action: "SUBMIT",
        entityType: "INVENTORY_COUNT",
        entityId: count.id,
        beforeData: { status: "COUNTING" },
        afterData: {
          status: "COMPLETED",
          itemCount: summary.differences.length,
          adjustedCount: summary.adjustedCount,
          differences: summary.differences.filter((item) => compareSignedQuantities(item.differenceQuantity, "0") !== 0)
        },
        requestId: request.id
      });
      return {
        id: count.id,
        status: "COMPLETED",
        submittedAt: completed.rows[0]!.submitted_at,
        itemCount: summary.differences.length,
        adjustedCount: summary.adjustedCount,
        differences: summary.differences,
        idempotent: false
      };
    });
    return { data: result };
  });

  app.post<{ Params: { id: string } }>("/inventory-counts/:id/cancel", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    const result = await withTransaction(async (client) => {
      const countResult = await client.query<{ id: string; status: string }>(
        "SELECT id, status FROM inventory_counts WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      const count = countResult.rows[0];
      if (!count) throw new AppError(404, "NOT_FOUND", "盘点任务不存在");
      if (count.status === "COMPLETED") {
        throw new AppError(409, "COUNT_ALREADY_COMPLETED", "盘点任务已提交核销，不能取消");
      }
      if (count.status === "CANCELLED") {
        // 重复取消：直接返回现状，不重复写审计日志
        return { id: count.id, status: "CANCELLED", idempotent: true };
      }
      const cancelled = await client.query<{ cancelled_at: string }>(
        `UPDATE inventory_counts SET status = 'CANCELLED', cancelled_at = now(), version = version + 1
          WHERE id = $1 AND status = 'COUNTING'
          RETURNING cancelled_at`,
        [count.id]
      );
      if (!cancelled.rowCount) throw new AppError(409, "COUNT_STATE_CHANGED", "盘点任务状态已变化，请刷新后重试");
      await writeAudit(client, {
        actorUserId: user.id,
        action: "CANCEL",
        entityType: "INVENTORY_COUNT",
        entityId: count.id,
        beforeData: { status: "COUNTING" },
        afterData: { status: "CANCELLED" },
        requestId: request.id
      });
      return { id: count.id, status: "CANCELLED", cancelledAt: cancelled.rows[0]!.cancelled_at, idempotent: false };
    });
    return { data: result };
  });
}
