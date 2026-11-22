const url = 'http://127.0.0.1:' + (process.env.PORT || 4873);
try {
  const res = await fetch(url + '/api/health', { signal: AbortSignal.timeout(4000) });
  const state = await res.json();
  if (!res.ok || state.app !== 'support-handoff') throw new Error('端口上的服务与本项目不符');
  console.log(JSON.stringify(state, null, 2));
  if (state.modules.ai !== 'configured') process.exitCode = 1;
} catch (e) {
  console.error('无法连接本地客服服务：' + e.message);
  process.exitCode = 1;
}
