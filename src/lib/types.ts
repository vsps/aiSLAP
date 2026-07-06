// Shared domain types. Kept in sync with MIGRATION_PLAN.md §2.

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

export type Parameter = EnumParam | IntParam | FloatParam | BoolParam | PromptsParam;

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
  provider?: "fal" | "replicate";
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
  starred?: boolean;
};

export type ShotStarredGroup = {
  shotPath: string;
  shotName: string;
  images: GalleryImage[];
};

export type SeqStarredGroup = {
  seqPath: string;
  seqName: string;
  shots: ShotStarredGroup[];
};

export type GalleryColumn = {
  id: string;
  version: string;
  isSrc: boolean;
  images: GalleryImage[];
  srcImages: GalleryImage[];
  timestamp?: string;
  modelName?: string;
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

export type FalLifecycle = "immediate" | "1h" | "1d" | "7d" | "30d" | "1y" | "never";

export type Config = {
  windowBounds: { x?: number; y?: number; width: number; height: number };
  projectPath: string;
  lastSequence: string;
  lastShot: string;
  lastModel: string;
  ffmpegPath: string;
  /** Max number of submissions running in parallel; default 3. */
  maxConcurrentJobs?: number;
  /** Output filename template. Tokens: <date> <time> <sequence> <shot> <model> <version> <prompt> <iter> <seed> <provider> */
  filenameTemplate?: string;
  colors?: ColorOverrides;
  /** fal.ai object lifecycle: "immediate" | "1h" | "1d" | "7d" | "30d" | "1y" | "never" | seconds. Unset = fal default. */
  falLifecycle?: FalLifecycle;
  /** Per-endpoint price texts fetched from fal's gallery API (see lib/falPrices.ts). */
  falPrices?: Record<string, string>;
  falPricesFetchedAt?: string;
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

export type AppState = {
  projectPath: string;
  lastSequence: string;
  lastShot: string;
  lastModel: string;
  sequencePrompt: string;
  /** Legacy single-string shot prompt — read for back-compat only; new state lives in shotPrompts. */
  shotPrompt: string;
  shotPrompts: string[];
  settings: Record<string, unknown>;
  refImages: RefImage[];
  iterations: number;
  galleryHeight: number;
  thumbColWidth: number;
  logHeight: number;
  timelineHeight: number;
  queueWidth: number;
  /** When present, supersedes the flat sequencePrompt/shotPrompts/settings/refImages
   *  fields (those are still written for back-compat with old loaders). */
  chainLinks?: ChainLinkPersisted[];
  chainExpandedIdx?: number | null;
};

export type SequenceSidecar = {
  name: string;
  promptHistory: PromptEntry[];
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

// ---------- Image metadata sidecar ----------

export type RefSnapshot = {
  path: string;
  roleAssignment: RoleAssignment | null;
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
  provider?: "fal" | "replicate";
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
};

// ---------- Pending submissions (orphan recovery) ----------

/** Persistent record of an in-flight generation. Written by the provider
 *  the moment the API returns its request id; removed when downloadAndWrite
 *  completes (or the iteration aborts non-resumably). The recovery driver
 *  walks survivors after a crash/restart and re-pulls completed ones. */
export type PendingSubmission = {
  id: string;
  provider: "fal" | "replicate";
  endpoint: string;
  requestId: string;

  // Destination
  shotPath: string;
  targetVersion: string;
  ffmpegPath: string;
  filenameTemplate: string;

  // Model + iteration context (snapshotted for filename + sidecar)
  modelId: string;
  modelName: string;
  modelEndpoint: string;
  modelProvider?: "fal" | "replicate";
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

// ---------- Generation events ----------

export type GenerateProgressEvent = {
  id: string;
  message: string;
  iteration?: number;
  total?: number;
};

export type GenerateFinishedEvent = {
  id: string;
  outputs: GalleryImage[];
  version: string;
};

export type GenerateErrorEvent = {
  id: string;
  message: string;
};

export type GenerateCancelledEvent = {
  id: string;
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
