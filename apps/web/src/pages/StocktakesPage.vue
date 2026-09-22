<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { statusLabels, type ApiMeta, type Location, type Stocktake } from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const rows = ref<Stocktake[]>([]);
const locations = ref<Location[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ status: "", locationId: "" });
const creating = ref(false);
const form = reactive({ locationId: "", notes: "" });

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: Stocktake[]; meta: ApiMeta }>(`/stocktakes?${params}`);
    rows.value = response.data;
    Object.assign(meta, response.meta);
    await router.replace({ query: Object.fromEntries(params) });
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "盘点任务加载失败");
  } finally {
    loading.value = false;
  }
}

async function create() {
  if (!form.locationId) {
    ElMessage.warning("请选择要冻结盘点的库位");
    return;
  }
  creating.value = true;
  try {
    const response = await request<{ data: Stocktake }>("/stocktakes", {
      method: "POST",
      body: { locationId: form.locationId, notes: form.notes || null }
    });
    ElMessage.success("盘点任务已创建，该库位已冻结");
    await router.push(`/stocktakes/${response.data.id}`);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "创建盘点任务失败");
  } finally {
    creating.value = false;
  }
}

function statusTagType(status: string): "warning" | "success" | "info" {
  if (status === "COUNTING") return "warning";
  if (status === "COMPLETED") return "success";
  return "info";
}

onMounted(async () => {
  Object.assign(filters, { status: String(route.query.status || ""), locationId: String(route.query.locationId || "") });
  form.locationId = String(route.query.locationId || "");
  try {
    const response = await request<{ data: Location[] }>("/locations?archived=false");
    locations.value = response.data;
    await load(Number(route.query.page) || 1);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "页面初始化失败");
  }
});
</script>

<template>
  <div>
    <header class="page-header">
      <div>
        <h1>盘点任务</h1>
        <p>创建后立即冻结指定库位，逐批录入实盘数，提交时一次性重算差异并核销，重复提交不会二次调账。</p>
      </div>
    </header>

    <section class="panel">
      <el-form label-position="top" class="create-form">
        <div class="form-grid">
          <el-form-item label="冻结盘点的库位" required>
            <el-select v-model="form.locationId" filterable style="width: 100%" placeholder="选择库位">
              <el-option v-for="location in locations.filter((item) => item.batchCount > 0)" :key="location.id" :value="location.id"
                :label="`${location.name}（在库批次 ${location.batchCount}）`" />
            </el-select>
          </el-form-item>
          <el-form-item label="盘点备注">
            <el-input v-model="form.notes" maxlength="5000" placeholder="可选，如盘点周期、责任人" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="creating" @click="create">创建并冻结库位</el-button>
          </el-form-item>
        </div>
      </el-form>
    </section>

    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable style="width: 140px" @change="load(1)">
            <el-option value="COUNTING" label="盘点中" />
            <el-option value="COMPLETED" label="已完成" />
            <el-option value="CANCELLED" label="已取消" />
          </el-select>
        </el-form-item>
        <el-form-item label="库位">
          <el-select v-model="filters.locationId" clearable filterable style="width: 180px" @change="load(1)">
            <el-option v-for="location in locations" :key="location.id" :value="location.id" :label="location.name" />
          </el-select>
        </el-form-item>
        <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button></el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <el-table v-loading="loading" :data="rows" @row-click="(row: Stocktake) => router.push(`/stocktakes/${row.id}`)" class="clickable">
        <el-table-column label="库位" min-width="140">
          <template #default="{ row }">{{ row.locationName }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><el-tag :type="statusTagType(row.status)">{{ statusLabels[row.status] || row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column label="行项目" width="150">
          <template #default="{ row }">
            <span>{{ row.lineCount ?? 0 }} 项</span>
            <el-tag v-if="row.status === 'COUNTING' && (row.pendingCount ?? 0) > 0" type="warning" size="small" style="margin-left:6px">
              待盘 {{ row.pendingCount }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="差异批次" width="100">
          <template #default="{ row }">{{ row.varianceCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="冻结时间" width="170">
          <template #default="{ row }">{{ new Date(row.frozenAt).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="完成/取消时间" width="170">
          <template #default="{ row }">
            {{ row.completedAt ? new Date(row.completedAt).toLocaleString() : row.cancelledAt ? new Date(row.cancelledAt).toLocaleString() : "—" }}
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="还没有盘点任务，选择上方库位创建第一张盘点单" />
      <el-pagination v-if="meta.total > 0" style="margin-top: 16px; justify-content: flex-end" layout="total, prev, pager, next"
        :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>
  </div>
</template>

<style scoped>
.create-form :deep(.el-form-item) { margin-bottom: 0; }
.clickable :deep(.el-table__row) { cursor: pointer; }
</style>
