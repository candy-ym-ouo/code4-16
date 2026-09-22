import type { DbClient } from "./db.js";
import { AppError } from "./errors.js";

/**
 * 校验库位当前未被进行中的盘点任务冻结。
 * 盘点任务处于 COUNTING 状态时，其覆盖库位内的批次禁止任何库存或库位变动。
 */
export async function assertLocationNotFrozen(client: DbClient, locationId: string | null | undefined): Promise<void> {
  if (!locationId) return;
  const frozen = await client.query<{ name: string }>(
    `SELECT c.name
       FROM inventory_count_locations l
       JOIN inventory_counts c ON c.id = l.count_id
      WHERE l.location_id = $1 AND c.status = 'COUNTING'
      LIMIT 1`,
    [locationId]
  );
  if (frozen.rows[0]) {
    throw new AppError(409, "LOCATION_FROZEN", `库位正在盘点任务「${frozen.rows[0].name}」中，库存已冻结，请先完成或取消盘点`);
  }
}
