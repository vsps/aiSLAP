mod commands;
mod domain;
mod error;
mod paths;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::config::config_load,
            commands::config::config_save,
            commands::config::app_state_load,
            commands::config::app_state_save,
            commands::config::fal_key_get,
            commands::config::fal_key_set,
            commands::config::provider_key_get,
            commands::config::provider_key_set,
            commands::config::presets_load,
            commands::config::presets_save,
            commands::models::models_load,
            commands::session::project_open,
            commands::session::sequence_open,
            commands::session::sequence_create,
            commands::session::sequence_rename,
            commands::session::shot_open,
            commands::session::shot_create,
            commands::session::shot_rename,
            commands::session::shot_rescan,
            commands::session::version_create_next,
            commands::session::project_starred_scan,
            commands::session::image_set_visible,
            commands::session::ref_copy_to_global_src,
            commands::session::image_copy_to_dir,
            commands::session::image_move_to_dir,
            commands::session::image_rename,
            commands::session::save_png_base64,
            commands::session::reveal_in_explorer,
            commands::session::sequence_prompt_append,
            commands::session::shot_prompt_append,
            commands::session::shot_prompts_append,
            commands::session::script_read,
            commands::session::script_write,
            commands::metadata::image_metadata_read,
            commands::metadata::image_metadata_write,
            commands::metadata::image_delete,
            commands::metadata::column_delete,
            commands::download::download_to_path,
            commands::media::video_thumbnail_extract,
            commands::media::timeline_export,
            commands::session::timeline_init,
            commands::session::sequence_timeline_save,
            commands::session::shot_clip_media_set,
            commands::session::shot_version_comment_set,
            commands::session::project_version_prefix_get,
            commands::session::project_version_prefix_set,
            commands::session::dirs_exist,
            commands::session::dir_ensure,
            commands::session::sequence_stacks_scan,
            commands::session::shot_version_select_set,
            commands::session::version_stack_move,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
