CREATE TYPE inventory_count_status AS ENUM ('COUNTING', 'COMPLETED', 'CANCELLED');

CREATE TABLE inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  status inventory_count_status NOT NULL DEFAULT 'COUNTING',
  notes text,
  started_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CHECK (status <> 'COMPLETED' OR submitted_at IS NOT NULL),
  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);
CREATE INDEX inventory_counts_status_idx ON inventory_counts(status, created_at DESC);

CREATE TABLE inventory_count_locations (
  count_id uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES storage_locations(id),
  PRIMARY KEY (count_id, location_id)
);
CREATE INDEX inventory_count_locations_location_idx ON inventory_count_locations(location_id);

CREATE TABLE inventory_count_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES batches(id),
  system_quantity numeric(18,6) NOT NULL CHECK (system_quantity >= 0),
  counted_quantity numeric(18,6) CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  difference_quantity numeric(18,6),
  stock_unit stock_unit NOT NULL,
  counted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inventory_count_items_count_batch_uq ON inventory_count_items(count_id, batch_id);
CREATE INDEX inventory_count_items_count_idx ON inventory_count_items(count_id);

-- 每个盘点任务对同一批次最多产生一条核销流水，数据库层面杜绝重复提交造成的二次调整。
CREATE UNIQUE INDEX movements_inventory_count_uq ON stock_movements(reference_id, batch_id) WHERE reference_type = 'INVENTORY_COUNT';
CREATE INDEX movements_inventory_count_idx ON stock_movements(reference_id) WHERE reference_type = 'INVENTORY_COUNT';

CREATE TRIGGER inventory_counts_updated_at BEFORE UPDATE ON inventory_counts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER inventory_count_items_updated_at BEFORE UPDATE ON inventory_count_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
