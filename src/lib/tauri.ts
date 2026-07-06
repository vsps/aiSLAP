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
  SeqStarredGroup,
  SequenceStacks,
  SequenceTimeline,
  TimelineInit,
  TimelineExportParams,
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

  fal_key_get: (): Promise<string> => rawInvoke("fal_key_get"),
  fal_key_set: (key: string): Promise<void> =>
    rawInvoke("fal_key_set", { key }),
  provider_key_get: (provider: string): Promise<string> =>
    rawInvoke("provider_key_get", { provider }),
  provider_key_set: (provider: string, key: string): Promise<void> =>
    rawInvoke("provider_key_set", { provider, key }),

  // Models
  models_load: (): Promise<ModelEntry[]> => rawInvoke("models_load"),

  // Session
  project_open: (projectPath: string): Promise<string[]> =>
    rawInvoke("project_open", { projectPath }),
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

  project_starred_scan: (projectPath: string): Promise<SeqStarredGroup[]> =>
    rawInvoke("project_starred_scan", { projectPath }),

  image_set_visible: (imagePath: string, visible: boolean): Promise<void> =>
    rawInvoke("image_set_visible", { imagePath, visible }),

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

  image_copy_to_sel: (shotPath: string, sourcePath: string): Promise<string> =>
    rawInvoke("image_copy_to_sel", { shotPath, sourcePath }),

  image_move_to_sel: (shotPath: string, sourcePath: string): Promise<string> =>
    rawInvoke("image_move_to_sel", { shotPath, sourcePath }),

  export_selects: (
    projectPath: string,
    destDir: string,
    mode: string,
  ): Promise<number> =>
    rawInvoke("export_selects", { projectPath, destDir, mode }),

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

  // Orphan recovery
  pending_load: (): Promise<PendingSubmission[]> => rawInvoke("pending_load"),
  pending_add: (record: PendingSubmission): Promise<void> =>
    rawInvoke("pending_add", { record }),
  pending_remove: (id: string): Promise<void> =>
    rawInvoke("pending_remove", { id }),

  timeline_export: (params: TimelineExportParams): Promise<void> =>
    rawInvoke("timeline_export", { params }),
};
