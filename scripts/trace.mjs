import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const key = (process.argv[2] ?? '').toLowerCase();
if (!/^(?:[a-f0-9]{6}|[a-f0-9-]{36})$/.test(key)) {
  console.error('请提供会话编号（页面显示的末六位，或完整 ID）。');
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const path = join(resolve(process.env.SUPPORT_DATA_DIR || join(root, 'data')), 'service.jsonl');
  let count = 0;
  try {
    for await (const line of createInterface({ input: createReadStream(path) })) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!String(e.conversationId || '').toLowerCase().endsWith(key)) continue;
      console.log(line);
      count++;
    }
    if (!count) console.log('没有找到匹配的会话事件。');
  } catch (e) {
    console.error('无法读取运行日志：' + e.code);
    process.exitCode = 1;
  }
}
