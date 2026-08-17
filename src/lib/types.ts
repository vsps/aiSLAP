// Shared domain types — the canonical definitions for the whole frontend, and
// the TypeScript half of the IPC wire format (src-tauri/src/domain.rs is the
// other). See docs/architecture.md § Domain model.

// ---------- Models ----------

export type ModelKind = "image" | "video" | "model3d";

export type ModelInput = {
  name: string;
  data_type: "STRING" | "IMAGE" | "VIDEO" | "AUDIO";
  api_field: string;
  api_format?: "array";
  required?: boolean;
  max?: number;
};

export type ModelOutput = {
  name: string;
  data_type: "IMAGE" | "VIDEO" | "MODEL_3D";
  api_field: string;
};

export type RefRoleSpec = {
  // Canonical role name. Models in-repo today use "source" | "start" | "end".
  // Free-form string keeps the door open for "element" etc.
  role: string;
  api_field: string;
  max?: number;
  exclusive?: boolean;
  named?: boolean;
};

export type EnumParam = {
  type: "enum";
  name: string;
  label: string;
  api_field: string;
  default: string;
  options: string[];
};

export type IntParam = {
  type: "int";
  name: string;
  label: string;
  api_field: string;
  default: number;
  min: number;
  max: number;
};

export type FloatParam = {
  type: "float";
  name: string;
  label: string;
  api_field: string;
  default: number;
  min: number;
  max: number;
  step: number;
};

export type BoolParam = {
  type: "bool";
  name: string;
  label: string;
  api_field: string;
  default: boolean;
};

/** SAM segmentation geometry prompts. Pixel-space coordinates. label 1=fg, 0=bg.
 *  frame_index is only set for video sources. */
export type SamPoint = {
  x: number;
  y: number;
  label: 0 | 1;
  obj_id?: number;
  frame_index?: number;
};

export type SamBox = {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  obj_id?: number;
  frame_index?: number;
};

/** UI hook for the point/box prompt editor. The control writes two settings
 *  keys directly (`point_prompts`, `box_prompts`); `api_field` is nominal. */
export type PromptsParam = {
  type: "prompts";
  name: string;
  label: string;
  api_field: string;
  default: [];
};

export type Parameter =
  EnumParam | IntParam | FloatParam | BoolParam | PromptsParam;

export type ModelNode = {
  id: string;
  name: string;
  endpoint: string;
  kind: ModelKind;
  inputs: ModelInput[];
  outputs: ModelOutput[];
  ref_roles?: RefRoleSpec[];
  parameters: Parameter[];
  batch_field?: string;
  /** Defaults to "fal" when omitted. */
  provider?: "fal" | "replicate" | "bytedance";
};

export type ModelEntry = {
  family: string;
  category: string;
  node: ModelNode;
};

// ---------- Reference images ----------

export type RoleAssignment =
  | { kind: "source" }
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "mesh" }
  | { kind: "element"; groupName: string; frontal: boolean }
  | { kind: "image"; groupName: string }
  // Synthetic placeholder for the output of the previous chain link.
  // Resolved at chain-run time to the upstream link's output path.
  | { kind: "chain_prev" };

export type RefImage = {
  path: string;
  roleAssignment: RoleAssignment | null;
  /** The ref source's assetId/contentHash, captured at ref-add time from its
   *  own sidecar (when it has one) — lets the resolver in lib/actions.ts
   *  find this ref again by id/hash if `path` no longer resolves (moved,
   *  renamed, or restored on a different machine). Absent for refs added
   *  before Phase 2, or whose source predates Phase 1 asset identity. */
  assetId?: string;
  hash?: string;
};

// ---------- Prompt chains ----------

export type ChainLink = {
  id: string;
  active: boolean;
  model: ModelNode | null;
  settings: Record<string, unknown>;
  sequencePrompt: string;
  shotPrompts: string[];
  refImages: RefImage[];
  // When true on a non-head link, a synthetic chain_prev ref is prepended
  // at chain-run time. Default true for newly added links, false for the
  // initial head link.
  consumesPrev: boolean;
  // Inclusion flags for the combined prompt. undefined means included.
  sequencePromptIncluded?: boolean;
  sequenceScriptIncluded?: boolean;
  shotScriptIncluded?: boolean;
  shotPromptsIncluded?: boolean[];
};

// ---------- Chain presets ----------

/** One link's saved configuration — model + prompts only, no refs. */
export type ChainPresetLink = {
  modelId: string | null;
  settings: Record<string, unknown>;
  sequencePrompt: string;
  shotPrompts: string[];
};

/** A named chain configuration the user can restore later. */
export type ChainPreset = {
  id: string;
  name: string;
  links: ChainPresetLink[];
  createdAt: string; // ISO timestamp
};

// ---------- Gallery ----------

export type GalleryImage = {
  filename: string;
  path: string;
  metadataPath: string;
  isVideo: boolean;
  isModel3d?: boolean;
  thumbPath?: string;
  /** Tag names on this image, resolved at scan time. */
  tags?: string[];
  /** OS username that generated this image, resolved at scan time the same
   *  way as `tags`. Absent for SRC/ref images. */
  generatedBy?: string;
  /** True when the image hasn't been generated yet — renders a placeholder tile. */
  pending?: boolean;
};

export type ShotTaggedGroup = {
  shotPath: string;
  shotName: string;
  images: GalleryImage[];
};

export type SeqTaggedGroup = {
  seqPath: string;
  seqName: string;
  shots: ShotTaggedGroup[];
};

export type GalleryColumn = {
  id: string;
  version: string;
  isSrc: boolean;
  images: GalleryImage[];
  srcImages: GalleryImage[];
  timestamp?: string;
  modelName?: string;
  /** True when the column doesn't exist on disk (pending-output placeholder). */
  synthetic?: boolean;
};

// ---------- Prompt history ----------

export type PromptEntry = {
  timestamp: string;
  prompt: string;
  /** Individual sub-prompt panels. Absent on legacy single-prompt entries. */
  prompts?: string[];
};

export type PromptHistoryChannel = {
  entries: PromptEntry[];
  cursor: number; // entries.length == live (showing liveValue from generationStore)
};

// ---------- Persisted config + state ----------

export type ColorOverrides = {
  bg?: string;
  border?: string;
  src?: string;
  handle?: string;
  text?: string;
  accent?: string;
};

export type FalLifecycle =
  "immediate" | "1h" | "1d" | "7d" | "30d" | "1y" | "never";

export type Config = {
  windowBounds: { x?: number; y?: number; width: number; height: number };
  projectPath: string;
  lastSequence: string;
  lastShot: string;
  lastModel: string;
  ffmpegPath: string;
  /** Max number of submissions running in parallel; default 3. */
  maxConcurrentJobs?: number;
  /** Output filename template. Tokens: <date> <time> <sequence> <shot> <model> <version> <prompt> <iter> <seed> <provider> <minor> <rnd> */
  filenameTemplate?: string;
  colors?: ColorOverrides;
  /** fal.ai object lifecycle: "immediate" | "1h" | "1d" | "7d" | "30d" | "1y" | "never" | seconds. Unset = fal default. */
  falLifecycle?: FalLifecycle;
  /** Per-endpoint price texts fetched from fal's official pricing API (see lib/falPrices.ts). */
  falPrices?: Record<string, string>;
  falPricesFetchedAt?: string;
  /** Per-endpoint user-entered price overrides (any provider), keyed like
   *  falPrices. Takes priority over a fetched price when set — the only way
   *  to price non-fal models, since only fal has a pricing API. */
  priceOverrides?: Record<string, number>;
  /** BytePlus TOS object storage — hosts ByteDance reference material as
   *  fetchable URLs. Credentials (AK/SK) live in .env; these are the
   *  non-secret targeting fields. Defaults in lib/providers/tos.ts. */
  tos?: {
    bucket: string;
    region: string;
    /** Host suffix, e.g. "tos-ap-southeast-1.bytepluses.com". */
    endpoint: string;
    /** Days before uploaded refs auto-expire via the bucket lifecycle rule. */
    refExpiryDays?: number;
  };
  /** Background-check for app updates on launch. Default true. */
  autoCheckUpdates?: boolean;
  /** Version dismissed via the background auto-check's "Later" — suppresses
   *  re-prompting for that version on the next launch. The manual "Check for
   *  updates" button in Settings ignores this. */
  lastDismissedUpdateVersion?: string;
};

export const DEFAULT_MAX_CONCURRENT_JOBS = 3;

export const DEFAULT_CONFIG: Config = {
  windowBounds: { width: 1600, height: 1000 },
  projectPath: "",
  lastSequence: "",
  lastShot: "",
  lastModel: "",
  ffmpegPath: "",
  maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
  filenameTemplate: undefined,
  colors: undefined,
  falLifecycle: undefined,
  autoCheckUpdates: true,
  lastDismissedUpdateVersion: undefined,
};

// ---------- Submission queue ----------

export type JobStatus =
  | "queued"
  | "uploading"
  | "running"
  | "downloading"
  | "cancelling"
  | "done"
  | "failed"
  | "cancelled";

export type Job = {
  id: string;
  status: JobStatus;
  progressMessage: string;
  currentIteration: number;
  iterations: number;
  /** Number of iterations whose media has been fully written to disk.
   *  0 until the first download lands; bumps to k after iter k completes. */
  completedIterations: number;
  modelName: string;
  shotPath: string;
  targetVersion: string;
  error?: string;
  startedAt: number;
  /** Wall-clock ISO timestamp captured when the job was enqueued, for
   *  display in the queue checklist (formatted to HH:MM:SS per row). */
  enqueuedAt: string;
  /** First 1–120 chars of the shot prompt (newlines collapsed to spaces),
   *  captured at enqueue for display in the queue checklist. */
  shotPromptPreview?: string;
};

/** Persisted variant of ChainLink — model is stored by id and resolved
 *  against the live registry at bootstrap. */
export type ChainLinkPersisted = {
  id: string;
  active: boolean;
  modelId: string | null;
  settings: Record<string, unknown>;
  sequencePrompt: string;
  shotPrompts: string[];
  refImages: RefImage[];
  consumesPrev: boolean;
  sequencePromptIncluded?: boolean;
  sequenceScriptIncluded?: boolean;
  shotScriptIncluded?: boolean;
  shotPromptsIncluded?: boolean[];
};

/** Which PRISM entity tree the session is working in — shots under
 *  `03_Production/Shots`, assets under `03_Production/Assets`. */
export type PrismEntityType = "shot" | "asset";

/** PRISM layout for the open project, from `00_Pipeline/pipeline.json`.
 *  Null/absent means a plain aiSLAP project. */
export type PrismInfo = {
  root: string;
  shotsRoot: string;
  assetsRoot: string;
  /** Digits in a version folder name (PRISM `globals.versionPadding`, 4 stock). */
  versionPadding: number;
  projectName: string;
};

export type AppState = {
  projectPath: string;
  /** Sequence/shot paths relative to their parent. In a native project that's
   *  just the folder name; in a PRISM project it carries the entity-root and
   *  `Renders/AI` segments so the restore can rejoin them. */
  lastSequence: string;
  lastShot: string;
  /** Persisted so a PRISM session reopens in the tree it was left in. */
  prismEntityType?: PrismEntityType;
  lastModel: string;
  sequencePrompt: string;
  /** Legacy single-string shot prompt — read for back-compat only; new state lives in shotPrompts. */
  shotPrompt: string;
  shotPrompts: string[];
  settings: Record<string, unknown>;
  refImages: RefImage[];
  iterations: number;
  /** When present, supersedes the flat sequencePrompt/shotPrompts/settings/refImages
   *  fields (those are still written for back-compat with old loaders). */
  chainLinks?: ChainLinkPersisted[];
  chainExpandedIdx?: number | null;
};

export type SequenceSidecar = {
  name: string;
  promptHistory: PromptEntry[];
  /** Sum of costUsd across every image under this sequence's shots, from the
   *  most recent project_cost_scan run. Absent until a scan has run once. */
  totalCostUsd?: number;
  knownImageCount?: number;
  unknownImageCount?: number;
};

export type ShotSidecar = {
  name: string;
  promptHistory: PromptEntry[];
  /** Single exclusive "clip media" pick (set via the clapperboard icon on a thumb). */
  clipMediaPath?: string | null;
  /** Per-version pinned "select" picks (stacked view). Key = version name
   *  (e.g. "v003"), value = filename within that version dir. When unset for a
   *  version, the latest image is used. */
  versionSelects?: Record<string, string>;
  /** Per-version short free-text comments. Folders are not renamed. */
  versionComments?: Record<string, string>;
  /** Sum of costUsd across every image in this shot's version folders, from
   *  the most recent project_cost_scan run. Absent until a scan has run once. */
  totalCostUsd?: number;
  knownImageCount?: number;
  unknownImageCount?: number;
};

// ---------- Stacked view (sequence-wide shot/version grid) ----------

export type VersionStack = {
  version: string;
  images: GalleryImage[];
  selectedFilename: string;
};

export type ShotStack = {
  shotPath: string;
  shotName: string;
  versions: VersionStack[];
  clipMediaPath?: string | null;
};

export type SequenceStacks = {
  globalSrcImages: GalleryImage[];
  shots: ShotStack[];
};

// ---------- Timeline (NLE) ----------

export type TimelineClip = {
  id: string;
  /** Absolute path to the source shot. null = a blank/padding clip. */
  shotPath: string | null;
  enabled: boolean;
  durationSec: number;
  /**
   * Explicit media-path override for this clip (chosen via the version picker
   * on the clip). When null, falls back to the shot's `clipMediaPath`, then to
   * the latest version's last image.
   */
  mediaPath: string | null;
  /**
   * Slip offset into the source media (seconds). Default 0. Only meaningful
   * for video media — the clip plays `[offset, offset + durationSec]` of the
   * source. Clamped at use sites by source duration.
   */
  sourceOffsetSec?: number;
};

export type SequenceTimeline = {
  totalDurationSec: number;
  clips: TimelineClip[];
};

export type ShotLatestMedia = {
  shotPath: string;
  mediaPath: string | null;
  isVideo: boolean;
  clipMediaPath: string | null;
};

export type TimelineInit = {
  timeline: SequenceTimeline;
  shotsLatestMedia: ShotLatestMedia[];
};

export type ExportSegment =
  | { kind: "image"; path: string; durationSec: number }
  | {
      kind: "video";
      path: string;
      durationSec: number;
      sourceOffsetSec: number;
    }
  | { kind: "blank"; durationSec: number };

export type TimelineExportParams = {
  segments: ExportSegment[];
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  ffmpegPath: string;
};

export type VideoTrimParams = {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  ffmpegPath: string;
};

// ---------- Image metadata sidecar ----------

export type RefSnapshot = {
  path: string;
  roleAssignment: RoleAssignment | null;
  assetId?: string;
  hash?: string;
};

/** Per-output snapshot of the chain that produced this media. Captured at
 *  submit time so the full chain can be restored even if intermediate files
 *  are deleted. */
export type ChainMetadataBlock = {
  chainId: string;
  linkIndex: number;
  linkCount: number;
  /** Absolute path of the upstream link's output. Absent on the head. */
  prevMediaPath?: string;
  /** Absolute paths of downstream link outputs. Backfilled by the runner
   *  as each downstream link finishes; may be missing on in-flight chains. */
  nextMediaPaths?: string[];
  /** Persisted snapshot of every link (active and inactive) in the chain. */
  links: ChainLinkPersisted[];
};

export type ImageMetadata = {
  provider?: "fal" | "replicate" | "bytedance";
  model: string;
  modelId: string;
  endpoint: string;
  sequencePrompt?: string;
  shotPrompt?: string;
  shotPrompts?: string[];
  combinedPrompt?: string;
  // Back-compat with old single-prompt sidecars.
  prompt?: string;
  settings: Record<string, unknown>;
  refs: (RefSnapshot | string)[];
  iterationIndex?: number;
  iterationTotal?: number;
  timestamp: string;
  /** New field, written by all providers. */
  providerResponse?: unknown;
  /** Legacy field; kept so old sidecars still parse. */
  falResponse?: unknown;
  /** Chain provenance — present only when this media was produced as part
   *  of a multi-link chain submission. */
  chain?: ChainMetadataBlock;
  /** Computed at write time from cached fal per-item prices (Settings ->
   *  fetch prices). Omitted when the model's price is unknown or isn't
   *  billed per-item (time/size-billed models are left unpriced). Backfilled
   *  into older sidecars by project_cost_scan when a price becomes known
   *  later — see src-tauri/src/commands/cost.rs. */
  costUsd?: number;
  /** True once `costUsd` reflects a real charge pulled from fal's
   *  billing-events API (see reconcile_actual_costs in cost.rs) rather than
   *  an estimate. Absent/false means `costUsd` is still just fal's
   *  historical-price estimate or the local unit-price computation. */
  costUsdActual?: boolean;
  /** fal's id for the job that produced this output — only present for the
   *  fal provider (see ProviderOutput.requestId). The join key for looking up
   *  the real billed amount later via fal's billing-events API. */
  falRequestId?: string;
  /** Stable identity for this output, minted at write time (crypto.randomUUID).
   *  Embedded into the media file itself (see lib/tauri.ts media_id_embed) so
   *  a file that's moved or unlinked from this sidecar can still be traced
   *  back to it — the join key for a future central asset index. */
  assetId?: string;
  /** SHA-256 of the media file's bytes at write time, captured after
   *  embedding. Fallback identity when embedded tags get stripped by an
   *  external tool (re-encode, re-export, etc). */
  contentHash?: string;
  /** Lineage for media aiSLAP derived from other media rather than generating
   *  it — currently only the video trim. Deliberately not folded into `refs`,
   *  which stays the original generation's inputs so RESTORE PROMPT still
   *  reproduces the generation rather than the edit. */
  derivedFrom?: {
    op: "trim";
    /** Source path at derivation time — a hint; `assetId` is the durable link. */
    path: string;
    assetId?: string;
    startSec: number;
    endSec: number;
  };
  /** User tag names. The sidecar is the source of truth for these — the
   *  SQLite index is a rebuildable cache of them, and they ride along with
   *  the file on copy/move/rename for free. Written by image_tags_set;
   *  never set at generation time. */
  tags?: string[];
  /** OS/system username that ran this generation, captured at write time via
   *  whoami — the attribution join key for a future central-db "who
   *  generated what, for how much" query. Absent on sidecars written before
   *  this field existed. */
  generatedBy?: string;
};

// ---------- Tags ----------

/** A project's tag vocabulary entry (project.json `tagDefs`). Images
 *  reference a tag by name, so this only carries the display color. */
export type TagDef = {
  name: string;
  /** CSS color, assigned round-robin from a palette on first use. */
  color: string;
};

/** "any" matches an image carrying at least one of the filter's tags; "all"
 *  requires every one. An empty filter means "anything tagged". */
export type TagFilterMode = "any" | "all";

export type TagMigrationReport = {
  /** False when the project had already been migrated — the counts are then
   *  meaningless and nothing was touched. */
  ran: boolean;
  starred: number;
  selects: number;
};

// ---------- Local asset index (db.rs) ----------

/** Mirrors the Rust `AssetRecord` — a row in the local (and, once synced,
 *  Turso) `assets` table. `relPath` is project-relative, forward-slash. */
export type AssetRecord = {
  id: string;
  projectId?: string;
  relPath: string;
  contentHash?: string;
  kind: "image" | "video" | "model3d" | "other";
  provider?: string;
  modelId?: string;
  endpoint?: string;
  combinedPrompt?: string;
  settingsJson?: string;
  costUsd?: number;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  generatedBy?: string;
};

export type AssetRefRecord = {
  ordinal: number;
  refAssetId?: string;
  refRelPath?: string;
  refHash?: string;
  roleJson?: string;
};

export type SyncReport = {
  configured: boolean;
  pushed: number;
  pending: number;
  error?: string;
};

export type ReconcileReport = {
  scanned: number;
  sidecarBackfilled: number;
  dbIngested: number;
  relinked: number;
  /** Assets whose indexed tags disagreed with their sidecar — the sidecar
   *  wins, so this is how externally-edited tags get back into the index. */
  tagsSynced: number;
};

// ---------- Cost aggregation (project_cost_scan) ----------

export type ShotCost = {
  name: string;
  path: string;
  totalCostUsd: number;
  knownImageCount: number;
  unknownImageCount: number;
};

export type SequenceCost = ShotCost & {
  shots: ShotCost[];
};

export type ProjectCostScan = {
  totalCostUsd: number;
  knownImageCount: number;
  unknownImageCount: number;
  /** Count of image sidecars that were missing costUsd but got backfilled
   *  this run (subset of knownImageCount). */
  backfilledCount: number;
  sequences: SequenceCost[];
};

// ---------- Actual-cost reconciliation (reconcile_actual_costs) ----------

export type ReconcileCostResult = {
  /** Distinct fal request ids looked up against billing-events. */
  checked: number;
  /** Sidecars whose costUsd was updated to a real billed amount. */
  reconciled: number;
  /** Requests with no billing-events record yet (billing lag) — re-run later. */
  unavailable: number;
};

// ---------- Per-image cost report (project_cost_lines) ----------

export type CostReportLine = {
  /** Sidecar's assetId when present, else a project-relative path — always unique. */
  id: string;
  sequence: string;
  shot: string;
  /** "<sequence>/<shot>" — collision-free across sequences that share a shot name. */
  shotKey: string;
  version: string;
  provider?: "fal" | "replicate" | "bytedance";
  modelId?: string;
  model?: string;
  generatedBy?: string;
  /** Absent = no sidecar, or one with no costUsd yet. Never backfilled by this scan. */
  costUsd?: number;
};

export type ProjectCostReport = {
  generatedAt: string;
  lines: CostReportLine[];
};

// ---------- Pending submissions (orphan recovery) ----------

/** Persistent record of an in-flight generation. Written by the provider
 *  the moment the API returns its request id; removed when downloadAndWrite
 *  completes (or the iteration aborts non-resumably). The recovery driver
 *  walks survivors after a crash/restart and re-pulls completed ones. */
export type PendingSubmission = {
  id: string;
  provider: "fal" | "replicate" | "bytedance";
  endpoint: string;
  requestId: string;

  // Destination
  shotPath: string;
  /** Project root at submit time. Absent on records written before PRISM
   *  support, where the project is two levels above `shotPath`. */
  projectPath?: string;
  targetVersion: string;
  ffmpegPath: string;
  filenameTemplate: string;

  // Model + iteration context (snapshotted for filename + sidecar)
  modelId: string;
  modelName: string;
  modelEndpoint: string;
  modelProvider?: "fal" | "replicate" | "bytedance";
  batchField?: string;
  sequencePrompt: string;
  shotPrompt: string;
  shotPrompts: string[];
  combinedPrompt: string;
  settings: Record<string, unknown>;
  refs: RefSnapshot[];
  iterations: number;
  iterationIndex: number;
  chain?: ChainMetadataBlock | null;

  enqueuedAt: string;
};

export type LogEvent = {
  level: "INFO" | "PROGRESS" | "SUCCESS" | "ERROR";
  message: string;
  /** Short tag used to disambiguate concurrent jobs (e.g. first 6 chars of the job id). */
  tag?: string;
};

// ---------- Uploaded references (used by generate / args) ----------

export type UploadedRef = { ref: RefImage; url: string };

export type KlingElement = {
  frontal_image_url: string;
  reference_image_urls: string[];
};
