export { Molt, type MoltOptions, type BrowserWakeProvider } from "./runtime/molt.ts";
export { OriginVault, isVaultedHeaderName, isPlumbingHeaderName, parseSetCookie, splitSetCookieHeader } from "./vault/vault.ts";
export { distillWireExchanges, type DistillOptions } from "./distill/compiler.ts";
export {
  analyzeChronologicalProvenance,
  inferContextualSemType,
  parameterizeUrlPath,
  singularizeNoun,
  type ExchangeAnalysis,
  type ProducedLeaf,
} from "./distill/provenance.ts";
export { compileGraphQLExchanges } from "./distill/graphql-compiler.ts";
export { classifyStage1Noise, isZeroSemanticPortNoise } from "./distill/noise.ts";
export { parseHar, loadHarFile } from "./capture/har.ts";
export {
  CdpClient,
  CdpWireRecorder,
  captureWithEphemeralChrome,
  attachToExistingChromeTab,
  findChromeExecutable,
  type EphemeralCaptureResult,
} from "./capture/cdp.ts";
export type * from "./types.ts";

// Re-export invariant RightClick X primitives so Molt consumers have full access
export {
  RightClick,
  TOOLS,
  Authority,
  inferType,
  inspectValue,
  type Capability,
  type Port,
  type Reflection,
  type SemType,
  type RunRecord,
  type ComposeResult,
} from "../vendor/rightclick-x/src/index.ts";
