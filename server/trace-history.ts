import type {DatabaseSync} from 'node:sqlite'
import type {CommerceCard} from '../shared/commerce.ts'
import type {DemoOrder} from './commerce-fixtures.ts'
import {appendTrace,cardTraceDetails,initTraceStore} from './trace-store.ts'

/** Only reconstruct facts for which the existing database has a timestamp and a saved record. */
export function importTraceHistory(db:DatabaseSync) {
  initTraceStore(db)
  db.exec('CREATE TABLE IF NOT EXISTS trace_migrations (name TEXT PRIMARY KEY) STRICT')
  db.exec('BEGIN IMMEDIATE')
  try {
    if (db.prepare('SELECT 1 FROM trace_migrations WHERE name=?').get('existing-records-v1')) {db.exec('COMMIT');return}
    const findOrder=db.prepare('SELECT o.payload FROM commerce_orders o JOIN commerce_accounts a ON o.owner=a.account WHERE a.conversation=? AND o.id=?')
    for(const row of db.prepare('SELECT payload FROM commerce_orders ORDER BY json_extract(payload,\'$.boughtAt\'),id').iterate()) {
      const order:DemoOrder=JSON.parse(String(row.payload))
      appendTrace(db,{kind:'order.historical',at:order.boughtAt,order:{shop:order.shop,owner:order.owner,orderId:order.id},
        details:{source:'history',orderedAt:order.boughtAt}})
    }
    const rows=db.prepare(`SELECT id AS cid, created_at AS at, 'session' AS action, id AS ref, NULL AS role,NULL AS card,0 AS tie FROM conversations
      UNION ALL SELECT conversation_id,at,'message',id,role,commerce_card,sequence FROM messages
      UNION ALL SELECT conversation_id,at,'lifecycle',CAST(version AS TEXT),
        CASE WHEN kind='resolved' AND by_customer=1 THEN 'customer_resolved' ELSE kind END,NULL,2147483647 FROM conversation_lifecycle
      UNION ALL SELECT conversation_id,json_extract(record,'$.createdAt'),'feedback',id,'captured',NULL,1 FROM feedback_cases
      UNION ALL SELECT conversation_id,json_extract(record,'$.publishedAt'),'feedback',id,'published',NULL,2 FROM feedback_cases WHERE json_extract(record,'$.publishedAt') IS NOT NULL
      ORDER BY at,tie`)
    for(const r of rows.iterate()){
      const conversationId=String(r.cid), at=Number(r.at), ref=String(r.ref)
      const base={conversationId,at,details:{source:'history'}}
      if(r.action==='session') appendTrace(db,{...base,kind:'session.created',dedupeKey:'session:'+conversationId})
      if(r.action==='lifecycle') appendTrace(db,{...base,kind:r.role==='customer_resolved'?'customer.resolved':r.role==='resolved'?'session.resolved':'session.reopened',dedupeKey:'transition:'+conversationId+':'+ref})
      if(r.action==='feedback') appendTrace(db,{...base,kind:r.role==='published'?'feedback.published':'feedback.captured',details:{...base.details,caseId:ref}})
      if(r.action==='message') {
        const card:CommerceCard|null=r.card?JSON.parse(String(r.card)):null
        const kind=r.role==='customer'?'customer.message':r.role==='agent'?'agent.reply':r.role==='system'?'system.message':card?'commerce.reply':'ai.completed'
        const saved=card?.orderId && findOrder.get(conversationId,card.orderId)
        const order:DemoOrder|undefined=saved?JSON.parse(String(saved.payload)):undefined
        appendTrace(db,{...base,kind,dedupeKey:'message:'+ref,
          ...(order && {order:{orderId:order.id,shop:order.shop,owner:order.owner}}),
          details:{...base.details,messageId:ref,...(card && cardTraceDetails(card))}})
      }
    }
    db.prepare('INSERT INTO trace_migrations(name) VALUES(?)').run('existing-records-v1')
    db.exec('COMMIT')
  } catch (error) {db.exec('ROLLBACK');throw error}
}
