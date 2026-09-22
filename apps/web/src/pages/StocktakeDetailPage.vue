<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Warning, RefreshRight, CircleCheck } from "@element-plus/icons-vue";
import { request, ApiError } from "@/lib/api";
import { movementLabels, statusLabels, type Stocktake, type StocktakeLine } from "@/types";
import { createIdempotencyKey } from "@/lib/idempotency";
import { compareQuantities, computeVariance } from "@handcraft/contracts";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const saving = ref(false);
const submitting = ref(false);
const stocktake = ref<Stocktake | null>(null);
// 实盘数草稿（逐批录入，可一次保存多个）。
const drafts = reactive<Record<string, string>>({});
const notesDraft = ref("");
// 幂等键在整次提交（含失败重试）期间保持不变，确保重复提交不会二次调账。
let submitIdempotencyKey: string | null = null;

const isCounting = computed(() => stocktake.value?.status === "COUNTING");
const lines = computed<StocktakeLine[]>(() => stocktake.value?.lines ?? []);
const countedCount = computed(() => lines.value.filter((line) => line.countedQuantity !== null).length);
const varianceCount = computed(() => lines.value.filter((line) => preview(line).direction !== "MATCH").length);
const progress = computed(() => (lines.value.length ? Math.round((countedCount.value / lines.value.length) * 100) : 0));

function preview(line: StocktakeLine): { direction: "GAIN" | "LOSS" | "MATCH"; variance: string } {
  const value = drafts[line.batchId];
  if (value === undefined || value === "" || !/^\d+(\.\d{1,6})?$/.test(value.trim())) {
    if (line.countedQuantity !== null) return computeVariance(line.bookQuantity, line.countedQuantity);
    return { direction: "MATCH", variance: "0.000000" };
  }
  return computeVariance(line.bookQuantity, value.trim());
}

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: Stocktake }>(`/stocktakes/${route.params.id}`);
    stocktake.value = response.data;
    notesDraft.value = response.data.notes ?? "";
    for (const key of Object.keys(drafts)) delete drafts[key];
    for (const line of response.data.lines ?? []) {
      if (line.countedQuantity !== null) drafts[line.batchId] = line.countedQuantity;
    }
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "盘点单加载失败");
  } finally {
    loading.value = false;
  }
}

function changedItems(): { batchId: string; countedQuantity: string }[] {
  return lines.value
    .map((line) => {
      const draft = drafts[line.batchId]?.trim();
      if (draft === undefined || draft === "") return null;
      if (line.countedQuantity !== null && compareQuantities(draft, line.countedQuantity) === 0) return null;
      return { batchId: line.batchId, countedQuantity: draft };
    })
    .filter((item): item is { batchId: string; countedQuantity: string } => item !== null);
}

async function saveCounts() {
  if (!stocktake.value) return;
  const items = changedItems();
  if (!items.length) {
    ElMessage.info("没有需要保存的实盘数变更");
    return;
  }
  const invalid = items.find((item) => !/^\d+(\.\d{1,6})?$/.test(item.countedQuantity));
  if (invalid) {
    ElMessage.warning("实盘数必须是最多 6 位小数的非负数");
    return;
  }
  saving.value = true;
  try {
    await request(`/stocktakes/${stocktake.value.id}/counts`, {
      method: "POST",
      body: { version: stocktake.value.version, items }
    });
    ElMessage.success(`已保存 ${items.length} 条实盘数，差异已按账面快照重算`);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "保存实盘数失败");
  } finally {
    saving.value = false;
  }
}

async function saveNotes() {
  if (!stocktake.value) return;
  try {
    await request(`/stocktakes/${stocktake.value.id}`, {
      method: "PATCH",
      body: { version: stocktake.value.version, notes: notesDraft.value || null }
    });
    ElMessage.success("备注已保存");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "备注保存失败");
  }
}

async function submit() {
  if (!stocktake.value) return;
  const pending = lines.value.length - countedCount.value;
  if (pending > 0) {
    ElMessage.warning(`还有 ${pending} 个批次未录入实盘数`);
    return;
  }
  try {
    const { value } = await ElMessageBox.confirm(
      `提交后将按账面快照重算全部差异并一次性核销：盘盈入库、盘亏出库，库位随即解冻。该操作不可重复提交，确认继续？`,
      "提交盘点核销",
      { type: "warning", confirmButtonText: "确认提交核销", cancelButtonText: "再检查一下" }
    );
    if (value !== "confirm") return;
  } catch {
    return;
  }
  submitting.value = true;
  if (!submitIdempotencyKey) submitIdempotencyKey = createIdempotencyKey();
  const idempotencyKey = submitIdempotencyKey;
  try {
    const response = await request<{ data: Record<string, unknown> }>(`/stocktakes/${stocktake.value.id}/submit`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: { version: stocktake.value.version, notes: notesDraft.value || null }
    });
    const data = response.data as { gainCount?: number; lossCount?: number; idempotent?: boolean };
    ElMessage.success(data.idempotent ? "该盘点已核销过，返回首次结果，未重复调账" : `核销完成：盘盈 ${data.gainCount ?? 0} 批，盘亏 ${data.lossCount ?? 0} 批`);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "提交核销失败");
  } finally {
    submitting.value = false;
  }
}

async function cancel() {
  if (!stocktake.value) return;
  try {
    const { value } = await ElMessageBox.prompt("取消后库位立即解冻，已录入的实盘数仅作记录保留，不会调整库存。请输入取消原因。", "取消盘点任务", {
      inputPattern: /^.{3,}$/,
      inputErrorMessage: "原因至少 3 个字",
      confirmButtonText: "确认取消",
      type: "warning"
    });
    await request(`/stocktakes/${stocktake.value.id}/cancel`, {
      method: "POST",
      body: { reason: value, version: stocktake.value.version }
    });
    ElMessage.success("盘点任务已取消，库位已解冻");
    await load();
  } catch (error: unknown) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof ApiError ? error.message : "取消失败");
  }
}

function varianceTag(line: StocktakeLine): { type: "success" | "danger" | "warning" | "info"; text: string } {
  const { direction, variance } = preview(line);
  if (direction === "GAIN") return { type: "danger", text: `盘盈 +${variance}` };
  if (direction === "LOSS") return { type: "warning", text: `盘亏 -${variance}` };
  return { type: "success", text: "一致" };
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <header class="page-header">
      <div>
        <h1>
          盘点 · {{ stocktake?.locationName }}
          <el-tag v-if="stocktake" :type="stocktake.status === 'COUNTING' ? 'warning' : stocktake.status === 'COMPLETED' ? 'success' : 'info'" size="large" style="margin-left: 8px">
            {{ statusLabels[stocktake.status] || stocktake.status }}
          </el-tag>
        </h1>
        <p>冻结于 {{ stocktake ? new Date(stocktake.frozenAt).toLocaleString() : "" }}</p>
      </div>
      <div class="header-actions">
        <el-button @click="router.push('/stocktakes')">返回列表</el-button>
        <el-button v-if="isCounting" type="danger" plain @click="cancel">取消盘点</el-button>
      </div>
    </header>

    <el-alert v-if="isCounting" type="warning" :closable="false" show-icon :icon="Warning" class="freeze-banner"
      title="库位已冻结" description="盘点期间该库位的批次调整、消耗、撤销、移动和归档均被禁止；其它库位不受影响。" />

    <el-alert v-else-if="stocktake?.status === 'COMPLETED'" type="success" :closable="false" show-icon :icon="CircleCheck" class="freeze-banner"
      title="差异已核销，库位已解冻" :description="stocktake.completedAt ? `完成于 ${new Date(stocktake.completedAt).toLocaleString()}` : ''" />

    <el-alert v-else type="info" :closable="false" show-icon class="freeze-banner"
      title="盘点已取消，库位已解冻" :description="stocktake?.cancelReason ? `原因：${stocktake.cancelReason}` : ''" />

    <section class="panel" v-if="stocktake">
      <div class="summary-row">
        <div class="summary-item"><span class="muted">行项目</span><strong>{{ lines.length }}</strong></div>
        <div class="summary-item"><span class="muted">已录入</span><strong>{{ countedCount }} / {{ lines.length }}</strong></div>
        <div class="summary-item"><span class="muted">存在差异</span><strong>{{ varianceCount }}</strong></div>
        <div class="summary-item" style="flex: 1; min-width: 220px">
          <el-progress :percentage="progress" :status="progress === 100 ? 'success' : undefined" />
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="table-toolbar">
        <strong>逐批实盘数</strong>
        <div v-if="isCounting">
          <el-button :icon="RefreshRight" :loading="saving" @click="saveCounts">保存录入</el-button>
          <el-button type="primary" :disabled="countedCount !== lines.length" :loading="submitting" @click="submit">
            提交核销（{{ countedCount }}/{{ lines.length }}）
          </el-button>
        </div>
      </div>
      <el-table :data="lines">
        <el-table-column label="材料 / 批次" min-width="200">
          <template #default="{ row }">
            <router-link :to="`/batches/${row.batchId}`">{{ row.materialName }}</router-link>
            <div class="muted">{{ row.batchCode || row.batchId.slice(0, 8) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="账面数量" width="140">
          <template #default="{ row }">{{ row.bookQuantity }} {{ row.stockUnit }}</template>
        </el-table-column>
        <el-table-column label="实盘数量" width="180">
          <template #default="{ row }">
            <el-input v-if="isCounting" v-model="drafts[row.batchId]" :placeholder="row.bookQuantity"
              :disabled="row.status === 'RECONCILED'" @keyup.enter="saveCounts" />
            <span v-else>{{ row.countedQuantity }} {{ row.stockUnit }}</span>
          </template>
        </el-table-column>
        <el-table-column label="差异（提交时重算）" width="170">
          <template #default="{ row }">
            <el-tag :type="varianceTag(row).type" size="small">{{ varianceTag(row).text }} {{ row.stockUnit }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="行状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'RECONCILED' ? 'success' : row.status === 'COUNTED' ? 'warning' : 'info'" size="small">
              {{ statusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="核销流水" min-width="130">
          <template #default="{ row }">
            <router-link v-if="row.movementType" :to="`/batches/${row.batchId}`">
              {{ movementLabels[row.movementType] || row.movementType }}
            </router-link>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="panel" v-if="stocktake">
      <div class="notes-row">
        <el-input v-model="notesDraft" type="textarea" :rows="2" :disabled="!isCounting" maxlength="5000" show-word-limit placeholder="盘点备注" />
        <el-button v-if="isCounting" @click="saveNotes">保存备注</el-button>
      </div>
      <p class="muted version-hint">数据版本 v{{ stocktake.version }}，提交采用乐观锁；若期间有人改动需刷新重试。</p>
    </section>
  </div>
</template>

<style scoped>
.header-actions { display: flex; gap: 8px; }
.freeze-banner { margin-bottom: 16px; }
.summary-row { display: flex; align-items: center; gap: 32px; flex-wrap: wrap; }
.summary-item { display: flex; flex-direction: column; gap: 4px; }
.summary-item strong { font-size: 20px; }
.table-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.notes-row { display: flex; gap: 12px; align-items: flex-start; }
.version-hint { margin: 8px 0 0; font-size: 12px; }
</style>
