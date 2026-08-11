import { createHmac } from 'node:crypto'
import {
  MessagingWebhookVerificationError,
  MetaWhatsAppWebhookAdapter,
  MockMessagingWebhookAdapter,
} from '../../packages/messaging/src/webhooks.ts'

const assert=(ok:boolean,msg:string)=>{ if(!ok) throw new Error(msg) }
const receivedAt=new Date('2026-08-10T04:00:00.000Z')

// Mock verification + canonical status.
const mockSecret='mock-secret-with-at-least-thirty-two-chars'
const mockBody=JSON.stringify({
  externalMessageId:'mock-wamid-1',
  status:'delivered',
  occurredAt:'2026-08-10T04:01:00.000Z',
})
const mockTimestamp=String(Math.floor(receivedAt.getTime()/1000))
const mockSignature=createHmac('sha256',mockSecret).update(`${mockTimestamp}.${mockBody}`).digest('hex')
const mock=new MockMessagingWebhookAdapter(mockSecret)
mock.verify({
  rawBody:mockBody,
  headers:{'x-ecc-timestamp':mockTimestamp,'x-ecc-signature':`sha256=${mockSignature}`},
  query:{},receivedAt,
})
const mockEvents=mock.parse({rawBody:mockBody,headers:{},query:{},receivedAt})
assert(mockEvents.length===1 && mockEvents[0]?.type==='message.status','mock parses canonical status')
assert(mockEvents[0]?.provider==='mock','mock provider set')

let rejected=false
try {
  mock.verify({rawBody:mockBody,headers:{'x-ecc-timestamp':mockTimestamp,'x-ecc-signature':'sha256=00'},query:{},receivedAt})
} catch (error) {
  rejected=error instanceof MessagingWebhookVerificationError
}
assert(rejected,'mock rejects invalid signature')

// Meta GET challenge.
const metaSecret='meta-app-secret-with-at-least-thirty-two-chars'
const meta=new MetaWhatsAppWebhookAdapter({appSecret:metaSecret,verifyToken:'ecc-verify-token'})
assert(meta.challenge({
  'hub.mode':'subscribe',
  'hub.verify_token':'ecc-verify-token',
  'hub.challenge':'123456',
})==='123456','Meta challenge accepted')
assert(meta.challenge({
  'hub.mode':'subscribe',
  'hub.verify_token':'wrong',
  'hub.challenge':'123456',
})===null,'Meta invalid challenge rejected')

// Meta POST verification + status normalization + inbound normalization.
const metaBody=JSON.stringify({
  object:'whatsapp_business_account',
  entry:[{
    id:'waba-1',
    changes:[{
      field:'messages',
      value:{
        metadata:{display_phone_number:'5521888888888',phone_number_id:'phone-id-1'},
        statuses:[{
          id:'wamid.outbound.1',
          status:'read',
          timestamp:'1786334460',
        }],
        messages:[{
          id:'wamid.inbound.1',
          from:'5521999999999',
          timestamp:'1786334520',
          type:'text',
          text:{body:'Confirmado'},
        }],
      },
    }],
  }],
})
const metaSignature=createHmac('sha256',metaSecret).update(metaBody).digest('hex')
meta.verify({
  rawBody:metaBody,
  headers:{'x-hub-signature-256':`sha256=${metaSignature}`},
  query:{},receivedAt,
})
const metaEvents=meta.parse({rawBody:metaBody,headers:{},query:{},receivedAt})
assert(metaEvents.length===2,'Meta payload emits status + inbound')
const status=metaEvents.find((event)=>event.type==='message.status')
assert(status?.type==='message.status' && status.status==='read','Meta read status normalized')
const inbound=metaEvents.find((event)=>event.type==='message.received')
assert(inbound?.type==='message.received' && inbound.sender==='5521999999999','Meta inbound sender normalized')
if(inbound?.type==='message.received'){
  assert(inbound.recipient==='5521888888888','Meta recipient resolved from metadata')
  assert(inbound.content.type==='text' && inbound.content.text==='Confirmado','Meta text normalized')
}

rejected=false
try {
  meta.verify({rawBody:metaBody,headers:{'x-hub-signature-256':'sha256=00'},query:{},receivedAt})
} catch (error) {
  rejected=error instanceof MessagingWebhookVerificationError
}
assert(rejected,'Meta rejects invalid signature')

console.log('MessagingWebhookAdapters: 10/10 behavioral scenarios passed')
