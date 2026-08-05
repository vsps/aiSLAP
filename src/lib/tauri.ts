import { invoke as rawInvoke } from "@tauri-apps/api/core";
import type {
  ChainPreset,
  Config,
  AppState,
  ModelEntry,
  GalleryColumn,
  SequenceSidecar,
  ShotSidecar,
  ImageMetadata,
  PendingSubmission,
  PrismEntityType,
  PrismInfo,
  SeqTaggedGroup,
  SequenceStacks,
  TagDef,
  TagFilterMode,
  TagMigrationReport,
  ProjectCostScan,
  SequenceTimeline,
  TimelineInit,
  TimelineExportParams,
  AssetRecord,
  AssetRefRecord,
  SyncReport,
  ReconcileReport,
} from "./types";

// Thin typed wrapper over Tauri commands. Keep names 1:1 with Rust #[tauri::command] fns.

export const cmd = {
  // Config + app-state
  config_load: (): Promise<Config | null> => rawInvoke("config_load"),
  config_save: (config: Config): Promise<void> =>
    rawInvoke("config_save", { config }),

  app_state_load: (): Promise<AppState | null> => rawInvoke("app_state_load"),
  app_state_save: (state: AppState): Promise<void> =>
    rawInvoke("app_state_save", { state }),

  presets_load: (): Promise<{ presets: ChainPreset[] }> =>
    rawInvoke("presets_load"),
  presets_save: (data: { presets: ChainPreset[] }): Promise<void> =>
    rawInvoke("presets_save", { data }),

  provider_key_get: (provider: string): Promise<string> =>
    rawInvoke("provider_key_get", { provider }),
  provider_key_set: (provider: string, key: string): Promise<void> =>
    rawInvoke("provider_key_set", { provider, key }),

  // Models
  models_load: (): Promise<ModelEntry[]> => rawInvoke("models_load"),

  // Session
  project_open: (
    projectPath: string,
    entityType?: PrismEntityType,
  ): Promise<string[]> =>
    rawInvoke("project_open", { projectPath, entityType }),

  // PRISM
  /** Null for a plain aiSLAP project (no 00_Pipeline/pipeline.json). */
  prism_detect: (projectPath: string): Promise<PrismInfo | null> =>
    rawInvoke("prism_detect", { projectPath }),
  /** Ensures `<entity>/Renders/AI` (+ SRC, + a first version dir) and returns
   *  it. Idempotent when handed a media root already. */
  prism_media_root_ensure: (entityPath: string): Promise<string> =>
    rawInvoke("prism_media_root_ensure", { entityPath }),
  sequence_open: (
    sequencePath: string,
  ): Promise<{ shots: string[]; sidecar: SequenceSidecar }> =>
    rawInvoke("sequence_open", { sequencePath }),
  sequence_create: (projectPath: string, name: string): Promise<string> =>
    rawInvoke("sequence_create", { projectPath, name }),
  sequence_rename: (sequencePath: string, newName: string): Promise<string> =>
    rawInvoke("sequence_rename", { sequencePath, newName }),
  shot_open: (
    shotPath: string,
  ): Promise<{ columns: GalleryColumn[]; sidecar: ShotSidecar }> =>
    rawInvoke("shot_open", { shotPath }),
  shot_create: (sequencePath: string, name: string): Promise<string> =>
    rawInvoke("shot_create", { sequencePath, name }),
  shot_rename: (shotPath: string, newName: string): Promise<string> =>
    rawInvoke("shot_rename", { shotPath, newName }),
  shot_rescan: (shotPath: string): Promise<GalleryColumn[]> =>
    rawInvoke("shot_rescan", { shotPath }),
  dirs_exist: (paths: string[]): Promise<boolean[]> =>
    rawInvoke("dirs_exist", { paths }),
  dir_ensure: (path: string): Promise<void> =>
    rawInvoke("dir_ensure", { path }),

  // Stacked view
  sequence_stacks_scan: (sequencePath: string): Promise<SequenceStacks> =>
    rawInvoke("sequence_stacks_scan", { sequencePath }),
  shot_version_select_set: (
    shotPath: string,
    version: string,
    filename: string | null,
  ): Promise<ShotSidecar> =>
    rawInvoke("shot_version_select_set", { shotPath, version, filename }),
  version_stack_move: (
    srcShot: string,
    srcVersion: string,
    dstShot: string,
    dstVersion: string | null,
    copy: boolean,
  ): Promise<string> =>
    rawInvoke("version_stack_move", {
      srcShot,
      srcVersion,
      dstShot,
      dstVersion,
      copy,
    }),

  project_cost_scan: (projectPath: string): Promise<ProjectCostScan> =>
    rawInvoke("project_cost_scan", { projectPath }),

  // Tags. The sidecar is the source of truth; the SQLite index is a
  // rebuildable cache of it (project_tags_reindex / project_reconcile).
  image_tags_set: (imagePath: string, tags: string[]): Promise<string[]> =>
    rawInvoke("image_tags_set", { imagePath, tags }),
  project_tag_defs_get: (projectPath: string): Promise<TagDef[]> =>
    rawInvoke("project_tag_defs_get", { projectPath }),
  project_tag_defs_set: (
    projectPath: string,
    defs: TagDef[],
  ): Promise<TagDef[]> =>
    rawInvoke("project_tag_defs_set", { projectPath, defs }),
  project_tag_rename: (
    projectPath: string,
    oldName: string,
    newName: string,
  ): Promise<TagDef[]> =>
    rawInvoke("project_tag_rename", { projectPath, oldName, newName }),
  project_tag_delete: (projectPath: string, name: string): Promise<TagDef[]> =>
    rawInvoke("project_tag_delete", { projectPath, name }),
  project_tag_scan: (
    projectPath: string,
    tags: string[],
    mode: TagFilterMode,
  ): Promise<SeqTaggedGroup[]> =>
    rawInvoke("project_tag_scan", { projectPath, tags, mode }),
  project_tags_reindex: (projectPath: string): Promise<number> =>
    rawInvoke("project_tags_reindex", { projectPath }),
  project_tags_migrate: (projectPath: string): Promise<TagMigrationReport> =>
    rawInvoke("project_tags_migrate", { projectPath }),
  export_by_tag: (
    projectPath: string,
    tags: string[],
    mode: TagFilterMode,
    destDir: string,
    layout: string,
  ): Promise<number> =>
    rawInvoke("export_by_tag", { projectPath, tags, mode, destDir, layout }),

  sequence_prompt_append: (
    sequencePath: string,
    prompt: string,
  ): Promise<SequenceSidecar> =>
    rawInvoke("sequence_prompt_append", { sequencePath, prompt }),
  shot_prompts_append: (
    shotPath: string,
    prompts: string[],
  ): Promise<ShotSidecar> =>
    rawInvoke("shot_prompts_append", { shotPath, prompts }),

  script_read: (projectPath: string): Promise<string> =>
    rawInvoke("script_read", { projectPath }),
  script_write: (projectPath: string, content: string): Promise<void> =>
    rawInvoke("script_write", { projectPath, content }),

  version_create_next: (shotPath: string): Promise<string> =>
    rawInvoke("version_create_next", { shotPath }),

  ref_copy_to_global_src: (
    shotPath: string,
    sourcePath: string,
  ): Promise<string> =>
    rawInvoke("ref_copy_to_global_src", { shotPath, sourcePath }),

  image_copy_to_dir: (sourcePath: string, destDir: string): Promise<string> =>
    rawInvoke("image_copy_to_dir", { sourcePath, destDir }),

  image_move_to_dir: (sourcePath: string, destDir: string): Promise<string> =>
    rawInvoke("image_move_to_dir", { sourcePath, destDir }),

  image_rename: (sourcePath: string, newStem: string): Promise<string> =>
    rawInvoke("image_rename", { sourcePath, newStem }),

  reveal_in_explorer: (path: string): Promise<void> =>
    rawInvoke("reveal_in_explorer", { path }),

  image_metadata_read: (imagePath: string): Promise<ImageMetadata | null> =>
    rawInvoke("image_metadata_read", { imagePath }),
  image_metadata_write: (
    imagePath: string,
    metadata: ImageMetadata,
  ): Promise<void> =>
    rawInvoke("image_metadata_write", { imagePath, metadata }),
  image_delete: (imagePath: string): Promise<void> =>
    rawInvoke("image_delete", { imagePath }),
  column_delete: (columnPath: string): Promise<void> =>
    rawInvoke("column_delete", { columnPath }),

  download_to_path: (url: string, target: string): Promise<void> =>
    rawInvoke("download_to_path", { url, target }),

  write_text_file: (target: string, contents: string): Promise<void> =>
    rawInvoke("write_text_file", { target, contents }),

  save_png_base64: (path: string, dataBase64: string): Promise<void> =>
    rawInvoke("save_png_base64", { path, dataBase64 }),

  video_thumbnail_extract: (
    videoPath: string,
    thumbPath: string,
    ffmpegPath: string,
  ): Promise<boolean> =>
    rawInvoke("video_thumbnail_extract", { videoPath, thumbPath, ffmpegPath }),

  video_info_probe: (
    videoPath: string,
    ffmpegPath: string,
  ): Promise<{ fps: number | null; durationSec: number | null }> =>
    rawInvoke("video_info_probe", { videoPath, ffmpegPath }),

  image_dimensions_read: (
    path: string,
  ): Promise<{ width: number; height: number } | null> =>
    rawInvoke("image_dimensions_read", { path }),

  // Timeline
  timeline_init: (seqPath: string): Promise<TimelineInit> =>
    rawInvoke("timeline_init", { seqPath }),
  sequence_timeline_save: (
    seqPath: string,
    timeline: SequenceTimeline,
  ): Promise<void> =>
    rawInvoke("sequence_timeline_save", { seqPath, timeline }),
  shot_clip_media_set: (
    shotPath: string,
    mediaPath: string | null,
  ): Promise<void> => rawInvoke("shot_clip_media_set", { shotPath, mediaPath }),
  shot_version_comment_set: (
    shotPath: string,
    version: string,
    comment: string | null,
  ): Promise<void> =>
    rawInvoke("shot_version_comment_set", { shotPath, version, comment }),
  project_version_prefix_get: (projectPath: string): Promise<string> =>
    rawInvoke("project_version_prefix_get", { projectPath }),
  project_version_prefix_set: (
    projectPath: string,
    prefix: string,
  ): Promise<void> =>
    rawInvoke("project_version_prefix_set", { projectPath, prefix }),
  project_id_get: (projectPath: string): Promise<string | null> =>
    rawInvoke("project_id_get", { projectPath }),
  project_id_set: (projectPath: string, projectId: string): Promise<void> =>
    rawInvoke("project_id_set", { projectPath, projectId }),

  system_username: (): Promise<string> => rawInvoke("system_username"),

  // Asset identity (embedded in media + content hash)
  file_hash: (path: string): Promise<string> =>
    rawInvoke("file_hash", { path }),
  media_id_embed: (
    path: string,
    assetId: string,
    projectId: string,
    ffmpegPath: string,
  ): Promise<boolean> =>
    rawInvoke("media_id_embed", { path, assetId, projectId, ffmpegPath }),

  // Local asset index + Turso sync
  asset_upsert: (projectPath: string, record: AssetRecord): Promise<void> =>
    rawInvoke("asset_upsert", { projectPath, record }),
  asset_lookup: (
    projectPath: string,
    assetId: string | null,
    contentHash: string | null,
  ): Promise<AssetRecord | null> =>
    rawInvoke("asset_lookup", { projectPath, assetId, contentHash }),
  asset_refs_set: (
    projectPath: string,
    assetId: string,
    refs: AssetRefRecord[],
  ): Promise<void> =>
    rawInvoke("asset_refs_set", { projectPath, assetId, refs }),
  db_sync_outbox: (projectPath: string): Promise<SyncReport> =>
    rawInvoke("db_sync_outbox", { projectPath }),
  project_reconcile: (
    projectPath: string,
    ffmpegPath: string,
  ): Promise<ReconcileReport> =>
    rawInvoke("project_reconcile", { projectPath, ffmpegPath }),

  // Orphan recovery
  pending_load: (): Promise<PendingSubmission[]> => rawInvoke("pending_load"),
  pending_add: (record: PendingSubmission): Promise<void> =>
    rawInvoke("pending_add", { record }),
  pending_remove: (id: string): Promise<void> =>
    rawInvoke("pending_remove", { id }),

  timeline_export: (params: TimelineExportParams): Promise<void> =>
    rawInvoke("timeline_export", { params }),
};
