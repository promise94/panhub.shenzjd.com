export default defineNuxtRouteMiddleware(async () => {
  try {
    const res = await $fetch<{ data: { loggedIn: boolean } }>("/api/audit/status");
    if (!res.data?.loggedIn) {
      return navigateTo("/audit/login");
    }
  } catch {
    return navigateTo("/audit/login");
  }
});
