/**
 * Wire one agent process from env + state. This is the only place that decides
 * which optional pieces exist (Inkbox, computer, apps, network) based on what is
 * configured. Everything it builds is returned so main.ts, the smoke test and
 * embedders can drive it the same way.
 */
import { resolve } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  AgentRuntime,
  A2AStore,
  ApprovalStore,
  AuditLog,
  ContactStore,
  MemoryStore,
  PolicyEngine,
  Scheduler,
  StateDir,
  ToolRegistry,
  AgentKeyring,
  CredentialIssuer,
  HabitStore,
  Identity,
  LocationService,
  OnePasswordClient,
  SecretBroker,
  SecurityLayer,
  StepUp,
  StepUpStore,
  ToolPins,
  Vault,
  defaultOpRunner,
  keyFromEnv,
  securityTools,
  MemorySearch,
  PlaceStore,
  PreferenceStore,
  TriggerEngine,
  TriggerPrefs,
  triggerTools,
  TRIGGERS_SCAN_TASK,
  TRIGGERS_SCHEDULE_ID,
  coreTools,
  inQuietHours,
  openAIEmbedder,
  proactiveTools,
  ensurePersona,
  loadConfig,
  ownerClaimStatus,
  saveConfig,
  syncInstructions,
  telegramIdsFromEnv,
  loadPolicy,
  pickLanguage,
  resolveDataDir,
  resolveModel,
  resolveTriggers,
  scanCron,
} from "@orion-ai/core";
import type { InboundMessage, InstinctConfig, Outbox, Principal, RegisteredTool } from "@orion-ai/core";
import { CALL_ORIGINATIONS, DurableInbox, InkboxA2A, InkboxChannel, InkboxInboundHydrator, InkboxProvisioner, handleCallEnded, conciergeTools, messagingTools, sendFileTool, voiceInstructions } from "@orion-ai/inkbox";
import type { CallEndedEvent, CallOrigination } from "@orion-ai/inkbox";
import { enrichInbound, transcriberFromEnv } from "@orion-ai/media";
import { GatewayTelegramChannel, TelegramChannel } from "@orion-ai/telegram";
import { WhatsAppChannel } from "@orion-ai/whatsapp";
import { computerGuidance, detectComputer } from "@orion-ai/computer";
import type { ComputerBackend } from "@orion-ai/computer";
import { ComposioApps, ComposioTriggerSource, DEFAULT_TOOLKITS, OPENAI_COMPLETIONS_TOOL_LIMIT, appsGuidance, appsTools, composioModeFor } from "@orion-ai/apps";
import { ampleTools, type AmpleCredentials } from "@orion-ai/ample";
import { AtomicMailBackend, atomicMailGuidance } from "@orion-ai/atomicmail";
import { contextTools } from "@orion-ai/context";
import { keenableTools } from "@orion-ai/keenable";
import { networkTools, PartnerRegistry, partnerTools, e2eeA2aTools } from "@orion-ai/network";
import { ChatAwareOutbox, ConsoleOutbox, type ChatReplyBuffer } from "./console-outbox.js";
import { fileTools, resolveInsideWorkspace } from "./file-tools.js";
import { makeDescribeDataPart, promptExtraFor } from "./hooks.js";
import { appsNotConfiguredTool, setupSummaryFor } from "./setup-summary.js";
import { createScheduleSync, type ScheduleSync } from "./maritime-schedules.js";
import { CustomModelStore, createFailoverStreamFn } from "./custom-model.js";
import { createOwnerApi } from "./owner-api.js";
import { createPages } from "./pages.js";
import { egpEnabled, loadPaymentsModule, paymentsEnv, type EgpRailLike, type LinkWalletLike, type PaymentsModule } from "./payments.js";
import { createSkillCatalog, formatSkillsIndex, loadSkillTool, ownerSkillsDir, resolveSkillsDir, skillsFor } from "./skills.js";

/** How often the skill folders are re-read; an owner-installed skill shows up within this. */
const SKILLS_REFRESH_MS = 30_000;
import { ChannelRouter, telegramEnabled, whatsappEnabled } from "./whatsapp.js";

export interface BootOptions {
  streamFn?: StreamFn;
  model?: Model<any>;
  outbox?: Outbox;
  logger?: (m: string) => void;
  skillsDir?: string;
  /** Override for tests. Default: real fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests: the payments module to wire instead of importing @orion-ai/payments. */
  payments?: PaymentsModule;
}

export interface BootResult {
  runtime: AgentRuntime;
  customModel?: CustomModelStore;
  ownerApi?: import("./owner-api.js").OwnerApi;
  state: StateDir;
  config: InstinctConfig;
  scheduler: Scheduler;
  outbox: Outbox;
  close(): Promise<void>;
  computerKind?: string;
  apps?: ComposioApps;
  /** Toolkits Composio reports as connected at boot, for the status page. */
  appsConnected?: string[];
  startedAt: number;
  modelSpec: string;
  /** Finished chat replies waiting for the next /chat on their conversation. */
  chatBuffer: ChatReplyBuffer;
  /** Set when LINK_CLIENT_ID, LINK_CLIENT_SECRET and STRIPE_PUBLISHABLE_KEY are present and the package is installed. */
  wallet?: LinkWalletLike;
  /** Complete compact Inkbox events before handing them to the runtime. */
  hydrateInbound?: (message: InboundMessage) => Promise<InboundMessage>;
  /** Voice notes to text and documents to readable text (used by POST /voice). */
  enrichInbound?: (message: InboundMessage) => Promise<InboundMessage>;
  /** Set with Inkbox: text the owner the outcome of a finished phone call. */
  onCallEnded?: (event: CallEndedEvent) => Promise<void>;
  /** Set when this agent runs its own Telegram bot: the gateway's shared bot is then ignored. */
  telegramOwnBot?: boolean;
  /** Set when that happens while a gateway is configured too: points the person to the agent's own bot. */
  onGatewayTelegram?: (kind: "message" | "link", telegramId: string) => void;
}

/**
 * An agent with a bot of its own that is also linked to a gateway: someone who writes to the shared bot
 * gets one short note saying where the agent really is, instead of silence. At most one per chat per hour,
 * and it goes through the gateway's own agent API, so it can only reach the chat that was linked.
 */
export class GatewayNotices {
  private readonly last = new Map<string, number>();
  constructor(
    private readonly own: { username(): string | undefined },
    private readonly via: { send(msg: { channel: "telegram"; conversationKey: string; text: string }): Promise<void> },
    private readonly log: (m: string) => void,
    private readonly now: () => number = Date.now,
    private readonly everyMs = 60 * 60_000,
  ) {}

  notify(telegramId: string): void {
    const t = this.now();
    const prev = this.last.get(telegramId);
    if (prev !== undefined && t - prev < this.everyMs) return;
    this.last.set(telegramId, t);
    if (this.last.size > 500) this.last.delete(this.last.keys().next().value as string);
    const bot = this.own.username();
    const where = bot ? `@${bot}` : "its own Telegram bot";
    const text = `This agent has its own Telegram bot and does not answer through this shared bot. Please message it there: ${where}.\nهذا الوكيل له بوت تيليجرام خاص به ولا يرد من خلال هذا البوت. تحدّث معه هناك: ${bot ? where : "بوته الخاص"}.`;
    void this.via.send({ channel: "telegram", conversationKey: `telegram:${telegramId}`, text }).catch((err: Error) => this.log(`telegram: could not send the own-bot note through the gateway: ${err.message}`));
  }
}

export const DEFAULT_MARITIME_MCP_URL = "https://mcp.maritime.sh";

export async function boot(env: NodeJS.ProcessEnv, opts: BootOptions = {}): Promise<BootResult> {
  const log = opts.logger ?? ((m: string) => console.log(`[instinct] ${m}`));
  const startedAt = Date.now();

  const state = new StateDir(resolveDataDir(env));
  state.ensure();
  const config = loadConfig(state, env);
  // config.json wins over the environment, so an existing agent only learns its owner's Telegram
  // id from TELEGRAM_OWNER_ID while it has none. Changing owners later means editing config.json.
  const seededTelegramIds = telegramIdsFromEnv(env);
  if (seededTelegramIds.length > 0 && (config.owner.telegramIds ?? []).length === 0) {
    config.owner.telegramIds = seededTelegramIds;
    saveConfig(state, config);
    log(`owner Telegram id set from TELEGRAM_OWNER_ID (${seededTelegramIds.length})`);
  }
  if (config.owner.claimOnFirstContact && config.owner.phones.length === 0 && (config.owner.telegramIds ?? []).length === 0) {
    const claim = ownerClaimStatus(config);
    log(claim.enabled
      ? `owner claim open: the first 1:1 iMessage/SMS (or Telegram /start <code>) carrying the one-time code becomes the owner${config.owner.claimExpiresAt ? ` (until ${config.owner.claimExpiresAt})` : ""}`
      : `WARNING: owner claim is disabled: ${claim.reason}. Nobody can claim this agent until a valid code is set`);
  }
  // PERSONA.md is the owner's file; INSTINCT_PERSONA seeds it on first boot only.
  if (ensurePersona(state, env.INSTINCT_PERSONA)) log(`wrote ${state.path("PERSONA.md")}${env.INSTINCT_PERSONA?.trim() ? " from INSTINCT_PERSONA" : " (default persona)"}`);
  // AGENTS.md is the owner's standing-instructions file. INSTINCT_INSTRUCTIONS seeds it, and a changed seed
  // replaces it as long as the owner never edited the file; an edited file is theirs.
  const instructions = syncInstructions(state, env.INSTINCT_INSTRUCTIONS);
  if (instructions === "created" || instructions === "updated") log(`${instructions} ${state.path("AGENTS.md")} from INSTINCT_INSTRUCTIONS`);

  const audit = new AuditLog(state);
  const policy = new PolicyEngine(loadPolicy(state), {
    spentTodayUsd: () => audit.spentTodayUsd(config.owner.timezone),
  });
  const approvals = new ApprovalStore(state);
  const scheduler = new Scheduler(state);
  const contacts = new ContactStore(state, { warn: log });
  const memory = new MemoryStore(state);
  // Phase B: habits (B2), memory search (B3), booking preferences (B4), places (B5).
  const triggersConfig = resolveTriggers(config.triggers, env);
  const habits = new HabitStore(state, config.owner.timezone);
  /** Quiet hours now: the owner's learned sleep window once there is enough data, else the configured one. */
  const quietWindow = (): { from: string; to: string } => {
    const learned = habits.sleepWindow();
    return learned.confident ? { from: learned.from, to: learned.to } : { from: triggersConfig.quietFrom, to: triggersConfig.quietTo };
  };
  const triggerPrefs = new TriggerPrefs(state);
  const embedKey = env.EMBED_API_KEY || env.OPENAI_API_KEY;
  // Meaning search sends memory text to the embeddings service, so it needs an explicit opt-in.
  const embedder = env.INSTINCT_SEMANTIC_MEMORY === "1" && embedKey ? openAIEmbedder({ apiKey: embedKey, ...(env.EMBED_BASE_URL ? { baseUrl: env.EMBED_BASE_URL } : {}), ...(env.EMBED_MODEL ? { model: env.EMBED_MODEL } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }) : undefined;
  const places = env.INSTINCT_LOCATION === "1" ? new PlaceStore(state) : undefined;
  const a2aStore = new A2AStore(state);

  const model = opts.model ?? resolveModel(config.model.primary, env);
  const modelSpec = `${model.provider}/${model.id}`;

  const inkbox = inkboxSettings(env, config);
  const a2a = inkbox ? new InkboxA2A({
    apiKey: inkbox.apiKey,
    handle: inkbox.handle,
    ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }) : undefined;
  const externalUserId = inkbox?.handle ?? config.agent.handle ?? "owner";

  // Outbox: Inkbox when configured, else console. A caller-supplied outbox wins (tests).
  // Whatever the transport, `chat` replies are buffered for the HTTP layer: that channel
  // is the dashboard or CLI waiting on a response, not a wire Inkbox can deliver on.
  let channel: InkboxChannel | undefined;
  let outbox: Outbox;
  let chatBuffer: ChatReplyBuffer;
  if (opts.outbox) {
    if (opts.outbox instanceof InkboxChannel) channel = opts.outbox;
    const wrapped = new ChatAwareOutbox(opts.outbox);
    outbox = wrapped;
    chatBuffer = wrapped.chat;
  } else if (inkbox) {
    channel = new InkboxChannel({
      apiKey: inkbox.apiKey,
      handle: inkbox.handle,
      identityId: inkbox.identityId,
      ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const wrapped = new ChatAwareOutbox(channel);
    outbox = wrapped;
    chatBuffer = wrapped.chat;
  } else {
    const console_ = new ConsoleOutbox({ logger: log });
    outbox = console_;
    chatBuffer = console_.chat;
    log("Inkbox not configured: replies go to the console outbox");
  }

  // WhatsApp: the agent's own account as a linked device. Replies on the whatsapp channel go
  // through it; everything else keeps the transport above. It starts once the runtime exists.
  let whatsappInbox: DurableInbox<InboundMessage> | undefined;
  const whatsapp = whatsappEnabled(env)
    ? new WhatsAppChannel({
        authDir: state.path("secrets", "whatsapp"),
        mediaDir: state.path("workspace", "inbound"),
        ...(env.WHATSAPP_PHONE?.trim() ? { phone: env.WHATSAPP_PHONE.trim() } : {}),
        onInbound: (message) => void whatsappInbox?.enqueue(message.id, message),
        logger: log,
      })
    : undefined;

  // Telegram: a bot (TELEGRAM_BOT_TOKEN from @BotFather), long polling, private chats only.
  let telegramInbox: DurableInbox<InboundMessage> | undefined;
  const telegram = telegramEnabled(env)
    ? new TelegramChannel({
        token: (env.TELEGRAM_BOT_TOKEN as string).trim(),
        mediaDir: state.path("workspace", "inbound"),
        offsetFile: state.path("secrets", "telegram", "offset.json"),
        groups: env.TELEGRAM_GROUPS?.trim() === "1",
        onInbound: (message) => {
          if (!telegramInbox) throw new Error("Telegram inbox is not ready");
          telegramInbox.enqueue(message.id, message);
        },
        logger: log,
      })
    : undefined;
  // Behind a shared front door the gateway owns the bot; this agent reaches Telegram through it.
  const remoteTelegram = !telegram && env.TELEGRAM_GATEWAY_URL?.trim() && env.TELEGRAM_GATEWAY_TOKEN?.trim()
    ? new GatewayTelegramChannel({
        gatewayUrl: env.TELEGRAM_GATEWAY_URL.trim(),
        token: env.TELEGRAM_GATEWAY_TOKEN.trim(),
        mediaDir: state.path("workspace", "inbound"),
        logger: log,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
    : undefined;
  if (remoteTelegram) log("telegram: through the gateway (the bot belongs to the front door)");
  const telegramOut = telegram ?? remoteTelegram;
  // Both a bot of its own and a gateway: the own bot wins, and it is said out loud (once at boot, and to the
  // person if they use the shared bot). Set TELEGRAM_ENABLED=0 to prefer the gateway's bot instead.
  const gatewayConfigured = Boolean(env.TELEGRAM_GATEWAY_URL?.trim() && env.TELEGRAM_GATEWAY_TOKEN?.trim());
  const ownBotWithGateway = Boolean(telegram) && gatewayConfigured;
  if (ownBotWithGateway) log("telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_GATEWAY_* are both set; this agent uses its own bot and ignores the gateway's shared bot (set TELEGRAM_ENABLED=0 to use the shared bot instead)");
  const gatewayNotices = ownBotWithGateway ? new GatewayNotices(telegram!, new GatewayTelegramChannel({ gatewayUrl: env.TELEGRAM_GATEWAY_URL!.trim(), token: env.TELEGRAM_GATEWAY_TOKEN!.trim(), mediaDir: state.path("workspace", "inbound"), logger: log, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }), log) : undefined;
  if (whatsapp || telegramOut) outbox = new ChannelRouter(outbox, { ...(whatsapp ? { whatsapp } : {}), ...(telegramOut ? { telegram: telegramOut } : {}) });

  const registry = new ToolRegistry();
  const promptSections: string[] = [];

  registry.registerMany(
    coreTools({
      state,
      memory,
      scheduler,
      approvals,
      audit,
      config,
      outbox,
      workspaceDir: state.path("workspace"),
      onApprovalSettled: (approval, approved) => runtime.afterApproval(approval, approved),
      // Image generation rides on an OpenAI-compatible key: a dedicated IMAGE_API_KEY, else the model key
      // (an OpenAI-compatible proxy that forwards /images/generations works too). The shell never sees either.
      ...(env.IMAGE_API_KEY || env.OPENAI_API_KEY
        ? {
            images: {
              apiKey: (env.IMAGE_API_KEY || env.OPENAI_API_KEY) as string,
              ...(env.IMAGE_BASE_URL || env.OPENAI_BASE_URL ? { baseUrl: env.IMAGE_BASE_URL || env.OPENAI_BASE_URL } : {}),
              ...(env.IMAGE_MODEL ? { model: env.IMAGE_MODEL } : {}),
            },
          }
        : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(env.BRAVE_SEARCH_API_KEY ? { searchApiKey: env.BRAVE_SEARCH_API_KEY } : {}),
      // Opt-in: YDC_API_KEY, or YOU_SEARCH=1 for the keyless tier. Unset keeps Brave or DuckDuckGo.
      ...(env.YDC_API_KEY || env.YOU_SEARCH === "1" ? { youSearch: env.YDC_API_KEY ? { apiKey: env.YDC_API_KEY } : {} } : {}),
    }),
  );
  if (triggersConfig.enabled) registry.registerMany(triggerTools(triggerPrefs));
  registry.registerMany(proactiveTools({ search: new MemorySearch(state, memory, embedder), prefs: new PreferenceStore(state), ...(places ? { places } : {}) }));
  const locationService = places ? new LocationService(places, (text) => runtime.notifyOwner(text, "location")) : undefined;

  if (env.CONTEXT_DEV_API_KEY) {
    registry.registerMany(
      contextTools({
        apiKey: env.CONTEXT_DEV_API_KEY,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
  }

  // Keenable works without a key, so it needs its own switch; a key also turns it on.
  // The switch takes what the gateway takes (1, true, yes): `instinct deploy` forwards it as written.
  if (/^(1|true|yes)$/i.test(env.KEENABLE_SEARCH?.trim() ?? "") || env.KEENABLE_API_KEY) {
    registry.registerMany(
      keenableTools({
        ...(env.KEENABLE_API_KEY ? { apiKey: env.KEENABLE_API_KEY } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
  }

  // Messaging needs Inkbox. send_file does not: without a wire it still hands files
  // to the dashboard chat, which is how `instinct chat` and the smoke test get them.
  const callOrigination = callOriginationFrom(env);
  // send_file attaches files on Telegram and WhatsApp conversations through these.
  const fileChannels: NonNullable<Parameters<typeof sendFileTool>[0]["fileChannels"]> = { ...(telegramOut ? { telegram: telegramOut } : {}), ...(whatsapp ? { whatsapp } : {}) };
  if (channel) registry.registerMany(messagingTools({ channel, contacts, config, dataDir: state.root, fileChannels, ...(callOrigination ? { callOrigination } : {}) }));
  // Concierge calls: standing mandate set by the owner (E6). phone_call above still asks every time.
  if (channel) registry.registerMany(conciergeTools({ channel, config, audit, state, ...(callOrigination ? { callOrigination } : {}) }));
  else registry.register(sendFileTool({ contacts, config, dataDir: state.root, fileChannels }));
  // Voice AI speaks as the owner's assistant. Only a chosen voice (INKBOX_VOICE or config.json agent.voice)
  // triggers the write: the config is a full replace on Inkbox, and an unset voice keeps the org default.
  const voice = env.INKBOX_VOICE?.trim() || config.agent.voice?.trim();
  if (channel && voice) {
    const ch = channel;
    const set = await safely(log, "phone voice", async () => {
      await ch.setVoiceConfig({ voice, instructions: voiceInstructions(config.owner.name) });
      return true;
    });
    if (set) log(`phone voice: ${voice}`);
  }
  // Voice notes become text and documents become readable, whatever channel they came in on.
  const transcriber = transcriberFromEnv(env, opts.fetchImpl);
  const enrich = (message: InboundMessage): Promise<InboundMessage> =>
    enrichInbound(message, { inboundDir: state.path("workspace", "inbound"), ...(transcriber ? { transcriber } : {}), logger: log }).catch(() => message);
  log(transcriber ? "speech-to-text: on (voice notes are transcribed)" : "speech-to-text: off (set STT_API_KEY or OPENAI_API_KEY to read voice notes)");
  const hydrator = channel ? new InkboxInboundHydrator({
    channel,
    mediaDir: state.path("workspace", "inbound"),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }) : undefined;

  registry.registerMany(fileTools(state.path("workspace"), { env }));

  // Web app deploys through Ample: with the deployer's credential, or with an
  // account this agent signs up for itself on the first deploy (AMPLE_SIGNUP=1),
  // which is how every person behind a shared gateway gets an account of their own.
  const ample = ampleCredentials(env);
  const ampleSignup = !ample && env.AMPLE_SIGNUP === "1";
  if (ample || ampleSignup) {
    const workspace = state.path("workspace");
    const ownerEmail = config.owner.emails[0];
    registry.registerMany(
      ampleTools({
        ...(ample
          ? { credentials: ample }
          : {
              signup: {
                file: state.path("secrets", "ample.json"),
                name: `orion-ai-${config.agent.handle ?? "agent"}`,
                ...(ownerEmail ? { ownerEmail } : {}),
              },
            }),
        workspaceDir: workspace,
        resolvePath: (requested) => resolveInsideWorkspace(workspace, requested),
        env,
        ...(env.AMPLE_API_URL ? { apiUrl: env.AMPLE_API_URL } : {}),
        ...(env.AMPLE_BIN ? { bin: env.AMPLE_BIN } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
    log(`ample: web app deploys on (${ample ? "shared credential" : "own account on first deploy"})`);
  }

  // Computer: in-VM desktopd, hosted Maritime Computers MCP, or nothing.
  const computer = await safely(log, "computer", () =>
    detectComputer({
      mode: config.computer.mode,
      desktopdUrl: config.computer.desktopdUrl,
      maritimeMcpUrl: config.computer.maritimeMcpUrl ?? env.MARITIME_COMPUTERS_MCP_URL ?? DEFAULT_MARITIME_MCP_URL,
      maritimeApiKey: env.MARITIME_API_KEY,
      externalUserId,
      // Maritime starts the desktop stack in the background; desktopd may still be coming up.
      expectDesktopd: env.MARITIME_DESKTOP === "1",
      ...(env.MARITIME_AGENT_ID ? { agentId: env.MARITIME_AGENT_ID } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    }),
  );
  if (computer) {
    const tools = await safely(log, "computer tools", () => computer.tools());
    if (tools && tools.length > 0) {
      registry.registerMany(tools);
      promptSections.push(computerGuidance());
      log(`computer: ${computer.describe()}`);
    }
  }

  // Apps through Composio, when the deployer gave us a key. The key is the switch:
  // config.apps.enabled only records that a toolkit list was seeded. A list of
  // `all` (or `*`) drops the allowlist so any app can be connected by name.
  let apps: ComposioApps | undefined;
  let appsConnected: string[] | undefined;
  if (env.COMPOSIO_API_KEY) {
    const toolkits = config.apps.toolkits.length > 0 ? config.apps.toolkits : DEFAULT_TOOLKITS;
    // Direct mode lists one tool per app action; router mode lists Composio's meta tools only.
    // OpenAI-style chat completions (the Maritime LLM proxy) cap a request at 128 tools.
    const { mode, reason } = composioModeFor(env, model.api);
    const composio = new ComposioApps({ apiKey: env.COMPOSIO_API_KEY, userId: externalUserId, toolkits, mode, state, logger: log });
    log(`apps: composio ${composio.mode} mode (${composio.allToolkits ? "all toolkits always use router" : reason})`);
    const connected = await safely(log, "apps", async () => {
      await composio.connect();
      const tools = await composio.tools();
      const status = await composio.connectedToolkits();
      return { tools, status };
    });
    if (connected) {
      apps = composio;
      registry.registerMany(connected.tools);
      registry.registerMany(appsTools({ apps: composio }));
      const on = connected.status.filter((s: ToolkitStatus) => s.connected).map((s: ToolkitStatus) => s.slug);
      const missing = connected.status.filter((s: ToolkitStatus) => !s.connected).map((s: ToolkitStatus) => s.slug);
      appsConnected = on;
      promptSections.push(appsGuidance(on, missing, { anyApp: composio.allToolkits, unavailable: composio.unavailableToolkits }));
      log(`apps: ${connected.tools.length} tools${composio.allToolkits ? " (any app by name)" : ""}, connected: ${on.join(", ") || "none"}`);
    }
  }
  // Atomic Mail: an inbox of the agent's own, when the deployer gave us a key. The key is
  // the switch. With it unset nothing here runs and nothing else changes.
  let mailbox: AtomicMailBackend | undefined;
  if (env.ATOMIC_MAIL_API_KEY) {
    const backend = new AtomicMailBackend({
      apiKey: env.ATOMIC_MAIL_API_KEY,
      ...(env.ATOMIC_MAIL_MCP_URL ? { url: env.ATOMIC_MAIL_MCP_URL } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    });
    const connected = await safely(log, "atomicmail", async () => ({ tools: await backend.tools(), address: await backend.address() }));
    if (connected && connected.tools.length > 0) {
      mailbox = backend;
      registry.registerMany(connected.tools);
      promptSections.push(atomicMailGuidance(connected.address));
      log(`atomicmail: ${connected.tools.length} tools${connected.address ? ` (${connected.address})` : ""}`);
    }
  }
  // No Composio key: the model still gets an apps_connect tool, so "connect my Gmail"
  // produces one precise sentence about what to set up instead of an invented screen.
  if (!apps) registry.register(appsNotConfiguredTool());

  // Trusted network: contacts, tiers, grants, A2A.
  registry.registerMany(
    networkTools({
      contacts,
      policy,
      config,
      audit,
      outbox,
      a2aStore,
      ...(a2a ? { a2a } : {}),
      ...(env.INKBOX_ADMIN_API_KEY
        ? {
            provisioner: new InkboxProvisioner({
              adminApiKey: env.INKBOX_ADMIN_API_KEY,
              ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
              ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            }),
          }
        : {}),
    }),
  );

  // Payments: a Stripe Link agent wallet, when the Link OAuth client and Stripe key are set.
  let wallet: LinkWalletLike | undefined;
  const payments = paymentsEnv(env);
  if (payments) {
    const mod = opts.payments ?? (await loadPaymentsModule());
    if (!mod) {
      log("payments: LINK_* set but @orion-ai/payments is not installed; skipping");
    } else {
      const built = await safely(log, "payments", () => {
        const w = new mod.LinkWallet({
          state,
          clientId: payments.clientId,
          clientSecret: payments.clientSecret,
          publishableKey: payments.publishableKey,
          redirectUri: payments.redirectUri,
          ...(config.agent.handle ? { statePrefix: config.agent.handle } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        return { wallet: w, tools: mod.paymentsTools({ wallet: w, outbox, config, audit, state }) };
      });
      if (built) {
        wallet = built.wallet;
        registry.registerMany(built.tools);
        log(`payments: Link wallet ${wallet.isConnected() ? "connected" : "not connected yet"}, callback ${payments.redirectUri}`);
      }
    }
  }

  // Egyptian pounds: a budgeted, owner-approved card rail (Vodafone Cash temporary cards), opt-in with EGP_WALLET=1.
  // Independent of Stripe Link; both can run side by side.
  let egp: EgpRailLike | undefined;
  if (egpEnabled(env)) {
    const mod = opts.payments ?? (await loadPaymentsModule());
    if (!mod?.createEgpRail) {
      log("payments: EGP_WALLET=1 but this @orion-ai/payments build has no EGP rail; skipping");
    } else {
      const publicUrl = (env.INSTINCT_PUBLIC_URL?.trim() || `http://127.0.0.1:${env.PORT?.trim() || "8080"}`).replace(/\/+$/, "");
      const rail = await safely(log, "egp", () => mod.createEgpRail!({ state, outbox, config, audit, publicUrl }));
      if (rail) {
        egp = rail;
        registry.registerMany(rail.tools);
        log(`payments: EGP rail on, card page ${publicUrl}/egp/card/...`);
      }
    }
  }

  // Partner layer (E1 + E2): typed business requests and domain connectors. No partner is connected yet, so the
  // registry starts empty and the tools point to the web and phone fallback. A partner's adapter registers here.
  const partnerRegistry = new PartnerRegistry();
  registry.registerMany(partnerTools({ registry: partnerRegistry, config, audit, state }));

  // Shareable pages (E5): polls, sign-ups and RSVPs served by this agent. Opt-in with INSTINCT_PAGES=1.
  let pagesRail: ReturnType<typeof createPages> | undefined;
  if (env.INSTINCT_PAGES?.trim() === "1") {
    const publicUrl = env.INSTINCT_PUBLIC_URL?.trim() || `http://127.0.0.1:${env.PORT?.trim() || "8080"}`;
    pagesRail = createPages({ state, publicUrl });
    registry.registerMany(pagesRail.tools);
    log(`pages: on, ${publicUrl}/p/...`);
  }

  const skillsDir = resolveSkillsDir({ explicit: opts.skillsDir, env, packageUrl: import.meta.url });
  // The image's skills/ first, then the owner's <data>/skills. Skills are re-read every 30 s, so one
  // installed there after boot (a git clone, a SKILL.md the agent wrote) is in the index and loadable
  // by name on the next message. Built-ins win a name clash, and an owner skill is private (only the
  // owner sees or loads it) unless its frontmatter says `visibility: public`.
  const ownerDir = ownerSkillsDir(state.root);
  const skillCatalog = createSkillCatalog({
    builtinDirs: skillsDir && resolve(skillsDir) !== resolve(ownerDir) ? skillsDir : undefined,
    ownerDir,
    log,
    refreshMs: SKILLS_REFRESH_MS,
  });
  skillCatalog.list();
  // Registered even with no skill yet, and even when every skill is hidden: those load by name.
  registry.register(loadSkillTool(skillCatalog.list));
  const staticSections = promptSections.join("\n\n");
  // Built per conversation, so each principal's index lists only the skills they may load.
  const skillsPrompt = (principal: Principal) => {
    const parts = [staticSections, formatSkillsIndex(skillsFor(skillCatalog.list(), principal))].filter((p): p is string => Boolean(p && p.trim()));
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  };

  // Phase C (C1 to C8). The runtime hooks are on by default; INSTINCT_SECURITY=0 turns them off.
  const identity = Identity.load(state);
  const vaultKey = keyFromEnv(env);
  const vault = vaultKey || env.INSTINCT_VAULT_PASSPHRASE ? new Vault(state, { key: vaultKey, passphrase: env.INSTINCT_VAULT_PASSPHRASE }) : undefined;
  const stepUpStore = new StepUpStore(state);
  const stepUp = new StepUp({ secret: () => stepUpStore.secret() });
  const opVaults = (env.INSTINCT_OP_VAULTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const op = env.OP_SERVICE_ACCOUNT_TOKEN && opVaults.length > 0 ? new OnePasswordClient({ run: defaultOpRunner(env.OP_SERVICE_ACCOUNT_TOKEN), vaults: opVaults }) : undefined;
  const keyring = new AgentKeyring(state, identity);
  const pins = new ToolPins(state, identity);
  const quarantined = new Map<string, RegisteredTool>();
  const broker = new SecretBroker({ vault, op, issuer: new CredentialIssuer(identity) });
  // Only tools built to type into a page may be given {{secret:...}} references.
  const takesSecrets = new Set(["computer", "computer_batch", ...(env.INSTINCT_SECRET_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
  registry.registerMany(registry.all().filter((t) => takesSecrets.has(t.spec.name)).map((t) => ({ spec: { ...t.spec, meta: { ...t.spec.meta, acceptsSecrets: true } } })));
  registry.registerMany(securityTools({ audit, state, vault, stepUp, stepUpStore, op, keyring, pins, identity, registry, quarantined, issuer: "Orion AI", rewrap: (t) => (broker.available() ? broker.wrap(t) : t) }));
  // C5 on the wire: encrypted files and key exchange between agents over A2A (needs Inkbox A2A and a handle).
  registry.registerMany(e2eeA2aTools({ ...(a2a ? { a2a } : {}), keyring, contacts, audit, ...(inkbox ? { selfHandle: inkbox.handle } : {}), workspace: state.path("workspace") }));
  // C4: a tool whose description or schema changed since it was pinned is taken out of service until the owner accepts it.
  const pinCheck = pins.check(registry.all()); // watches tools from outside servers (Composio, MCP), not the agent's own
  for (const name of pinCheck.changed) {
    const tool = registry.get(name);
    if (tool) {
      quarantined.set(name, tool);
      registry.remove(name);
    }
    audit.append({ kind: "security", conversationKey: "security", principal: "system", detail: { tool: name, quarantined: true, reason: "changed since it was pinned" } });
  }
  if (pinCheck.changed.length > 0) log(`security: ${pinCheck.changed.length} tool(s) changed since they were pinned and are out of service: ${pinCheck.changed.join(", ")}`);
  if (broker.available()) for (const t of registry.all()) registry.register(broker.wrap(t));
  const security = env.INSTINCT_SECURITY === "0" ? undefined : new SecurityLayer({ broker, stepUp, groundingMode: env.INSTINCT_GROUNDING === "off" ? "off" : "note", memoryText: () => memory.readDurable() });

  // eslint-disable-next-line prefer-const
  let runtime: AgentRuntime;
  // Bring your own model, with automatic fallback to the default (see custom-model.ts). The dashboard hands the
  // key over with PUT /model; this wraps the stream so a failing key never breaks a turn.
  const customModel = new CustomModelStore(state.root);
  const webUrl = env.INSTINCT_WEB_URL?.trim().replace(/\/+$/, "");
  const webSecret = env.INSTINCT_WEB_SECRET?.trim();
  const failoverStream = createFailoverStreamFn(
    opts.streamFn ?? (streamSimple as StreamFn),
    customModel,
    {
      notifyOwner: (text) => runtime.notifyOwner(text, "model"),
      report: async (status, error) => {
        if (!webUrl || !webSecret) return;
        await (opts.fetchImpl ?? fetch)(`${webUrl}/api/agent/model-event`, { method: "POST", headers: { authorization: `Bearer ${webSecret}`, "content-type": "application/json" }, body: JSON.stringify({ status, ...(error ? { error } : {}) }), signal: AbortSignal.timeout(8000) });
      },
    },
    { log },
  );

  runtime = new AgentRuntime({
    ...(security ? { security } : {}),
    onOwnerActivity: (at) => habits.record(at),
    state,
    config,
    policy,
    approvals,
    audit,
    scheduler,
    contacts,
    memory,
    registry,
    model,
    outbox,
    a2aStore,
    ...(a2a ? { loadA2ATask: (taskId: string) => a2a.getTask(taskId) } : {}),
    skillsPrompt,
    streamFn: failoverStream,
    getApiKey: (provider: string) => apiKeyFor(provider, env),
    // Core cannot import the network package; the server bridges OIP and the network guidance.
    describeData: makeDescribeDataPart({ keyring, workspace: state.path("workspace") }),
    promptExtra: promptExtraFor,
    setupSummary: () =>
      setupSummaryFor({
        inkbox: inkbox ? { handle: inkbox.handle } : undefined,
        computerKind: computer?.kind,
        apps: apps ? { connected: appsConnected ?? [], anyApp: apps.allToolkits, toolkits: apps.toolkitSlugs } : undefined,
        wallet: wallet ? { connected: wallet.isConnected() } : undefined,
      }),
    ...(env.INSTINCT_REPLY_BUDGET_MS ? { replyBudgetMs: Number(env.INSTINCT_REPLY_BUDGET_MS) } : {}),
  });

  // Proactive triggers (B1). Off unless the owner turned them on and a Composio session exists,
  // because they read mail and calendar. The scan is a schedule entry so Maritime's GET /schedules
  // wakes a sleeping VM; the entry runs code, not a prompt.
  let triggerEngine: TriggerEngine | undefined;
  if (triggersConfig.enabled && apps) {
    const composio = apps;
    triggerEngine = new TriggerEngine({
      source: new ComposioTriggerSource({ execute: (slug, args) => composio.execute(slug, args) }, { mail: composio.allToolkits || composio.toolkitSlugs.includes("gmail") }),
      state,
      audit,
      config: triggersConfig,
      timezone: config.owner.timezone,
      language: () => pickLanguage(config.owner, undefined),
      prefs: triggerPrefs,
      quiet: quietWindow,
      send: (text) => runtime.notifyOwner(text, "triggers"),
    });
    scheduler.ensureSystem({ id: TRIGGERS_SCHEDULE_ID, name: "Proactive triggers", cron: scanCron(triggersConfig.intervalMinutes), tz: config.owner.timezone, prompt: "(internal) scan mail and calendar for things to tell the owner", task: TRIGGERS_SCAN_TASK });
    log(`triggers: on, scan every ${triggersConfig.intervalMinutes} min, quiet ${triggersConfig.quietFrom}-${triggersConfig.quietTo}`);
  } else {
    if (triggersConfig.enabled) log("triggers: enabled but no Composio apps connected; staying off");
    scheduler.delete(TRIGGERS_SCHEDULE_ID);
  }
  const stopScheduler = scheduler.start(async (entry) => {
    if (entry.task === TRIGGERS_SCAN_TASK) {
      if (triggerEngine) await triggerEngine.run();
      return;
    }
    await runtime.runScheduled(entry);
  }, 30_000, (entry, now) => {
    if (entry.waitForWake !== true) return false;
    const w = quietWindow();
    return inQuietHours(now, entry.tz ?? config.owner.timezone, w.from, w.to);
  });

  if (whatsapp) {
    // Persisted before handling, like Inkbox webhooks, so a restart mid-reply does not lose a message.
    whatsappInbox = new DurableInbox<InboundMessage>({
      file: state.path("whatsapp-inbox.json"),
      handle: async (message) => {
        await runtime.handleInbound(await enrich(message), { waitForCompletion: true });
      },
      onError: (id, status) => log(`WhatsApp message ${id}: ${status}`),
    });
    // Without start() the inbox persists every message and never hands one to the runtime.
    // Starting it also picks up messages saved before a restart.
    whatsappInbox.start();
    await safely(log, "whatsapp", () => whatsapp.start());
  }

  if (telegram) {
    telegramInbox = new DurableInbox<InboundMessage>({
      file: state.path("telegram-inbox.json"),
      handle: async (message) => {
        await runtime.handleInbound(await enrich(message), { waitForCompletion: true });
      },
      onError: (id, status) => log(`Telegram message ${id}: ${status}`),
    });
    telegramInbox.start();
    await safely(log, "telegram", () => telegram.start());
  }

  let sync: ScheduleSync | undefined;
  if (env.MARITIME_BACKEND_URL && env.MARITIME_INTERNAL_TOKEN && env.MARITIME_AGENT_ID) {
    sync = createScheduleSync({
      backendUrl: env.MARITIME_BACKEND_URL,
      token: env.MARITIME_INTERNAL_TOKEN,
      agentId: env.MARITIME_AGENT_ID,
      read: () => scheduler.toMaritimeSchedules(),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    });
    await sync.push(true);
    sync.start();
  }

  const toolCount = registry.all().length;
  if (model.api === "openai-completions" && toolCount > OPENAI_COMPLETIONS_TOOL_LIMIT) {
    log(
      `warning: ${toolCount} tools registered, but ${modelSpec} accepts at most ${OPENAI_COMPLETIONS_TOOL_LIMIT} per request, ` +
        "so owner replies will fail. Set COMPOSIO_MODE=router or shorten COMPOSIO_TOOLKITS.",
    );
  }
  log(`agent "${config.agent.name}" ready: model ${modelSpec}, ${toolCount} tools, data ${state.root}`);

  return {
    runtime,
    state,
    config,
    scheduler,
    outbox,
    computerKind: computer?.kind,
    apps,
    appsConnected,
    startedAt,
    modelSpec,
    chatBuffer,
    ...(locationService ? { location: locationService } : {}),
    ...(wallet ? { wallet } : {}),
    ...(egp ? { egp } : {}),
    customModel,
    ownerApi: createOwnerApi({
      config,
      env,
      state,
      contacts,
      approvals,
      audit,
      scheduler,
      memory,
      apps,
      wallet,
      egpStatus: egp?.status ? () => egp!.status!() : undefined,
      pagesSummary: pagesRail ? () => pagesRail!.summary() : undefined,
      keyring,
      vaultConfigured: Boolean(vault),
      skillsDir,
      channels: { inkboxHandle: inkbox?.handle, telegram: Boolean(telegram), whatsapp: Boolean(whatsapp) },
      customModel,
    }),
    ...(pagesRail ? { pages: pagesRail } : {}),
    ...(telegram ? { telegramOwnBot: true } : {}),
    ...(gatewayNotices ? { onGatewayTelegram: (_kind: "message" | "link", telegramId: string) => gatewayNotices.notify(telegramId) } : {}),
    enrichInbound: enrich,
    hydrateInbound: async (message: InboundMessage) => {
      // A file sent through the gateway is fetched now; Inkbox attachments are downloaded by their own hydrator.
      const hydrated = message.channel === "telegram" && remoteTelegram ? await remoteTelegram.hydrate(message) : hydrator ? await hydrator.hydrate(message) : message;
      return enrich(hydrated);
    },
    ...(channel ? { onCallEnded: callReporter(channel, (text, key) => runtime.relayToOwner(text, key), log) } : {}),
    async close() {
      stopScheduler();
      await safely(log, "whatsapp close", async () => {
        await whatsapp?.stop();
        await whatsappInbox?.close();
      });
      await safely(log, "telegram close", async () => {
        await telegram?.stop();
        await telegramInbox?.close();
      });
      sync?.stop();
      await safely(log, "computer close", () => computer?.close());
      await safely(log, "apps close", () => apps?.close());
      await safely(log, "atomicmail close", () => mailbox?.close());
    },
  };
}

interface ToolkitStatus {
  slug: string;
  connected: boolean;
}

/** Env variable per Pi provider id. Anything not listed falls back to <PROVIDER>_API_KEY. */
export const PROVIDER_KEY_ENV: Record<string, string[]> = {
  "anthropic": ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  "openai": ["OPENAI_API_KEY"],
  "openai-compatible": ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  "google": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-gemini-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "groq": ["GROQ_API_KEY"],
  "mistral": ["MISTRAL_API_KEY"],
  "xai": ["XAI_API_KEY"],
  "openrouter": ["OPENROUTER_API_KEY"],
  "deepseek": ["DEEPSEEK_API_KEY"],
  "cerebras": ["CEREBRAS_API_KEY"],
  "zai": ["ZAI_API_KEY"],
  "minimax": ["MINIMAX_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
};

/**
 * Provider key from the env the server was handed (not process.env, so tests and
 * embedders control it). Pi would read process.env itself; passing the key keeps
 * the lookup in one place and lets `instinct dev` and embedders inject keys.
 */
export function apiKeyFor(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const names = PROVIDER_KEY_ENV[provider] ?? [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** INKBOX_CALL_ORIGINATION, when it names a line Inkbox knows. Anything else is logged by the tool at boot. */
export function callOriginationFrom(env: NodeJS.ProcessEnv): CallOrigination | undefined {
  const raw = env.INKBOX_CALL_ORIGINATION?.trim().toLowerCase();
  if (!raw) return undefined;
  if ((CALL_ORIGINATIONS as readonly string[]).includes(raw)) return raw as CallOrigination;
  throw new Error(`INKBOX_CALL_ORIGINATION must be one of ${CALL_ORIGINATIONS.join(", ")}, not "${raw}"`);
}

/** The call.ended handler: fetch the transcript when the event has none, then one text to the owner. */
export function callReporter(
  channel: Pick<InkboxChannel, "callTranscript">,
  relay: (text: string, originKey: string) => Promise<boolean>,
  log: (m: string) => void,
): (event: CallEndedEvent) => Promise<void> {
  return async (event) => {
    await handleCallEnded(event, {
      fetchTranscript: (callId) => channel.callTranscript(callId),
      relayToOwner: (text) => relay(text, `system:call:${event.callId}`),
      logger: log,
    });
  };
}

interface InkboxSettings {
  apiKey: string;
  handle: string;
  identityId?: string;
}

function inkboxSettings(env: NodeJS.ProcessEnv, config: InstinctConfig): InkboxSettings | undefined {
  const apiKey = env.INKBOX_API_KEY;
  const handle = env.INKBOX_AGENT_HANDLE ?? config.agent.handle;
  if (!apiKey || !handle) return undefined;
  return { apiKey, handle, identityId: env.INKBOX_IDENTITY_ID };
}

/** An Ample agent credential (preferred: it never expires) or a plain token. */
export function ampleCredentials(env: NodeJS.ProcessEnv): AmpleCredentials | undefined {
  const clientId = env.AMPLE_CLIENT_ID?.trim();
  const clientSecret = env.AMPLE_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  const token = env.AMPLE_TOKEN?.trim();
  return token ? { token } : undefined;
}

/** Optional pieces must never stop the agent from booting. Log and go on. */
async function safely<T>(log: (m: string) => void, what: string, fn: () => Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    log(`${what} unavailable: ${(err as Error).message}`);
    return undefined;
  }
}

export type { RegisteredTool, ComputerBackend };
