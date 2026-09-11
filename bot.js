// Milky Way Galaxy — community bot
// Answers questions from knowledge.md. No commands, no buybot.

const fs = require('fs')
const path = require('path')
const TelegramBot = require('node-telegram-bot-api')

// ─── config ──────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if (!BOT_TOKEN)         { console.error('missing BOT_TOKEN');         process.exit(1) }
if (!ANTHROPIC_API_KEY) { console.error('missing ANTHROPIC_API_KEY'); process.exit(1) }

const MODEL      = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 250      // keeps replies short and the bill low

const USER_COOLDOWN_MS = 8 * 1000    // per user, for tagged replies
const CHAT_COOLDOWN_MS = 90 * 1000   // per chat, for ambient replies
const AMBIENT_RATE     = 0.2         // 20% of trigger hits get a reply
const DAILY_CAP        = 600         // total API replies per day, then quiet

// words that make the bot consider chiming in untagged
const TRIGGERS = [
  'galaxy', '$galaxy', 'milky way', 'milkyway', 'jupiterian', 'jupiter',
  'mercury', 'mars', 'venus', 'saturn', 'neptune', 'uranus',
  'earth traveler', 'earth travelers', 'traveler',
  'mint', 'minting', 'allowlist', 'whitelist', 'snapshot',
  'airdrop', 'holder', 'rare', 'xrp.cafe', 'xrpl', 'liquidity', 'pool',
  'demon ego', 'collection', 'wen', 'when moon', 'floor',
  'how do i', 'how to', 'what is', 'anyone know', 'can someone',
]

// ─── knowledge ───────────────────────────────────────────────────────────
const KNOWLEDGE = fs.readFileSync(path.join(__dirname, 'knowledge.md'), 'utf8')
console.log('📖 knowledge loaded — ' + KNOWLEDGE.length + ' chars')

const PERSONA = `
You are the community bot for the Milky Way Galaxy Collection, an NFT project on
the XRP Ledger. You live in the project's Telegram group.

HOW YOU TALK
- Short. Two or three sentences most of the time. This is a chat, not an article.
- Plain and warm. You're a knowledgeable member of the community, not a support desk.
- No corporate tone, no "I'd be happy to assist you", no bullet lists unless asked.
- Light on emoji. One at most, often none.
- Never call anyone "sir". Never assume you're talking to the founder — Demon Ego
  is the artist, and everyone in here is a community member unless they say otherwise.

WHAT YOU KNOW
Everything in the knowledge base below. That is the complete set of facts.
If the answer is not in there, say you're not sure and suggest asking an admin.
Never guess at numbers, dates, addresses or links. A wrong answer is worse than none.

Do not repeat the whole knowledge base at someone. Answer the question asked.
`.trim()

// extra instruction used only when the bot wasn't spoken to directly
const AMBIENT_RULE = `
IMPORTANT — you were NOT tagged. You are choosing whether to chime in on a message
that wasn't addressed to you. Be conservative.

Reply ONLY if there is a real question you can answer from the knowledge base, or a
clear factual mistake about the project worth correcting.

Reply with exactly the word NOTHING if:
- It's small talk, banter, a joke, or people chatting between themselves
- Someone already answered it
- It's about price, charts, or whether to buy
- It's vague, or you'd just be restating something obvious
- You'd be interrupting rather than helping

Butting into a conversation nobody wanted you in is worse than staying quiet.
When in doubt: NOTHING.
`.trim()

// ─── state ───────────────────────────────────────────────────────────────
const lastReplyAt   = new Map()   // userId -> timestamp
const lastAmbientAt = new Map()   // chatId -> timestamp
let dailyCount = 0
let dailyResetAt = Date.now() + 24 * 60 * 60 * 1000

const rand = a => a[Math.floor(Math.random() * a.length)]

const GM = [
  'gm 🌌',
  'gm — another day in the galaxy',
  'gm. hope the pool is deep today',
  'gm 🪐',
]
const GN = [
  'gn 🌌 the galaxy keeps turning',
  'gn — rest up',
  'gn 🪐',
]

// ─── telegram ────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true })

let BOT_USERNAME = ''
bot.getMe()
  .then(me => {
    BOT_USERNAME = (me.username || '').toLowerCase()
    console.log('🤖 running as @' + BOT_USERNAME)
  })
  .catch(e => console.error('getMe failed:', e.message))

// ─── anthropic ───────────────────────────────────────────────────────────
async function ask(question, askerName, isAmbient) {
  const system = [
    { type: 'text', text: PERSONA + (isAmbient ? '\n\n' + AMBIENT_RULE : '') },
    {
      // the big static block — cached so we pay ~10% on repeat sends
      type: 'text',
      text: 'KNOWLEDGE BASE\n\n' + KNOWLEDGE,
      cache_control: { type: 'ephemeral' },
    },
  ]

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [
        { role: 'user', content: `${askerName} says: ${question}` },
      ],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json()

  const u = data.usage || {}
  console.log(
    `   tokens in=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} ` +
    `cache_write=${u.cache_creation_input_tokens || 0} out=${u.output_tokens}`
  )

  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim()
}

// ─── helpers ─────────────────────────────────────────────────────────────
function underDailyCap() {
  if (Date.now() > dailyResetAt) {
    dailyCount = 0
    dailyResetAt = Date.now() + 24 * 60 * 60 * 1000
  }
  if (dailyCount >= DAILY_CAP) {
    console.log('⛔ daily cap reached, staying quiet')
    return false
  }
  return true
}

function hitsTrigger(lower) {
  return TRIGGERS.some(t => lower.includes(t))
}

// ─── message handler ─────────────────────────────────────────────────────
bot.on('message', async msg => {
  const text = (msg.text || '').trim()
  if (!text) return
  if (msg.from?.is_bot) return

  const lower  = text.toLowerCase()
  const chatId = msg.chat.id
  const userId = msg.from.id
  const name   = msg.from.first_name || 'someone'

  // free greetings — no API call, no cost
  if (/^gm\b/.test(lower)) return void bot.sendMessage(chatId, rand(GM))
  if (/^gn\b/.test(lower)) return void bot.sendMessage(chatId, rand(GN))

  const tagged = BOT_USERNAME && lower.includes('@' + BOT_USERNAME)
  const repliedToBot =
    msg.reply_to_message?.from?.username?.toLowerCase() === BOT_USERNAME
  const direct = tagged || repliedToBot

  let isAmbient = false

  if (!direct) {
    // ── should we chime in uninvited? ──
    if (text.length < 12) return                 // too short to be a real question
    if (!hitsTrigger(lower)) return              // nothing relevant in it
    if (Math.random() > AMBIENT_RATE) return     // stay quiet most of the time

    const lastAmbient = lastAmbientAt.get(chatId) || 0
    if (Date.now() - lastAmbient < CHAT_COOLDOWN_MS) return  // don't crowd the chat

    isAmbient = true
    lastAmbientAt.set(chatId, Date.now())
  } else {
    const last = lastReplyAt.get(userId) || 0
    if (Date.now() - last < USER_COOLDOWN_MS) return
    lastReplyAt.set(userId, Date.now())
  }

  if (!underDailyCap()) return

  const question = text.replace(new RegExp('@' + BOT_USERNAME, 'ig'), '').trim()
  if (!question) return void bot.sendMessage(chatId, 'what do you want to know?')

  if (direct) bot.sendChatAction(chatId, 'typing').catch(() => {})

  try {
    dailyCount++
    const answer = await ask(question, name, isAmbient)

    // the model can decline to speak on ambient messages
    if (!answer || answer.toUpperCase().replace(/[^A-Z]/g, '') === 'NOTHING') {
      console.log(`🤐 passed on ${name}'s message${isAmbient ? ' (ambient)' : ''}`)
      return
    }

    await bot.sendMessage(chatId, answer, { reply_to_message_id: msg.message_id })
    console.log(
      `✅ replied to ${name}${isAmbient ? ' (ambient)' : ''} ` +
      `(${dailyCount}/${DAILY_CAP} today)`
    )
  } catch (e) {
    console.error('❌ ' + e.message)
    if (direct) {
      bot.sendMessage(chatId, 'something broke on my end — try again in a bit')
        .catch(() => {})
    }
  }
})

bot.on('polling_error', e => console.error('polling:', e.message))

bot.on('migrate_to_chat_id', msg => {
  console.log('🔀 group migrated: ' + msg.chat.id + ' -> ' + msg.migrate_to_chat_id)
})

console.log('🌌 milky way bot starting...')
