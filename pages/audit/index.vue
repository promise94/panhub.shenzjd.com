<script setup lang="ts">
definePageMeta({ middleware: "audit" });

interface AuditItem {
  searchedAt: string;
  keyword: string;
  source: string;
  method: string;
  ip: string;
  statusCode: number;
  success: boolean;
  durationMs: number;
  resultCount: number | null;
  userAgent: string | null;
  requestId: string | null;
  channels: string[];
  plugins: string[];
  cloudTypes: string[];
  errorMessage: string | null;
}
interface LogsData {
  items: AuditItem[];
  total: number;
  page: number;
  pageSize: number;
}
interface StatsData {
  total: number;
  successCount: number;
  failureCount: number;
  byMethod: { _id: string; count: number }[];
  byStatusCode: { _id: number; count: number }[];
  daily: { _id: string; count: number }[];
}

const filters = reactive({
  ip: "",
  keyword: "",
  method: "",
  statusCode: "",
  success: "",
});
const page = ref(1);
const pageSize = ref(50);
const logs = ref<LogsData | null>(null);
const stats = ref<StatsData | null>(null);
const loading = ref(false);
const error = ref("");
const expandedRow = ref<string | null>(null);

function buildQuery(): Record<string, string> {
  const q: Record<string, string> = {
    page: String(page.value),
    pageSize: String(pageSize.value),
  };
  if (filters.ip) q.ip = filters.ip;
  if (filters.keyword) q.keyword = filters.keyword;
  if (filters.method) q.method = filters.method;
  if (filters.statusCode) q.statusCode = filters.statusCode;
  if (filters.success) q.success = filters.success;
  return q;
}

async function fetchLogs() {
  loading.value = true;
  error.value = "";
  try {
    const res = await $fetch<{ data: LogsData }>("/api/audit/logs", { query: buildQuery() });
    logs.value = res.data;
  } catch (e: any) {
    error.value = e?.statusMessage || "加载失败";
  } finally {
    loading.value = false;
  }
}

async function fetchStats() {
  try {
    const res = await $fetch<{ data: StatsData }>("/api/audit/stats");
    stats.value = res.data;
  } catch {
    // ignore stats errors
  }
}

function applyFilters() {
  page.value = 1;
  fetchLogs();
}

function changePage(p: number) {
  page.value = p;
  fetchLogs();
}

function rowKey(item: AuditItem, i: number): string {
  return item.requestId || `row-${i}`;
}

function toggleRow(key: string) {
  expandedRow.value = expandedRow.value === key ? null : key;
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString("zh-CN");
  } catch {
    return s;
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtList(arr: string[]): string {
  return Array.isArray(arr) && arr.length > 0 ? arr.join(", ") : "-";
}

const totalPages = computed(() =>
  logs.value ? Math.max(1, Math.ceil(logs.value.total / logs.value.pageSize)) : 1
);

const recent7dTotal = computed(() =>
  stats.value ? stats.value.daily.reduce((sum, d) => sum + d.count, 0) : 0
);

async function logout() {
  await $fetch("/api/audit/logout", { method: "POST" });
  await navigateTo("/audit/login");
}

onMounted(() => {
  fetchStats();
  fetchLogs();
});
</script>

<template>
  <div class="audit-page">
    <header class="audit-header">
      <h1>搜索审计</h1>
      <button class="logout-btn" @click="logout">退出</button>
    </header>

    <section v-if="stats" class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">总记录</div>
        <div class="stat-value">{{ stats.total }}</div>
      </div>
      <div class="stat-card success">
        <div class="stat-label">成功</div>
        <div class="stat-value">{{ stats.successCount }}</div>
      </div>
      <div class="stat-card failure">
        <div class="stat-label">失败</div>
        <div class="stat-value">{{ stats.failureCount }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">近7天</div>
        <div class="stat-value">{{ recent7dTotal }}</div>
      </div>
    </section>

    <section class="filters">
      <input v-model="filters.ip" placeholder="IP" />
      <input v-model="filters.keyword" placeholder="关键词" />
      <select v-model="filters.method">
        <option value="">全部方法</option>
        <option>GET</option>
        <option>POST</option>
      </select>
      <input v-model="filters.statusCode" placeholder="状态码" type="number" />
      <select v-model="filters.success">
        <option value="">全部状态</option>
        <option value="true">成功</option>
        <option value="false">失败</option>
      </select>
      <button @click="applyFilters">查询</button>
    </section>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>关键词</th>
            <th>来源</th>
            <th>方法</th>
            <th>IP</th>
            <th>状态码</th>
            <th>耗时</th>
            <th>结果数</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(item, i) in logs?.items || []" :key="rowKey(item, i)">
            <tr
              :class="{ fail: !item.success }"
              @click="toggleRow(rowKey(item, i))"
            >
              <td>{{ fmtDate(item.searchedAt) }}</td>
              <td>{{ item.keyword || "(空)" }}</td>
              <td>{{ item.source }}</td>
              <td>{{ item.method }}</td>
              <td>{{ item.ip }}</td>
              <td>{{ item.statusCode }}</td>
              <td>{{ fmtDuration(item.durationMs) }}</td>
              <td>{{ item.resultCount ?? "-" }}</td>
            </tr>
            <tr v-if="expandedRow === rowKey(item, i)" class="detail">
              <td colspan="8">
                <div><span>requestId:</span> {{ item.requestId || "-" }}</div>
                <div><span>User-Agent:</span> {{ item.userAgent || "-" }}</div>
                <div><span>channels:</span> {{ fmtList(item.channels) }}</div>
                <div><span>plugins:</span> {{ fmtList(item.plugins) }}</div>
                <div><span>cloudTypes:</span> {{ fmtList(item.cloudTypes) }}</div>
                <div v-if="item.errorMessage" class="err-msg">
                  <span>error:</span> {{ item.errorMessage }}
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <footer v-if="logs" class="pagination">
      <span>共 {{ logs.total }} 条</span>
      <button :disabled="page <= 1" @click="changePage(page - 1)">上一页</button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" @click="changePage(page + 1)">下一页</button>
    </footer>
  </div>
</template>

<style scoped>
.audit-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
  font-family: system-ui, -apple-system, sans-serif;
}
.audit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}
.audit-header h1 {
  font-size: 20px;
  margin: 0;
}
.logout-btn {
  padding: 6px 14px;
  border: 1px solid #ddd;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}
.stat-card {
  padding: 14px;
  border: 1px solid #eee;
  border-radius: 8px;
  background: #fafafa;
}
.stat-card.success {
  border-color: #b7eb8f;
  background: #f6ffed;
}
.stat-card.failure {
  border-color: #ffa39e;
  background: #fff2f0;
}
.stat-label {
  font-size: 12px;
  color: #888;
}
.stat-value {
  font-size: 22px;
  font-weight: 600;
  margin-top: 4px;
}
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.filters input,
.filters select {
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 13px;
}
.filters button {
  padding: 6px 16px;
  background: #185fa5;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.table-wrap {
  overflow-x: auto;
  border: 1px solid #eee;
  border-radius: 8px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid #f0f0f0;
  white-space: nowrap;
}
th {
  background: #fafafa;
  font-weight: 500;
  color: #666;
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover {
  background: #f5faff;
}
tr.fail td:nth-child(6) {
  color: #f5222d;
}
tr.detail td {
  background: #fafafa;
  white-space: normal;
}
tr.detail div {
  margin: 2px 0;
  color: #666;
  font-size: 12px;
}
tr.detail span {
  color: #999;
}
.err-msg {
  color: #f5222d !important;
}
.pagination {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  justify-content: center;
}
.pagination button {
  padding: 4px 12px;
  border: 1px solid #ddd;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
}
.pagination button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error {
  color: #f5222d;
}
@media (prefers-color-scheme: dark) {
  .audit-page {
    color: #eee;
  }
  .stat-card {
    background: #1f1f1f;
    border-color: #333;
  }
  .stat-card.success {
    background: #162312;
    border-color: #274916;
  }
  .stat-card.failure {
    background: #2a1215;
    border-color: #5c2b2e;
  }
  .filters input,
  .filters select {
    background: #1f1f1f;
    color: #eee;
    border-color: #444;
  }
  th {
    background: #1f1f1f;
    color: #aaa;
  }
  td {
    border-bottom-color: #2a2a2a;
  }
  tbody tr:hover {
    background: #16213a;
  }
  tr.detail td {
    background: #1a1a1a;
  }
  .table-wrap {
    border-color: #333;
  }
  .logout-btn,
  .pagination button {
    background: #1f1f1f;
    color: #eee;
    border-color: #444;
  }
}
</style>
