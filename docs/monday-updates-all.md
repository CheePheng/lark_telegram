# Monday.com Updates — iGaming AI Customer Service (per item · EN + 中文)

> Paste each block into the matching item's **Updates**. Each block has **What it does** (for the boss) and **How it's built** (for the tech team).

---

## Basic Setup / 基础平台

**What it does (EN):** The shared platform that connects every customer channel (Lark, Telegram) into **one Intercom inbox**. A customer's message becomes a **real, replyable Intercom conversation** where Fin AI answers and a human can take over — all in one place.

**How it's built (EN):**
- A single **Cloudflare Worker** (serverless, TypeScript) is the backend brain: it receives channel messages, bridges them into Intercom, relays replies back, and exposes the data API Fin calls.
- **Cloudflare KV** stores the state that maps each customer ↔ their Intercom conversation, so replies always route back to the right person.
- **Intercom workspace: DKM-IGAMING.** Conversations are created via the **Conversations API** as *normal* conversations (not the read-only "external system" type), so **both Fin and human agents can reply** in them.
- All credentials are **encrypted secrets** in Cloudflare (zero secrets in code); a **per-channel feature flag** controls rollout.
- Deployed with Wrangler; live logs and KV state are viewable for operations.

**做什么 (CN):** 把每个客户渠道（Lark、Telegram）汇聚到 **同一个 Intercom 收件箱** 的共享平台。客户消息会变成 Intercom 里 **真实、可回复的对话**，Fin AI 自动回答，人工可接手 —— 全在一处。

**怎么做的 (CN):**
- 一个 **Cloudflare Worker**（无服务器，TypeScript）作为后端中枢：接收渠道消息、桥接到 Intercom、把回复发回、并对外提供给 Fin 调用的数据接口。
- **Cloudflare KV** 存储"客户 ↔ Intercom 对话"映射，保证回复发回正确的人。
- **Intercom 工作区：DKM-IGAMING。** 对话通过 **Conversations API** 建成 *普通* 对话（非只读"外部系统"对话），因此 **Fin 与人工都能在其中回复**。
- 所有密钥为 Cloudflare **加密 secret**（代码零明文）；用 **按渠道的功能开关** 控制上线。
- 用 Wrangler 部署；可查看实时日志与 KV 状态用于运维。

---

## Telegram Integration / Telegram 集成　—　✅ Done / 已完成

**What it does (EN):** Customers DM the Telegram bot and chat with **Fin** (incl. **live deposit/withdrawal status**); a human agent can take over **in the same Intercom conversation**, replying straight back to Telegram.

**How it's built (EN):**
- Telegram Bot API webhook → Worker `/telegram/webhook` (verified by secret token).
- Inbound is **acknowledged instantly** and processed in the background, so Telegram never times-out/retries; updates are **de-duplicated by `update_id`**.
- The message creates/continues that customer's Intercom conversation; Fin's answer is relayed back; human replies relay via the Intercom webhook.
- Commands supported: `/start`, `/reset`.

**做什么 (CN):** 客户私聊 Telegram 机器人与 **Fin** 对话（含 **存款/提款实时状态**）；人工可在 **同一 Intercom 对话** 接手，回复直接发回 Telegram。

**怎么做的 (CN):**
- Telegram Bot API webhook → Worker `/telegram/webhook`（密钥校验）。
- 入站消息 **立即应答** 并后台处理，避免 Telegram 超时/重试；按 **`update_id` 去重**。
- 消息建/续该客户的 Intercom 对话；Fin 回复转发回去；人工回复经 Intercom webhook 转发。
- 支持命令：`/start`、`/reset`。

---

## Lark Integration / Lark 集成　—　✅ Done / 已完成

**What it does (EN):** Same model as Telegram, for **Lark**. Customers DM the Lark **"Ask Ada"** custom app; Fin answers (incl. live data); **two-way human handoff**; **clickable source links**; **multilingual**.

**How it's built (EN):**
- Lark custom app (bot) → Worker `/lark/webhook` (verification token checked).
- Required scope **`im:message.p2p_msg`** so direct messages reach us; subscribed to event `im.message.receive_v1`.
- Same **ack-fast + de-dupe (`event_id`) + background processing** as Telegram (Lark retries aggressively otherwise).
- Sends as the bot via a Lark **tenant access token**; bot credentials are swappable via config (already migrated to the new account).

**做什么 (CN):** 与 Telegram 同一套机制，用于 **Lark**。客户私聊 Lark **"Ask Ada"** 自定义应用；Fin 回答（含实时数据）；**双向人工接管**；**链接可点击**；**多语言**。

**怎么做的 (CN):**
- Lark 自定义应用（机器人）→ Worker `/lark/webhook`（校验 verification token）。
- 必需权限 **`im:message.p2p_msg`** 才能收到私聊；订阅事件 `im.message.receive_v1`。
- 与 Telegram 相同的 **立即应答 + 去重（`event_id`）+ 后台处理**（否则 Lark 会频繁重发）。
- 用 Lark **tenant access token** 以机器人身份发送；机器人凭证可经配置切换（已迁移到新账号）。

---

## Fin AI Handling & Workflow / Fin AI 处理与工作流　—　✅ Done / 已完成

**What it does (EN):** Fin AI **automatically answers** customers inside the Intercom conversation using your knowledge base, and **escalates to a human** when asked.

**How it's built (EN):**
- An Intercom **Workflow**: trigger *"Customer sends their first message"* → audience by `source_channel` (lark/telegram) → action **"Let Fin handle"** (answers from content, asks for details before handover, escalates on request).
- Each customer reuses **one open conversation**; the Workflow runs Fin inside it; a new conversation opens only after close/`reset`.
- Fin's replies are bot-authored, which **don't fire a webhook**, so the Worker **polls** the conversation and relays Fin's answer to the channel — the poll waits for Fin's full, multi-step reply (ack → lookup → answer).

**做什么 (CN):** Fin AI 在 Intercom 对话里用知识库 **自动回答** 客户，客户要求时 **升级人工**。

**怎么做的 (CN):**
- Intercom **工作流**：触发"**客户发出第一条消息**"→受众按 `source_channel`（lark/telegram）→动作 **"让 Fin 处理"**（用内容回答、交接前先追问、按需升级）。
- 每位客户复用 **一条** 打开的对话；工作流在其中运行 Fin；仅在关闭/`reset` 后才开新对话。
- Fin 回复为机器人身份，**不触发 webhook**，因此 Worker **轮询** 对话并把 Fin 回答转发到渠道 —— 轮询会等待 Fin 多步骤的完整回答（稍等→查询→正式回答）。

---

## Live Data Lookups — Data Connectors / 实时数据查询　—　✅ Done / 已完成

**What it does (EN):** Fin can look up a customer's **real-time deposit and withdrawal status** (and KYC) and answer with the status + ETA — **safely**.

**How it's built (EN):**
- Intercom **Data Connectors** call the Worker's data API: `/api/deposit`, `/api/withdrawal` (and `/api/kyc`), authenticated with a Bearer token.
- Fin **collects the IDs from the customer** (member ID + deposit/withdrawal ID), then calls the connector.
- The gateway **masks** sensitive fields (e.g. card → `****8821`) and maps internal codes to **customer-safe wording** — internal codes / risk scores **never leave**.
- Data is **mocked for the demo**; the production swap is isolated to the gateway (the contract to Fin stays the same).

**做什么 (CN):** Fin 可查客户的 **实时存款、提款状态**（及 KYC），并 **安全地** 用状态 + 预计时间回答。

**怎么做的 (CN):**
- Intercom **Data Connector** 调用 Worker 数据接口：`/api/deposit`、`/api/withdrawal`（及 `/api/kyc`），用 Bearer 令牌鉴权。
- Fin 先 **向客户索取单号**（会员ID + 存款/提款单号），再调用接口。
- 网关对敏感字段 **脱敏**（如卡号→`****8821`），把内部代码转成 **对客安全话术** —— 内部代码/风控分 **绝不外泄**。
- 演示为 **mock 数据**；上线只需替换网关（对 Fin 契约不变）。

---

## Human Handoff / 人工接管　—　✅ Done / 已完成

**What it does (EN):** A human agent can take over and chat with the customer; messages flow **both ways**, all **in the same thread**.

**How it's built (EN):**
- On customer request, Fin hands over and the Intercom conversation is **assigned to the team** (Ask Ada).
- Agent replies in Intercom → relayed to the customer's channel (prefixed **👤**) via the standard webhook (`conversation.admin.replied`, **HMAC-verified**).
- The customer's further messages relay into the **same** conversation; **de-duplication** prevents repeats; **no separate/mirror conversation** is created.

**做什么 (CN):** 人工可接手并与客户聊天；消息 **双向** 流转，全部在 **同一对话**。

**怎么做的 (CN):**
- 客户要求时 Fin 交接，Intercom 对话 **分配给团队**（Ask Ada）。
- 客服在 Intercom 的回复 → 经标准 webhook（`conversation.admin.replied`，**HMAC 验签**）转发到客户渠道（前缀 **👤**）。
- 客户后续消息转发回 **同一对话**；**去重** 防重复；**不另建/镜像对话**。

---

## Multilingual / 多语言　—　✅ Done / 已完成

**What it does (EN):** Fin replies in the **customer's language** (e.g. Chinese question → Chinese answer).

**How it's built (EN):** Enabled in Intercom Fin's **language settings + auto-translation** of knowledge content; the backend relays whatever language Fin produces verbatim (no translation in our code).

**做什么 (CN):** Fin 用 **客户语言** 回答（如中文问→中文答）。

**怎么做的 (CN):** 在 Intercom Fin 的 **语言设置 + 自动翻译** 中开启知识库内容翻译；后端原样转发 Fin 产出的语言（我方代码不做翻译）。

---

### Tech stack at a glance / 技术栈一览
Cloudflare Workers + KV (TypeScript, Wrangler) · Intercom Conversations API + Workflows + Fin + Data Connectors · Lark Open Platform (custom app) · Telegram Bot API · Web Crypto (HMAC signature verification).
