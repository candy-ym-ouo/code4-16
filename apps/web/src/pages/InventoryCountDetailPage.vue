<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { inventoryCountStatusLabels, type InventoryCountDetail, type InventoryCountItem } from "@/types";

const route = useRoute();
const router = useRouter();
const countId = String(route.params.id);
const loading = ref(false);
const savingItemId = ref<string | null>(null);
const submitting = ref(false);
const count = ref<InventoryCountDetail | null>(null);
const entries = reactive<Record<string, string>>({});
const quantityPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

const items = computed(() => count.value?.items ?? []);
const countedCount = computed(() => items.value.filter((item) => item.countedQuantity !== null).length);
const differenceCount = computed(() => items.value.filter((item) => differenceOf(item) !== null && differenceOf(item) !== "0.000000" && differenceOf(item) !== "-0.000000").length);
const allCounted = computed(() => items.value.every((item) => quantityPattern.test(entries[item.id] ?? "")));
const isCounting = computed(() => count.value?.status === "COUNTING");

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: InventoryCountDetail }>(`/inventory-counts/${countId}`);
    count.value = response.data;
    for (const item of response.data.items) entries[item.id] = item.countedQuantity ?? "";
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "盘点任务加载失败"); }
  finally { loading.value = false; }
}

function differenceOf(item: InventoryCountItem): string | null {
  if (isCounting.value) {
    const value = entries[item.id];
    if (!quantityPattern.test(value ?? "")) return null;
    return (Math.round((Number(value) - Number(item.systemQuantity)) * 1e6) / 1e6).toFixed(6);
  }
  return item.differenceQuantity;
}
function differenceClass(difference: string | null) {
  if (difference === null || Number(difference) === 0) return "diff-zero";
  return Number(difference) > 0 ? "diff-positive" : "diff-negative";
}
function entryChanged(item: InventoryCountItem) {
  return (entries[item.id] ?? "") !== (item.countedQuantity ?? "");
}
function entryValid(item: InventoryCountItem) {
  return quantityPattern.test(entries[item.id] ?? "");
}

async function saveEntry(item: InventoryCountItem) {
  if (!entryValid(item)) { ElMessage.warning("实盘数必须是最多 6 位小数的非负数字"); return; }
  savingItemId.value = item.id;
  try {
    const response = await request<{ data: { countedQuantity: string; countedAt: string } }>(`/inventory-counts/${countId}/items/${item.id}`, {
      method: "PUT",
      body: { countedQuantity: entries[item.id] }
    });
    item.countedQuantity = response.data.countedQuantity;
    item.countedAt = response.data.countedAt;
    entries[item.id] = response.data.countedQuantity;
    ElMessage.success(`「${item.materialName}」实盘数已录入`);
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "实盘数录入失败"); }
  finally { savingItemId.value = null; }
}

async function submit() {
  try {
    await ElMessageBox.confirm(
      `提交后将按实盘数重算并核销全部差异（当前 ${differenceCount.value} 个批次存在差异），生成不可撤销的库存流水，且任务不可再修改。确认提交？`,
      "提交盘点核销",
      { type: "warning", confirmButtonText: "确认提交核销", cancelButtonText: "再想想" }
    );
  } catch { return; }
  submitting.value = true;
  try {
    const response = await request<{ data: { adjustedCount: number; idempotent: boolean } }>(`/inventory-counts/${countId}/submit`, { method: "POST" });
    const adjusted = response.data.adjustedCount;
    ElMessage.success(adjusted > 0 ? `核销完成，${adjusted} 个批次的差异已调整入账` : "核销完成，所有批次账实相符");
    await load();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "提交核销失败"); }
  finally { submitting.value = false; }
}

async function cancel() {
  try {
    await ElMessageBox.confirm("取消后库位立即解冻，已录入的实盘数保留为历史记录，不会核销任何差异。确认取消该盘点任务？", "取消盘点任务", { type: "warning" });
  } catch { return; }
  try {
    await request(`/inventory-counts/${countId}/cancel`, { method: "POST" });
    ElMessage.success("盘点任务已取消，库位已解冻");
    await load();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "取消失败"); }
}

function statusTagType(status: string) {
  if (status === "COUNTING") return "warning";
  if (status === "COMPLETED") return "success";
  return "info";
}
onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="count">
      <header class="page-header">
        <div>
          <h1>{{ count.name }} <el-tag :type="statusTagType(count.status)" style="vertical-align:middle">{{ inventoryCountStatusLabels[count.status] || count.status }}</el-tag></h1>
          <p>
            创建人 {{ count.startedByName }} · 创建于 {{ new Date(count.createdAt).toLocaleString() }}
            <template v-if="count.submittedAt"> · 核销于 {{ new Date(count.submittedAt).toLocaleString() }}</template>
            <template v-if="count.cancelledAt"> · 取消于 {{ new Date(count.cancelledAt).toLocaleString() }}</template>
          </p>
        </div>
        <div>
          <el-button @click="router.push('/inventory-counts')">返回列表</el-button>
          <el-button v-if="isCounting" type="danger" plain @click="cancel">取消任务</el-button>
          <el-button v-if="isCounting" type="primary" :disabled="!allCounted" :loading="submitting" @click="submit">提交核销</el-button>
        </div>
      </header>

      <el-alert v-if="isCounting" type="warning" :closable="false" show-icon style="margin-bottom:16px"
        title="以下库位已冻结，相关批次在任务提交或取消前不能消耗、调整、移库或归档" />
      <el-alert v-else-if="count.status==='COMPLETED'" type="success" :closable="false" show-icon style="margin-bottom:16px"
        title="差异已核销入账，重复提交不会产生二次调整" />
      <el-alert v-else type="info" :closable="false" show-icon style="margin-bottom:16px" title="任务已取消，未核销任何差异" />

      <section class="panel">
        <p style="margin-top:0"><span class="muted">冻结库位：</span><el-tag v-for="location in count.locations" :key="location.id" style="margin-right:8px">{{ location.name }}</el-tag></p>
        <div class="stat-grid">
          <div class="stat-card"><small>盘点批次</small><strong>{{ items.length }}</strong></div>
          <div class="stat-card"><small>已录入实盘</small><strong>{{ countedCount }}</strong></div>
          <div class="stat-card"><small>存在差异</small><strong>{{ differenceCount }}</strong></div>
        </div>
      </section>

      <section class="panel">
        <el-table :data="items">
          <el-table-column label="材料" min-width="160"><template #default="{ row }"><router-link :to="`/materials/${row.materialId}`">{{ row.materialName }}</router-link><div class="muted">{{ row.materialCode || "—" }}</div></template></el-table-column>
          <el-table-column label="批次" min-width="130"><template #default="{ row }"><router-link :to="`/batches/${row.batchId}`">{{ row.batchCode || row.batchId.slice(0, 8) }}</router-link></template></el-table-column>
          <el-table-column label="库位" width="120"><template #default="{ row }">{{ row.locationName || "—" }}</template></el-table-column>
          <el-table-column label="账面数量" width="140"><template #default="{ row }"><span class="amount">{{ row.systemQuantity }} {{ row.stockUnit }}</span></template></el-table-column>
          <el-table-column label="实盘数量" min-width="200">
            <template #default="{ row }">
              <div v-if="isCounting" style="display:flex;gap:8px;align-items:center">
                <el-input v-model="entries[row.id]" :placeholder="row.systemQuantity" style="max-width:160px" @keyup.enter="saveEntry(row)">
                  <template #append>{{ row.stockUnit }}</template>
                </el-input>
                <el-button type="primary" plain size="small" :disabled="!entryValid(row) || !entryChanged(row)" :loading="savingItemId===row.id" @click="saveEntry(row)">保存</el-button>
              </div>
              <span v-else class="amount">{{ row.countedQuantity !== null ? `${row.countedQuantity} ${row.stockUnit}` : "未录入" }}</span>
            </template>
          </el-table-column>
          <el-table-column label="差异" width="140">
            <template #default="{ row }">
              <span v-if="differenceOf(row) !== null" class="amount" :class="differenceClass(differenceOf(row))">{{ Number(differenceOf(row)) > 0 ? "+" : "" }}{{ differenceOf(row) }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="录入时间" width="170"><template #default="{ row }"><span class="muted">{{ row.countedAt ? new Date(row.countedAt).toLocaleString() : "—" }}</span></template></el-table-column>
        </el-table>
        <el-empty v-if="!loading && items.length===0" description="所选库位下没有需要盘点的批次" />
        <p v-if="isCounting && items.length>0 && !allCounted" class="muted" style="margin-bottom:0">全部批次录入实盘数后才能提交核销。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.diff-positive { color: #27864a; }
.diff-negative { color: #c0392b; }
.diff-zero { color: #817269; }
</style>
