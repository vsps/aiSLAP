mod commands;
mod domain;
mod error;
mod fsjson;
mod paths;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Route tracing::warn!/error! to stderr; without a subscriber they vanish.
    tracing_subscriber::fmt::init();
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
            commands::rename::sequence_rename,
            commands::session::shot_open,
            commands::session::shot_create,
            commands::rename::shot_rename,
            commands::gallery::shot_rescan,
            commands::session::version_create_next,
            commands::gallery::project_starred_scan,
            commands::gallery::image_set_visible,
            commands::image::ref_copy_to_global_src,
            commands::image::image_copy_to_dir,
            commands::image::image_move_to_dir,
            commands::image::image_rename,
            commands::image::save_png_base64,
            commands::image::reveal_in_explorer,
            commands::prompt_history::sequence_prompt_append,
            commands::prompt_history::shot_prompts_append,
            commands::session::script_read,
            commands::session::script_write,
            commands::metadata::image_metadata_read,
            commands::metadata::image_metadata_write,
            commands::metadata::image_delete,
            commands::metadata::column_delete,
            commands::download::download_to_path,
            commands::download::write_text_file,
            commands::media::video_thumbnail_extract,
            commands::media::video_info_probe,
            commands::media::timeline_export,
            commands::timeline::timeline_init,
            commands::timeline::sequence_timeline_save,
            commands::session::shot_clip_media_set,
            commands::session::shot_version_comment_set,
            commands::session::project_version_prefix_get,
            commands::session::project_version_prefix_set,
            commands::pending::pending_load,
            commands::pending::pending_add,
            commands::pending::pending_remove,
            commands::session::dirs_exist,
            commands::session::dir_ensure,
            commands::gallery::sequence_stacks_scan,
            commands::session::shot_version_select_set,
            commands::image::version_stack_move,
            commands::image::image_copy_to_sel,
            commands::image::image_move_to_sel,
            commands::image::export_selects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
