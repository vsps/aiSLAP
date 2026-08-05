//! Sequence/shot prompt-history appends (used to populate the prompt
//! navigation history shown in the editor).

use std::path::PathBuf;

use chrono::Utc;

use crate::commands::fsutil::{SEQUENCE_SIDECAR, SHOT_SIDECAR};
use crate::domain::{PromptEntry, SequenceSidecar, ShotSidecar};
use crate::error::AppResult;
use crate::fsjson::{
    read_json_or_default as read_sidecar, write_json_atomic as write_sidecar_atomic,
};

#[tauri::command]
pub fn sequence_prompt_append(sequence_path: String, prompt: String) -> AppResult<SequenceSidecar> {
    let root = PathBuf::from(&sequence_path);
    let path = root.join(SEQUENCE_SIDECAR);
    let mut sidecar: SequenceSidecar = read_sidecar(&path)?;
    if sidecar.name.is_empty() {
        sidecar.name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    if sidecar.prompt_history.last().map(|e| e.prompt.as_str()) != Some(prompt.as_str()) {
        sidecar.prompt_history.push(PromptEntry {
            timestamp: Utc::now().to_rfc3339(),
            prompt,
            prompts: None,
        });
        write_sidecar_atomic(&path, &sidecar)?;
    }
    Ok(sidecar)
}

#[tauri::command]
pub fn shot_prompts_append(shot_path: String, prompts: Vec<String>) -> AppResult<ShotSidecar> {
    let root = PathBuf::from(&shot_path);
    let path = root.join(SHOT_SIDECAR);
    let mut sidecar: ShotSidecar = read_sidecar(&path)?;
    if sidecar.name.is_empty() {
        sidecar.name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    let combined = prompts.join("\n\n");
    if sidecar.prompt_history.last().map(|e| e.prompt.as_str()) != Some(combined.as_str()) {
        sidecar.prompt_history.push(PromptEntry {
            timestamp: Utc::now().to_rfc3339(),
            prompt: combined,
            prompts: Some(prompts),
        });
        write_sidecar_atomic(&path, &sidecar)?;
    }
    Ok(sidecar)
}
