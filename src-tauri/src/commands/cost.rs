//! Project-wide cost aggregation: walks every image sidecar under a project,
//! backfills `costUsd` on older sidecars where a per-item fal price is now
//! cached, and rolls the totals up into shot/sequence sidecars plus a
//! project-wide grand total. Read-heavy; writes only sidecars that are
//! missing costUsd and can now be priced (idempotent and safe to re-run).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::commands::fsutil::{
    as_str, is_image_ext, is_model3d_ext, is_video_ext, list_dirs, SEL_DIR, SEQUENCE_SIDECAR,
    SRC_DIR,
};
use crate::commands::session::with_shot_sidecar;
use crate::domain::{Config, SequenceSidecar, ShotSidecar};
use crate::error::{run_blocking, AppResult};
use crate::fsjson::{read_json_or_default, write_json_atomic};
use crate::pricing::per_item_price;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShotCost {
    pub name: String,
    pub path: String,
    pub total_cost_usd: f64,
    pub known_image_count: u32,
    pub unknown_image_count: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SequenceCost {
    pub name: String,
    pub path: String,
    pub total_cost_usd: f64,
    pub known_image_count: u32,
    pub unknown_image_count: u32,
    pub shots: Vec<ShotCost>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCostScan {
    pub total_cost_usd: f64,
    pub known_image_count: u32,
    pub unknown_image_count: u32,
    /// Count of image sidecars that were missing costUsd but got backfilled
    /// this run (subset of known_image_count).
    pub backfilled_count: u32,
    pub sequences: Vec<SequenceCost>,
}

#[tauri::command]
pub async fn project_cost_scan(project_path: String) -> AppResult<ProjectCostScan> {
    run_blocking(move || project_cost_scan_impl(project_path)).await
}

fn project_cost_scan_impl(project_path: String) -> AppResult<ProjectCostScan> {
    let root = PathBuf::from(&project_path);
    let config: Config = read_json_or_default(&crate::paths::config_path()?)?;
    let prices = config.fal_prices.unwrap_or_default();

    let mut project_total = 0.0f64;
    let mut project_known = 0u32;
    let mut project_unknown = 0u32;
    let mut project_backfilled = 0u32;
    let mut sequences: Vec<SequenceCost> = Vec::new();

    for seq_dir in list_dirs(&root)? {
        let seq_name = match seq_dir.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Project-level SRC ("GLOBAL SRC" reference images) is not a
        // sequence -- skip it explicitly.
        if seq_name == SRC_DIR {
            continue;
        }

        let mut seq_total = 0.0f64;
        let mut seq_known = 0u32;
        let mut seq_unknown = 0u32;
        let mut shots: Vec<ShotCost> = Vec::new();

        for shot_dir in list_dirs(&seq_dir)? {
            let shot_name = match shot_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if shot_name == SRC_DIR || shot_name == SEL_DIR {
                continue;
            }

            let (shot_total, shot_known, shot_unknown, shot_backfilled) =
                scan_shot_cost(&shot_dir, &prices)?;

            with_shot_sidecar(&as_str(&shot_dir), |sidecar: &mut ShotSidecar| {
                sidecar.total_cost_usd = Some(shot_total);
                sidecar.known_image_count = Some(shot_known);
                sidecar.unknown_image_count = Some(shot_unknown);
            })?;

            shots.push(ShotCost {
                name: shot_name,
                path: as_str(&shot_dir),
                total_cost_usd: shot_total,
                known_image_count: shot_known,
                unknown_image_count: shot_unknown,
            });
            seq_total += shot_total;
            seq_known += shot_known;
            seq_unknown += shot_unknown;
            project_backfilled += shot_backfilled;
        }

        let seq_sidecar_path = seq_dir.join(SEQUENCE_SIDECAR);
        let mut seq_sidecar: SequenceSidecar = read_json_or_default(&seq_sidecar_path)?;
        seq_sidecar.total_cost_usd = Some(seq_total);
        seq_sidecar.known_image_count = Some(seq_known);
        seq_sidecar.unknown_image_count = Some(seq_unknown);
        write_json_atomic(&seq_sidecar_path, &seq_sidecar)?;

        sequences.push(SequenceCost {
            name: seq_name,
            path: as_str(&seq_dir),
            total_cost_usd: seq_total,
            known_image_count: seq_known,
            unknown_image_count: seq_unknown,
            shots,
        });
        project_total += seq_total;
        project_known += seq_known;
        project_unknown += seq_unknown;
    }

    Ok(ProjectCostScan {
        total_cost_usd: project_total,
        known_image_count: project_known,
        unknown_image_count: project_unknown,
        backfilled_count: project_backfilled,
        sequences,
    })
}

/// Walk every version-folder image under one shot (skipping SRC/SEL, mirroring
/// scan_shot_columns's traversal in gallery.rs -- no is_version_name gate is
/// applied there either, so this matches it), read/backfill each sidecar's
/// costUsd, and return (total, known_count, unknown_count, backfilled_count).
fn scan_shot_cost(
    shot_dir: &Path,
    prices: &HashMap<String, String>,
) -> AppResult<(f64, u32, u32, u32)> {
    let mut total = 0.0f64;
    let mut known = 0u32;
    let mut unknown = 0u32;
    let mut backfilled = 0u32;

    for entry in std::fs::read_dir(shot_dir)? {
        let entry = entry?;
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name == SRC_DIR || name == SEL_DIR {
            continue;
        }
        for file_entry in std::fs::read_dir(&p)? {
            let file_entry = file_entry?;
            let media_path = file_entry.path();
            if !media_path.is_file() {
                continue;
            }
            if !is_image_ext(&media_path)
                && !is_video_ext(&media_path)
                && !is_model3d_ext(&media_path)
            {
                continue;
            }
            let sidecar_path = media_path.with_extension("json");
            if !sidecar_path.is_file() {
                unknown += 1;
                continue;
            }
            match process_image_sidecar(&sidecar_path, prices) {
                Ok(Some((amount, was_backfilled))) => {
                    total += amount;
                    known += 1;
                    if was_backfilled {
                        backfilled += 1;
                    }
                }
                Ok(None) => unknown += 1,
                Err(e) => {
                    tracing::warn!("cost scan: skipping {}: {e}", sidecar_path.display());
                    unknown += 1;
                }
            }
        }
    }
    Ok((total, known, unknown, backfilled))
}

/// Read one image's `.json` sidecar. If `costUsd` is already present, trust
/// it as-is (never overwrite a previously-computed value, even if prices
/// have since changed). If absent, try to compute it from
/// provider+endpoint+prices; on success, write it back (backfill) and report
/// it; on failure, leave the sidecar untouched and report None.
/// Returns Some((amount, was_backfilled)) if known, None if unpriced.
fn process_image_sidecar(
    sidecar_path: &Path,
    prices: &HashMap<String, String>,
) -> AppResult<Option<(f64, bool)>> {
    let text = std::fs::read_to_string(sidecar_path)?;
    let mut value: Value = serde_json::from_str(&text)?;
    let obj = match value.as_object() {
        Some(o) => o,
        None => return Ok(None),
    };

    if let Some(existing) = obj.get("costUsd").and_then(|v| v.as_f64()) {
        return Ok(Some((existing, false)));
    }

    let provider = obj.get("provider").and_then(|v| v.as_str());
    let endpoint = match obj.get("endpoint").and_then(|v| v.as_str()) {
        Some(e) => e,
        None => return Ok(None),
    };
    let amount = match per_item_price(provider, endpoint, prices) {
        Some(a) => a,
        None => return Ok(None),
    };

    if let Some(map) = value.as_object_mut() {
        map.insert("costUsd".to_string(), serde_json::json!(amount));
    }
    write_json_atomic(sidecar_path, &value)?;
    Ok(Some((amount, true)))
}
