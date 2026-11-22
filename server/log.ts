import { appendFileSync } from 'node:fs';
import type { PolicyConflict } from '../shared/merchant.ts';
import type { PolicyMismatch } from '../shared/feedback.ts';

let destination: string | undefined;
export function setLogDestination(path: string) { destination = path; }

/** Only identifiers, counters and stable event names belong here, never chat text or credentials. */
type LogField = string | number | boolean | number[] | PolicyConflict[] | PolicyMismatch[];
export function log(module: string, event: string, fields: Record<string, LogField> = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), module, event, ...fields });
  console.log(line);
  if (destination) {
    try { appendFileSync(destination, line + '\n', 'utf8'); }
    catch { console.error('诊断日志写入失败，请检查数据目录的空间和权限'); }
  }
}
