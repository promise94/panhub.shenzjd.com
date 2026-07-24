<script setup lang="ts">
const token = ref("");
const error = ref("");
const loading = ref(false);

async function submit() {
  error.value = "";
  loading.value = true;
  try {
    await $fetch("/api/audit/login", { method: "POST", body: { token: token.value } });
    await navigateTo("/audit");
  } catch (e: any) {
    error.value = e?.statusMessage || "登录失败";
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    const res = await $fetch<{ data: { enabled: boolean; loggedIn: boolean } }>(
      "/api/audit/status"
    );
    if (res.data?.loggedIn) {
      await navigateTo("/audit");
    } else if (!res.data?.enabled) {
      error.value = "审计管理未启用（未配置 SEARCH_AUDIT_ADMIN_TOKEN）";
    }
  } catch {
    // ignore
  }
});
</script>

<template>
  <div class="login-page">
    <form class="login-form" @submit.prevent="submit">
      <h1>搜索审计管理</h1>
      <input
        v-model="token"
        type="password"
        placeholder="Admin Token"
        autocomplete="off"
      />
      <button type="submit" :disabled="loading || !token">
        {{ loading ? "登录中..." : "登录" }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 60vh;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 320px;
  padding: 32px;
  border: 1px solid #eee;
  border-radius: 12px;
}
.login-form h1 {
  font-size: 18px;
  margin: 0 0 8px;
  text-align: center;
}
.login-form input {
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
}
.login-form button {
  padding: 10px;
  background: #185fa5;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.login-form button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.error {
  color: #f5222d;
  font-size: 13px;
  margin: 0;
}
@media (prefers-color-scheme: dark) {
  .login-form {
    border-color: #333;
  }
  .login-form input {
    background: #1f1f1f;
    color: #eee;
    border-color: #444;
  }
}
</style>
