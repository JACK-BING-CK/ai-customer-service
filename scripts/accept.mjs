// Launch an isolated copy and drive both roles over the same transport as the UI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { io } from 'socket.io-client';

const data = await mkdtemp(join(tmpdir(), 'support-accept-'));
const child = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, PORT: '0', SUPPORT_DATA_DIR: data, SUPPORT_AGENT_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stopped = new Promise(resolve => child.once('exit', resolve));
const sockets = [];
function waitFor(socket, event, check, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待超时 ' + event)); }, timeout);
    function cleanup() { clearTimeout(timer); socket.off(event, handler); }
    function handler(value) { if (check(value)) { cleanup(); resolve(value); } }
    socket.on(event, handler);
  });
}
function connect(url, auth) {
  const socket = io(url, { auth, forceNew: true, autoConnect: false, reconnection: false });
  sockets.push(socket);
  return socket;
}
async function send(socket, event, payload) {
  const result = await socket.timeout(5000).emitWithAck(event, payload);
  assert.equal(result.ok, true, event + ': ' + (result.error ?? ''));
}
try {
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试服务启动超时')), 15000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('测试服务提前退出 ' + code)); });
    lines.on('line', line => {
      try { const e = JSON.parse(line); if (e.event === 'ready') { clearTimeout(timer); resolve(e.url); } } catch {}
    });
  });
  const result = await fetch(url + '/api/conversations', { method: 'POST' });
  assert.equal(result.status, 201);
  const session = await result.json();
  const customer = connect(url, { role: 'customer', ...session });
  const agent = connect(url, { role: 'agent' });
  const initial = waitFor(customer, 'snapshot', s => s.id === session.id && s.mode === 'ai');
  const ready = waitFor(agent, 'queue', Array.isArray);
  customer.connect(); agent.connect();
  await Promise.all([initial, ready]);
  console.log('PASS 本机坐席免密进入会话队列');
  const answer = waitFor(customer, 'snapshot', s => !s.generating && s.messages.some(m => m.role === 'assistant' && m.text.trim()), 85000);
  await send(customer, 'customer:send', { text: '你好。请用一句中文介绍你能提供的帮助。', requestId: randomUUID() });
  const ai = await answer;
  console.log('PASS 实际 DeepSeek 回复（' + ai.messages.find(m => m.role === 'assistant').text.length + ' 字符）');
  const waiting = waitFor(agent, 'queue', items => items.some(s => s.id === session.id && s.mode === 'waiting'));
  await send(customer, 'customer:handoff', {});
  await waiting;
  const claimed = waitFor(customer, 'snapshot', s => s.mode === 'human');
  await send(agent, 'agent:claim', { id: session.id });
  await claimed;
  const received = waitFor(customer, 'snapshot', s => s.messages.some(m => m.role === 'agent' && m.text === '您好，已由我接待。'));
  await send(agent, 'agent:send', { id: session.id, text: '您好，已由我接待。', requestId: randomUUID() });
  await received;
  const followUp = waitFor(agent, 'queue', a => a.some(s => s.id === session.id && s.messages.some(m => m.text === '谢谢，继续在这里。')));
  await send(customer, 'customer:send', { text: '谢谢，继续在这里。', requestId: randomUUID() });
  await followUp;
  console.log('PASS 坐席收到请求并接单，双方在原会话互发消息');
  customer.disconnect();
  const restored = waitFor(customer, 'snapshot', s => s.id === session.id && s.mode === 'human' && s.messages.some(m => m.role === 'agent'));
  customer.connect();
  assert.equal((await restored).messages.filter(m => m.role === 'assistant').length, 1);
  console.log('PASS 断线后恢复原会话历史与人工状态');
} finally {
  for (const socket of sockets) socket.disconnect();
  child.kill();
  await stopped;
  await rm(data, { recursive: true, force: true, maxRetries: 3 });
}
