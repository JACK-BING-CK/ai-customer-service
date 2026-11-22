import { createHash, timingSafeEqual } from 'node:crypto'

export function staffAccess(key?: string) {
  const digest = (value:string) => createHash('sha256').update(value).digest()
  const expected = key ? digest(key) : null
  return (token:unknown) => !expected || (typeof token === 'string' && token.length <= 4096 && timingSafeEqual(expected, digest(token)))
}
