export {
  OIP_INTENTS,
  OIP_VERSION,
  encodeOip,
  decodeOip,
  describeOip,
  oipToText,
  type OipIntent,
  type OipMessage,
  type OipTextOptions,
} from "./oip.js";
export { CAPABILITIES, TIERS, ASSIGNABLE_TIERS, isCapability, isTier, parseCapabilities } from "./capabilities.js";
export { resolveA2aPrincipal, normalizeAgentHandle } from "./principal.js";
export { networkGuidance } from "./guidance.js";
export { lookupContact, slugify, phoneKey, contactLine, type ContactLookup, type LookupOptions } from "./lookup.js";
export { networkTools, type NetworkToolDeps, type A2aLike, type ProvisionerLike } from "./tools.js";
export {
  PARTNER_PROTOCOL_VERSION,
  PARTNER_DOMAINS,
  PARTNER_INTENTS,
  COMMITTING_INTENTS,
  FALLBACK as PARTNER_FALLBACK,
  PartnerRegistry,
  partnerTools,
  validateRequest as validatePartnerRequest,
  type PartnerConnector,
  type PartnerRequest,
  type PartnerResponse,
  type PartnerProposal,
  type PartnerDomain,
  type PartnerIntent,
  type PartnerToolDeps,
} from "./partners.js";
export { e2eeA2aTools, decodeE2ee, describeE2ee, e2eeFileData, e2eeKeysData, fingerprintOf, E2EE_A2A_MAX_BYTES, E2EE_A2A_VERSION, type E2eeData, type E2eeA2aDeps } from "./e2ee-a2a.js";
