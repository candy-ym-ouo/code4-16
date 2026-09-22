-- 盘点任务与差异核销
--
-- 盘点针对某个库位：创建盘点单即冻结该库位，盘点期间禁止任何常规库存写操作
-- （调整、消耗、撤销、批次移动、归档等）；逐批录入实盘数，提交时在同一事务内
-- 重算差异并核销。提交只允许成功一次，重复提交不会二次调整库存或覆盖审计。

CREATE TYPE stocktake_status AS ENUM ('COUNTING', 'COMPLETED', 'CANCELLED');
CREATE TYPE stocktake_line_status AS ENUM ('PENDING', 'COUNTED', 'RECONCILED');

-- 扩展现成的流水类型枚举，登记“盘盈入 / 盘亏出”两类盘点流水。
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'STOCKTAKE_IN';
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'STOCKTAKE_OUT';

CREATE TABLE stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES storage_locations(id),
  status stocktake_status NOT NULL DEFAULT 'COUNTING',
  notes text,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  completed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT stocktakes_completed_by_chk CHECK (
    (status = 'COMPLETED') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)
  ),
  CONSTRAINT stocktakes_cancelled_chk CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
  )
);
CREATE INDEX stocktakes_status_created_idx ON stocktakes(status, created_at DESC);
CREATE INDEX stocktakes_location_idx ON stocktakes(location_id);
-- 快速定位“某库位是否处于冻结中”。
CREATE INDEX stocktakes_frozen_lookup_idx ON stocktakes(location_id) WHERE status = 'COUNTING';

CREATE TABLE stocktake_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id uuid NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES batches(id),
  -- 建单（冻结）时的账面快照，提交核销始终与该快照比对，不随后续读取漂移。
  book_quantity numeric(18,6) NOT NULL CHECK (book_quantity >= 0),
  counted_quantity numeric(18,6) CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  variance_quantity numeric(18,6),
  stock_unit stock_unit NOT NULL,
  status stocktake_line_status NOT NULL DEFAULT 'PENDING',
  counted_at timestamptz,
  reconciled_at timestamptz,
  counted_by uuid REFERENCES users(id),
  movement_id uuid REFERENCES stock_movements(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stocktake_lines_stocktake_batch_uq ON stocktake_lines(stocktake_id, batch_id);
CREATE INDEX stocktake_lines_batch_idx ON stocktake_lines(batch_id);
CREATE INDEX stocktake_lines_status_idx ON stocktake_lines(stocktake_id, status);

-- 提交核销的幂等标记：一次提交（可能产生多条流水）只对应一行。
-- 唯一约束保证同一 Idempotency-Key 只能提交一次；重复提交据此回放，不再调账。
CREATE TABLE stocktake_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id uuid NOT NULL REFERENCES stocktakes(id),
  idempotency_key varchar(100) NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 与 stock_movements 的幂等键长度一致，并保持全局互不冲突（应用层统一命名空间）。
CREATE UNIQUE INDEX stocktake_submissions_key_uq ON stocktake_submissions(idempotency_key);
CREATE INDEX stocktake_submissions_stocktake_idx ON stocktake_submissions(stocktake_id);

CREATE TRIGGER stocktakes_updated_at BEFORE UPDATE ON stocktakes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stocktake_lines_updated_at BEFORE UPDATE ON stocktake_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 同一库位任意时刻至多一张进行中的盘点单（CHECK 不允许子查询，用触发器实现）。
CREATE OR REPLACE FUNCTION enforce_one_active_stocktake() RETURNS trigger AS $$
DECLARE
  conflict_id uuid;
BEGIN
  IF NEW.status = 'COUNTING' THEN
    SELECT s.id INTO conflict_id
      FROM stocktakes s
     WHERE s.location_id = NEW.location_id
       AND s.status = 'COUNTING'
       AND s.id <> NEW.id
     LIMIT 1;
    IF conflict_id IS NOT NULL THEN
      RAISE EXCEPTION 'location % already has active stocktake %', NEW.location_id, conflict_id
        USING ERRCODE = 'P0998';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stocktakes_one_active
  BEFORE INSERT OR UPDATE OF status, location_id ON stocktakes
  FOR EACH ROW EXECUTE FUNCTION enforce_one_active_stocktake();

-- 行项目只能是盘点库位下的批次。
CREATE OR REPLACE FUNCTION enforce_stocktake_line_location() RETURNS trigger AS $$
DECLARE
  line_location uuid;
BEGIN
  SELECT location_id INTO line_location FROM stocktakes WHERE id = NEW.stocktake_id;
  IF line_location IS NULL THEN
    RAISE EXCEPTION 'stocktake % not found', NEW.stocktake_id USING ERRCODE = 'P0998';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM batches b WHERE b.id = NEW.batch_id AND b.location_id = line_location) THEN
    RAISE EXCEPTION 'batch % is not located in the stocktake location %', NEW.batch_id, line_location
      USING ERRCODE = 'P0998';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stocktake_lines_location
  BEFORE INSERT OR UPDATE OF batch_id, stocktake_id ON stocktake_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_stocktake_line_location();

-- 冻结保护：库位处于盘点中时，阻止对该库位批次的常规更新（移入/移出都拦截）。
-- 盘点核销事务在更新批次前置位本地 GUC handcraft.bypassing_freeze 以放行自身写入；
-- 该设置随事务结束/回滚自动失效，无法被外部 API 请求利用。
CREATE OR REPLACE FUNCTION enforce_stocktake_freeze() RETURNS trigger AS $$
DECLARE
  active_stocktake uuid;
BEGIN
  IF current_setting('handcraft.bypassing_freeze', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO active_stocktake
    FROM stocktakes s
   WHERE s.status = 'COUNTING'
     AND s.location_id IN (NEW.location_id, OLD.location_id)
   LIMIT 1;

  IF active_stocktake IS NOT NULL THEN
    RAISE EXCEPTION 'location frozen by stocktake %', active_stocktake
      USING ERRCODE = 'P0999';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER batches_stocktake_freeze
  BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION enforce_stocktake_freeze();
