import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.ts';
import { createService } from './service.ts';
import { bindRealtime, notifyDiagnostics } from './realtime.ts';
import { generateReply } from './ai.ts';
import { log, setLogDestination } from './log.ts';
import { createDiagnostics } from './diagnostics.ts';
import { openCommerce } from './commerce.ts';
import { merchantRoutes } from './merchant-routes.ts';
import { openMerchant } from './merchant-store.ts';
import { openFeedback } from './feedback-store.ts';
import { feedbackRoutes } from './feedback-routes.ts';
import { importTraceHistory } from './trace-history.ts';
import { importLegacyServiceLog } from './trace-log-history.ts';
import { traceRoutes } from './trace-routes.ts';
import { demoCheckoutRoutes } from './demo-checkout.ts';
import { hubPath, projectPages } from '../shared/pages.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(process.env.SUPPORT_DATA_DIR || join(root, 'data'));
const port = Number(process.env.PORT ?? '4873');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口配置无效');
mkdirSync(dataDir, { recursive: true });
setLogDestination(join(dataDir, 'service.jsonl'));

const store = openStore(join(dataDir, 'sessions.sqlite'));
const commerce = openCommerce(store.database, {
  onTrace(id, trace) {
    log(trace.step, trace.code, { conversationId: id, elapsedMs: trace.elapsedMs, ...(trace.version ? {version:trace.version} : {}) });
  },
});
const merchant = openMerchant(store.database);
const feedback = openFeedback(store.database,merchant);
importTraceHistory(store.database);
await importLegacyServiceLog(store.database, join(dataDir, 'service.jsonl'));
let publish: (id: string) => void = () => {};
const service = createService(store, generateReply, id => publish(id), commerce);
const app = express();
app.disable('x-powered-by');
const http = createServer(app);
const loopback = new Set(['localhost', '127.0.0.1']);
function allowed(host: string | undefined, origin: string | undefined) {
  try {
    if (!host || !loopback.has(new URL('http://' + host).hostname)) return false;
    if (!origin) return true;
    return origin === 'http://' + host;
  } catch { return false; }
}
const io = new Server(http, {
  maxHttpBufferSize: 65536,
  allowRequest: (req, done) => done(null, allowed(req.headers.host, req.headers.origin)),
});
const diagnostics = createDiagnostics(store, {
  logPath: join(dataDir, 'service.jsonl'),
  activeAI: service.isGenerating,
  activeCommerce: service.isCheckingOrder,
  activeCount: service.activeGenerationCount,
  aiConfigured: () => Boolean(process.env.DEEPSEEK_API_KEY),
  connections: (selectedId?: string) => {
    const counts = { customers: 0, agents: 0, selectedCustomers: 0, customerViews: 0, agentViews: 0,
      selectedCustomerViews: 0, selectedAgentViews: 0, lastViewAt: null as number | null };
    for (const socket of io.of('/').sockets.values()) {
      const actor = socket.data.actor;
      if (actor?.role !== 'customer' && actor?.role !== 'agent') continue;
      const customer = actor.role === 'customer';
      counts[customer ? 'customers' : 'agents']++;
      if (customer && selectedId && actor.id === selectedId) counts.selectedCustomers++;
      const view = socket.data.view;
      if (!view) continue;
      counts[customer ? 'customerViews' : 'agentViews']++;
      if (view.id === selectedId) counts[customer ? 'selectedCustomerViews' : 'selectedAgentViews']++;
      counts.lastViewAt = Math.max(counts.lastViewAt ?? 0, view.at);
    }
    return counts;
  },
});
publish = bindRealtime(io, service, store, process.env.SUPPORT_AGENT_KEY, diagnostics.read);
app.use((req, res, next) => {
  if (!allowed(req.headers.host, req.headers.origin)) { res.sendStatus(403); return; }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    app: 'support-handoff', status: 'ready',
    modules: { storage: 'sqlite', realtime: 'socket.io', ai: process.env.DEEPSEEK_API_KEY ? 'configured' : 'missing_key', commerce: 'demo', merchant: 'local' },
  });
});
class LoginDenied extends Error {}
app.post('/api/conversations', express.json({limit:'2kb'}), (req, res) => {
  const login = req.body;
  if (login !== undefined && (!login || typeof login !== 'object' || Array.isArray(login) ||
      typeof login.account !== 'string' || typeof login.pin !== 'string' || login.pin.length > 32)) {
    res.status(400).json({error:'请输入测试账号和口令。'}); return;
  }
  let session;
  try {
    session = store.create(id => {
      if (login && !commerce.login(id, login.account, login.pin)) throw new LoginDenied();
    });
  } catch (error) {
    if (!(error instanceof LoginDenied)) throw error;
    res.status(401).json({error:'测试账号或口令不正确。'}); return;
  }
  log('session', 'created', { conversationId: session.id });
  publish(session.id);
  res.set('Cache-Control', 'no-store').status(201).json(session);
});
app.use('/api/debug/trace', traceRoutes(store.database,process.env.SUPPORT_AGENT_KEY));
app.use('/api/conversations/:conversationId/demo-orders', demoCheckoutRoutes(store,merchant,publish));
app.use('/api/merchant', merchantRoutes(store.database, merchant));
app.use('/api/feedback', feedbackRoutes(feedback, process.env.SUPPORT_AGENT_KEY, () => notifyDiagnostics(io)));
app.use('/api', (_req, res) => { res.sendStatus(404); });
const web = join(root, 'dist', 'client');
app.use(express.static(web));
app.get([hubPath, ...projectPages.map(page => page.path)], (_req, res) => {
  if (!existsSync(join(web, 'index.html'))) { res.status(503).send('请先执行 npm run build'); return; }
  res.sendFile(join(web, 'index.html'));
});
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const ref = randomUUID();
  log('http', 'failed', { ref, kind: error.name });
  res.status(500).json({ error: '服务暂时不可用', ref });
});
http.on('error', (error: NodeJS.ErrnoException) => {
  log('server', 'listen_failed', { code: error.code ?? 'unknown', port });
  process.exit(1);
});
http.listen(port, '127.0.0.1', () => {
  const address = http.address();
  if (address && typeof address === 'object') log('server', 'ready', { url: 'http://127.0.0.1:' + address.port });
});
function stop() {
  service.shutdown();
  io.close(() => { commerce.close(); store.close(); process.exit(0); });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
