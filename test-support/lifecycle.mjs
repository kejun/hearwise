export function deadline(operation, ms, label) {
  let timer;
  return Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  })]).finally(() => clearTimeout(timer));
}

export async function stopChild(child, timeoutMs = 3000) {
  if (child.exitCode != null || child.signalCode != null || !child.pid) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  try { await deadline(() => exited, timeoutMs, `server ${child.pid} shutdown`); }
  catch (error) {
    child.kill('SIGKILL');
    await deadline(() => exited, 1500, `server ${child.pid} forced exit`);
    throw error;
  }
}

export async function closeServer(server, label) {
  if (server.clients) for (const client of server.clients) client.terminate();
  server.closeAllConnections?.();
  await deadline(() => new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
  })), 3000, `${label} shutdown`);
}
