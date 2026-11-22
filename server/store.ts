import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Message, Snapshot } from '../shared/protocol.ts'
import type { LifecycleEvent, SessionSummary } from '../shared/diagnostics.ts'
import type { CommerceCard, CommerceQuery } from '../shared/commerce.ts'
import type { FaqReplayRoute } from './commerce-request.ts'
import { appendTrace, cardTraceDetails, initTraceStore } from './trace-store.ts'
import type { TraceDetails } from '../shared/trace.ts'

type Mode = Snapshot['mode']
type MessageRole = Message['role']
type AppendOptions = { requestId?: string; requiredMode?: Mode; nextMode?: Mode; handoffReason?: string;
  commerceQuery?: CommerceQuery; commerceCard?: CommerceCard; faqRoute?:FaqReplayRoute; onApplied?: () => void;
  causeMessageId?: string; handoffCode?: 'customer_message' | 'ai_failure' | 'commerce_review';
  failedStep?: {kind:'ai.failed'|'commerce.failed'; code:string} }
type AppendResult = 'applied' | 'duplicate' | 'conflict' | 'missing' | 'wrongMode'
type ConversationRow = Pick<Snapshot, 'id' | 'mode' | 'version' | 'createdAt' | 'updatedAt' | 'handoffReason'>
type DiagnosticRole = MessageRole | 'commerce'

const conversationColumns = `(
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'waiting', 'human', 'resolved')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  handoff_reason TEXT NOT NULL DEFAULT ''
) STRICT`

function hashToken(token: string) {
  return createHash('sha256').update(token).digest()
}

export function openStore(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations ${conversationColumns};

    CREATE TABLE IF NOT EXISTS messages (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('customer', 'assistant', 'agent', 'system')),
      text TEXT NOT NULL,
      at INTEGER NOT NULL,
      request_id TEXT,
      UNIQUE (conversation_id, role, request_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS conversation_history ON messages (conversation_id, sequence);
  `)

  transaction(() => {
    const messages = db.prepare('PRAGMA table_info(messages)').all().map(row => row.name)
    if (!messages.includes('commerce_query')) db.exec('ALTER TABLE messages ADD COLUMN commerce_query TEXT')
    if (!messages.includes('commerce_card')) db.exec('ALTER TABLE messages ADD COLUMN commerce_card TEXT')
    if (!messages.includes('faq_route')) db.exec('ALTER TABLE messages ADD COLUMN faq_route TEXT')
    if (!db.prepare('PRAGMA table_info(conversations)').all().some(row => row.name === 'handoff_reason')) {
      db.exec("ALTER TABLE conversations ADD COLUMN handoff_reason TEXT NOT NULL DEFAULT ''")
    }
  })
  // SQLite requires a table rebuild to extend the existing CHECK constraint.
  const oldSchema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='conversations'").get()
  if (!String(oldSchema?.sql).includes("'resolved'")) {
    db.exec('PRAGMA foreign_keys=OFF')
    try {
      transaction(() => {
        db.exec(`
          CREATE TABLE conversations_next ${conversationColumns};
          INSERT INTO conversations_next (id,token_hash,mode,version,created_at,updated_at,handoff_reason)
            SELECT id,token_hash,mode,version,created_at,updated_at,handoff_reason FROM conversations;
          DROP TABLE conversations;
          ALTER TABLE conversations_next RENAME TO conversations;
        `)
        if (db.prepare('PRAGMA foreign_key_check').get()) throw Error('会话升级时关联记录未通过校验。')
      })
    } finally { db.exec('PRAGMA foreign_keys=ON') }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_lifecycle (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('resolved','reopened')),
    at INTEGER NOT NULL, PRIMARY KEY (conversation_id,version)
  ) STRICT`)
  if (!db.prepare('PRAGMA table_info(conversation_lifecycle)').all().some(row=>row.name==='by_customer')) {
    db.exec('ALTER TABLE conversation_lifecycle ADD COLUMN by_customer INTEGER NOT NULL DEFAULT 0 CHECK(by_customer IN (0,1))')
  }
  const insertLifecycle = db.prepare('INSERT INTO conversation_lifecycle (conversation_id,version,kind,at,by_customer) VALUES (?,?,?,?,?)')
  const lifecycleHistory = db.prepare('SELECT kind,at,by_customer FROM conversation_lifecycle WHERE conversation_id=? ORDER BY version')
  const insertConversation = db.prepare(
    'INSERT INTO conversations (id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
  )
  const selectToken = db.prepare('SELECT token_hash FROM conversations WHERE id = ?')
  const conversationFields = 'id, mode, version, created_at AS createdAt, updated_at AS updatedAt, handoff_reason AS handoffReason'
  const selectConversation = db.prepare(`SELECT ${conversationFields} FROM conversations WHERE id = ?`)
  const selectQueue = db.prepare(`
    SELECT ${conversationFields} FROM conversations WHERE mode IN ('waiting','human')
    ORDER BY CASE mode WHEN 'waiting' THEN 0 ELSE 1 END, updated_at DESC, id
  `)
  const selectArchive = db.prepare(`SELECT ${conversationFields} FROM conversations WHERE mode='resolved' ORDER BY updated_at DESC,id`)
  const selectMessages = db.prepare('SELECT id, role, text, at, commerce_card FROM messages WHERE conversation_id = ? ORDER BY sequence')
  const selectModelMessages = db.prepare('SELECT id, role, text, at FROM messages WHERE conversation_id = ? AND commerce_query IS NULL AND commerce_card IS NULL ORDER BY sequence')
  const lastQuery = db.prepare('SELECT commerce_query FROM messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1')
  const latestMessage = db.prepare('SELECT id,role FROM messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1')
  const latestDiagnostics = db.prepare(`SELECT ${conversationFields} FROM conversations ORDER BY updated_at DESC, id LIMIT 50`)
  const searchDiagnostics = db.prepare(`SELECT ${conversationFields} FROM conversations WHERE id LIKE ? ORDER BY updated_at DESC, id LIMIT 50`)
  const modeTotals = db.prepare('SELECT mode, COUNT(*) AS count FROM conversations GROUP BY mode')
  const diagnosticRole = "CASE WHEN commerce_card IS NOT NULL THEN 'commerce' ELSE role END"
  const messageTotals = db.prepare(`SELECT ${diagnosticRole} AS role, COUNT(*) AS count, MAX(at) AS latest FROM messages WHERE conversation_id = ? GROUP BY 1`)
  const diagnosticHistory = db.prepare(`SELECT ${diagnosticRole} AS role, at FROM messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 80`)
  const selectRequest = db.prepare('SELECT text FROM messages WHERE conversation_id = ? AND role = ? AND request_id = ?')
  const insertMessage = db.prepare('INSERT INTO messages (id, conversation_id, role, text, at, request_id, commerce_query, commerce_card,faq_route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const updateConversation = db.prepare('UPDATE conversations SET mode = ?, version = version + 1, updated_at = MAX(updated_at, ?), handoff_reason = COALESCE(?, handoff_reason) WHERE id = ?')
  const updateMode = db.prepare('UPDATE conversations SET mode = ?, version = version + 1, updated_at = MAX(updated_at, ?), handoff_reason = COALESCE(?, handoff_reason) WHERE id = ? AND mode = ?')
  const bumpVersion = db.prepare('UPDATE conversations SET version = version + 1 WHERE id = ?')
  const selectPendingAI = db.prepare(`
    SELECT id FROM conversations
    WHERE mode = 'ai' AND (
      SELECT role FROM messages WHERE conversation_id = conversations.id ORDER BY sequence DESC LIMIT 1
    ) = 'customer'
  `)
  initTraceStore(db)

  function readConversation(id: string) {
    return selectConversation.get(id) as ConversationRow | undefined
  }

  function snapshot(row: ConversationRow): Snapshot {
    const messages: Message[] = selectMessages.all(row.id).map((message) => ({
      id: message.id as string,
      role: message.role as MessageRole,
      text: message.text as string,
      at: message.at as number,
      ...(typeof message.commerce_card === 'string' ? {commerceCard: JSON.parse(message.commerce_card) as CommerceCard} : {}),
    }))
    return {
      ...row,
      messages,
      generating: false,
      draft: '',
    }
  }

  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function traceTransition(id:string, previous:Mode, next:Mode, version:number, at:number,
    code?:string, messageId?:string) {
    const kind = next==='waiting' ? (previous==='resolved' ? 'session.reopened' : 'handoff.waiting')
      : next==='human' ? 'agent.claimed' : next==='resolved' ? (previous==='ai' ? 'customer.resolved' : 'session.resolved') : null
    if (!kind || previous===next) return
    appendTrace(db,{conversationId:id,kind,at,dedupeKey:`transition:${id}:${version}`,
      details:{...(code && {code}), ...(messageId && {messageId})}})
  }

  return {
    database: db,
    create(onCreate?: (id: string) => void) {
      const id = randomUUID()
      const token = randomBytes(32).toString('base64url')
      const now = Date.now()
      transaction(() => {
        insertConversation.run(id, hashToken(token), now, now)
        appendTrace(db,{kind:'session.created',conversationId:id,at:now,dedupeKey:'session:'+id})
        onCreate?.(id)
      })
      return { id, token }
    },
    authenticate(id: string, token: string) {
      if (typeof id !== 'string' || id.length !== 36 || typeof token !== 'string' || token.length !== 43) return false
      const stored = selectToken.get(id)?.token_hash
      return stored instanceof Uint8Array && timingSafeEqual(stored, hashToken(token))
    },
    snapshot(id: string) {
      const row = readConversation(id)
      return row ? snapshot(row) : null
    },
    listQueue(archive = false) {
      return ((archive ? selectArchive : selectQueue).all() as ConversationRow[]).map(snapshot)
    },
    listPendingAI() {
      return selectPendingAI.all().map((row) => row.id as string)
    },
    latestQuery(id: string): CommerceQuery | undefined {
      const value = lastQuery.get(id)?.commerce_query
      return typeof value === 'string' ? JSON.parse(value) : undefined
    },
    modelHistory(id: string) {
      return selectModelMessages.all(id) as unknown as Message[]
    },
    diagnosticSessions(search: string) {
      const rows = search ? searchDiagnostics.all(`%${search}`) : latestDiagnostics.all()
      return rows.map(({ id, mode, createdAt, updatedAt }) => ({ id, mode, createdAt, updatedAt }) as SessionSummary)
    },
    diagnosticCounts() {
      const result = { ai: 0, waiting: 0, human: 0, resolved: 0 }
      for (const row of modeTotals.all()) result[row.mode as Mode] = row.count as number
      return result
    },
    diagnosticSession(id: string) {
      const row = readConversation(id)
      if (!row) return null
      const { mode, createdAt, updatedAt } = row
      return {
        id, mode, createdAt, updatedAt,
        lifecycle: lifecycleHistory.all(id).map(({kind,at,by_customer}):LifecycleEvent=>({
          kind:kind as LifecycleEvent['kind'],at:Number(at),...(by_customer===1 && {by:'customer'}),
        })),
        totals: messageTotals.all(id) as { role: DiagnosticRole; count: number; latest: number }[],
        history: (diagnosticHistory.all(id) as { role: DiagnosticRole; at: number }[]).reverse(),
      }
    },
    append(id: string, role: MessageRole, text: string, options: AppendOptions = {}): AppendResult {
      return transaction(() => {
        const conversation = readConversation(id)
        if (!conversation) return 'missing'
        if (options.requestId !== undefined) {
          const existing = selectRequest.get(id, role, options.requestId)
          if (existing) return existing.text === text ? 'duplicate' : 'conflict'
        }
        if (options.requiredMode && conversation.mode !== options.requiredMode) return 'wrongMode'

        const now = Math.max(conversation.updatedAt, Date.now())
        const messageId=randomUUID()
        insertMessage.run(messageId, id, role, text, now, options.requestId ?? null,
          options.commerceQuery ? JSON.stringify(options.commerceQuery) : null,
          options.commerceCard ? JSON.stringify(options.commerceCard) : null,options.faqRoute ?? null)
        const nextMode=options.nextMode ?? conversation.mode
        updateConversation.run(nextMode, now, options.handoffReason ?? null, id)
        const cause:TraceDetails=options.causeMessageId ? {causeMessageId:options.causeMessageId} : {}
        if (options.failedStep) {
          appendTrace(db,{kind:options.failedStep.kind,conversationId:id,at:now,status:'error',
            dedupeKey:'failure:'+messageId,details:{...cause,code:options.failedStep.code}})
        }
        const kind=role==='customer' ? 'customer.message' : role==='agent' ? 'agent.reply'
          : role==='system' ? 'system.message' : options.commerceCard ? 'commerce.reply' : 'ai.completed'
        const card=options.commerceCard
        appendTrace(db,{kind,conversationId:id,at:now,dedupeKey:'message:'+messageId,
          details:{messageId,...cause,...(options.commerceQuery ? {queryKind:options.commerceQuery.kind} : {}),
            ...(card && cardTraceDetails(card))}})
        traceTransition(id,conversation.mode,nextMode,conversation.version+1,now,options.handoffCode,messageId)
        if (conversation.mode === 'resolved' && options.nextMode === 'waiting') {
          insertLifecycle.run(id,conversation.version+1,'reopened',now,0)
        }
        options.onApplied?.()
        return 'applied'
      })
    },
    setMode(id: string, previous: Mode, next: Mode, handoffReason?: string) {
      return transaction(() => {
        const at=Date.now()
        if (!updateMode.run(next,at,handoffReason ?? null,id,previous).changes) return false
        traceTransition(id,previous,next,readConversation(id)!.version,at,previous==='ai' && next==='waiting' ? 'customer_handoff' : undefined)
        return true
      })
    },
    resolve(id: string, version: number, actor:'agent'|'customer'='agent') {
      return transaction(() => {
        const row = readConversation(id)
        if (!row) return 'missing'
        if (row.mode === 'resolved') return 'already'
        const requiredMode=actor==='customer'?'ai':'human'
        if (row.mode!==requiredMode || row.version!==version) return 'changed'
        const last=actor==='customer' ? latestMessage.get(id) : undefined
        if (actor==='customer' && last?.role!=='assistant') return 'unanswered'
        const at = Math.max(Date.now(),row.updatedAt)
        updateMode.run('resolved',at,null,id,requiredMode)
        insertLifecycle.run(id,row.version+1,'resolved',at,actor==='customer'?1:0)
        traceTransition(id,requiredMode,'resolved',row.version+1,at,actor==='customer'?'customer_resolved':'agent_resolved',last?.id as string|undefined)
        return 'applied'
      })
    },
    bumpVersion(id: string) {
      bumpVersion.run(id)
    },
    close() {
      db.close()
    },
  }
}

export type Store = ReturnType<typeof openStore>
