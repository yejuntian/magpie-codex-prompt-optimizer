(async () => {
  await magpie.ready;
  const options = await magpie.options.get().catch(() => ({}));
  const port = Number(options.servicePort) || 47821;
  const service = magpie.service || `http://127.0.0.1:${port}/`;
  const target = new URL(service, location.href);
  if (!target.pathname.endsWith("/")) target.pathname += "/";
  location.replace(target.href);
})().catch((error) => {
  document.body.textContent = `无法打开本地服务：${String(error?.message || error)}`;
});
