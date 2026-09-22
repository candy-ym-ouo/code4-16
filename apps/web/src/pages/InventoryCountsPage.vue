<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { inventoryCountStatusLabels, type ApiMeta, type InventoryCount, type Location } from "@/types";

const router = useRouter();
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const rows = ref<InventoryCount[]>([]);
const locations = ref<Location[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ q: "", status: "" });
const form = reactive({ name: "", locationIds: [] as string[], notes: "" });

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: InventoryCount[]; meta: ApiMeta }>(`/inventory-counts?${params}`);
    rows.value = response.data; Object.assign(meta, response.meta);
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "盘点任务加载失败"); }
  finally { loading.value = false; }
}
async function openCreate() {
  Object.assign(form, { name: "", locationIds: [], notes: "" });
  try {
    locations.value = (await request<{ data: Location[] }>("/locations")).data;
    dialogVisible.value = true;
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "库位加载失败"); }
}
async function create() {
  if (!form.name.trim()) { ElMessage.warning("请填写盘点任务名称"); return; }
  if (form.locationIds.length === 0) { ElMessage.warning("请至少选择一个盘点库位"); return; }
  saving.value = true;
  try {
    const response = await request<{ data: InventoryCount }>("/inventory-counts", {
      method: "POST",
      body: { name: form.name.trim(), locationIds: form.locationIds, notes: form.notes || null }
    });
    ElMessage.success("盘点任务已创建，所选库位已冻结");
    dialogVisible.value = false;
    await router.push(`/inventory-counts/${response.data.id}`);
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "创建盘点任务失败"); }
  finally { saving.value = false; }
}
function statusTagType(status: string) {
  if (status === "COUNTING") return "warning";
  if (status === "COMPLETED") return "success";
  return "info";
}
onMounted(() => load());
</script>

<template>
  <div>
    <header class="page-header"><div><h1>盘点任务</h1><p>创建任务会冻结所选库位，逐批录入实盘数后提交核销差异；重复提交不会产生二次调整。</p></div><el-button type="primary" @click="openCreate">新增盘点任务</el-button></header>
    <section class="toolbar"><el-form :inline="true" @submit.prevent="load(1)">
      <el-form-item label="关键词"><el-input v-model="filters.q" clearable @keyup.enter="load(1)" /></el-form-item>
      <el-form-item label="状态"><el-select v-model="filters.status" clearable style="width:130px"><el-option value="COUNTING" label="盘点中" /><el-option value="COMPLETED" label="已核销" /><el-option value="CANCELLED" label="已取消" /></el-select></el-form-item>
      <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button></el-form-item>
    </el-form></section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="任务名称" min-width="180"><template #default="{ row }"><router-link :to="`/inventory-counts/${row.id}`">{{ row.name }}</router-link></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusTagType(row.status)">{{ inventoryCountStatusLabels[row.status] || row.status }}</el-tag></template></el-table-column>
        <el-table-column label="冻结库位" prop="locationCount" width="90" />
        <el-table-column label="录入进度" width="110"><template #default="{ row }">{{ row.countedItemCount }} / {{ row.itemCount }}</template></el-table-column>
        <el-table-column label="差异批次" prop="differenceCount" width="90" />
        <el-table-column label="创建人" prop="startedByName" width="110" />
        <el-table-column label="创建时间" width="170"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
        <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="router.push(`/inventory-counts/${row.id}`)">{{ row.status === "COUNTING" ? "继续盘点" : "查看" }}</el-button></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length===0" description="还没有盘点任务" />
      <el-pagination v-if="meta.total>0" style="margin-top:16px;justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>

    <el-dialog v-model="dialogVisible" title="新增盘点任务" width="560px">
      <el-alert type="warning" :closable="false" show-icon title="创建后所选库位立即冻结" description="冻结期间这些库位内的批次不能消耗、调整、移库或归档，直到任务提交或取消。" style="margin-bottom:16px" />
      <el-form label-position="top">
        <el-form-item label="任务名称" required><el-input v-model="form.name" maxlength="120" placeholder="例如：九月染料柜盘点" /></el-form-item>
        <el-form-item label="盘点库位" required><el-select v-model="form.locationIds" multiple filterable style="width:100%" placeholder="选择一个或多个库位"><el-option v-for="location in locations" :key="location.id" :value="location.id" :label="location.name" /></el-select></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.notes" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="create">创建并冻结库位</el-button></template>
    </el-dialog>
  </div>
</template>
