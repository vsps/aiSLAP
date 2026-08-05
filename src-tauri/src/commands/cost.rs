//! Project-wide cost aggregation: walks every image sidecar under a project,
//! backfills `costUsd` on older sidecars where a per-item fal price is now
//! cached, and rolls the totals up into shot/sequence sidecars plus a
//! project-wide grand total. Read-heavy; writes only sidecars that are
//! missing costUsd and can now be priced (idempotent and safe to re-run).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::commands::fsutil::{as_str, is_video_ext, sidecar_path, SEQUENCE_SIDECAR};
use crate::commands::session::with_shot_sidecar;
use crate::commands::walk;
use crate::db;
use crate::domain::{Config, SequenceSidecar, ShotSidecar};
use crate::error::{run_blocking, AppResult};
use crate::fsjson::{read_json_or_default, write_json_atomic};
use crate::pricing::{parse_duration_seconds, per_item_price, CostContext};

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
    let root = PathBuf::from(&project_path);
    let (scan, db_updates) = run_blocking(move || project_cost_scan_impl(project_path)).await?;
    // Push every freshly-backfilled cost into the local asset index — best
    // effort, same spirit as `recordAsset` on the TS side: this scan already
    // succeeded and the sidecars are already written, a DB push failure
    // here shouldn't fail the command the user is waiting on. One batched call:
    // this used to open, bootstrap and close the database once per asset.
    if let Err(e) = db::assets_cost_update(&root, &db_updates).await {
        tracing::warn!("cost scan: DB cost backfill failed: {e}");
    }
    Ok(scan)
}

fn project_cost_scan_impl(project_path: String) -> AppResult<(ProjectCostScan, CostDbUpdates)> {
    let root = PathBuf::from(&project_path);
    let config: Config = read_json_or_default(&crate::paths::config_path()?)?;
    let prices = config.fal_prices.unwrap_or_default();
    let overrides = config.price_overrides.unwrap_or_default();

    let mut project_total = 0.0f64;
    let mut project_known = 0u32;
    let mut project_unknown = 0u32;
    let mut project_backfilled = 0u32;
    let mut sequences: Vec<SequenceCost> = Vec::new();
    let mut db_updates: Vec<(String, f64)> = Vec::new();

    let walk = walk::project_walk(&root)?;

    for seq_dir in &walk.sequences {
        let seq_name = match seq_dir.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let mut seq_total = 0.0f64;
        let mut seq_known = 0u32;
        let mut seq_unknown = 0u32;
        let mut shots: Vec<ShotCost> = Vec::new();

        for shot in walk.shots(seq_dir)? {
            let shot_dir = shot.media_root;
            let (shot_total, shot_known, shot_unknown, shot_backfilled, shot_db_updates) =
                scan_shot_cost(&shot_dir, &prices, &overrides)?;
            db_updates.extend(shot_db_updates);

            with_shot_sidecar(&as_str(&shot_dir), |sidecar: &mut ShotSidecar| {
                sidecar.total_cost_usd = Some(shot_total);
                sidecar.known_image_count = Some(shot_known);
                sidecar.unknown_image_count = Some(shot_unknown);
            })?;

            shots.push(ShotCost {
                name: shot.shot_name,
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
            path: as_str(seq_dir),
            total_cost_usd: seq_total,
            known_image_count: seq_known,
            unknown_image_count: seq_unknown,
            shots,
        });
        project_total += seq_total;
        project_known += seq_known;
        project_unknown += seq_unknown;
    }

    Ok((
        ProjectCostScan {
            total_cost_usd: project_total,
            known_image_count: project_known,
            unknown_image_count: project_unknown,
            backfilled_count: project_backfilled,
            sequences,
        },
        db_updates,
    ))
}

/// (assetId, cost) for an asset whose sidecar cost was just backfilled —
/// pending push into the local asset index.
type CostDbUpdates = Vec<(String, f64)>;

/// Price every version-folder image under one shot, backfilling `costUsd` into
/// sidecars that lack it. Returns (total, known, unknown, backfilled,
/// db_updates).
///
/// A media file with no sidecar counts as `unknown` rather than being skipped —
/// the count is what tells the user the total is incomplete.
fn scan_shot_cost(
    shot_dir: &Path,
    prices: &HashMap<String, String>,
    overrides: &HashMap<String, f64>,
) -> AppResult<(f64, u32, u32, u32, CostDbUpdates)> {
    let mut total = 0.0f64;
    let mut known = 0u32;
    let mut unknown = 0u32;
    let mut backfilled = 0u32;
    let mut db_updates: Vec<(String, f64)> = Vec::new();

    for (_version, media_path) in walk::shot_media(shot_dir)? {
        let sidecar_path = sidecar_path(&media_path);
        if !sidecar_path.is_file() {
            unknown += 1;
            continue;
        }
        let is_video = is_video_ext(&media_path);
        match process_image_sidecar(&sidecar_path, prices, overrides, is_video) {
            Ok(Some(cost)) => {
                total += cost.amount;
                known += 1;
                if cost.backfilled {
                    backfilled += 1;
                    if let Some(id) = cost.asset_id {
                        db_updates.push((id, cost.amount));
                    }
                }
            }
            Ok(None) => unknown += 1,
            Err(e) => {
                tracing::warn!("cost scan: skipping {}: {e}", sidecar_path.display());
                unknown += 1;
            }
        }
    }
    Ok((total, known, unknown, backfilled, db_updates))
}

/// Outcome of pricing one image sidecar.
struct SidecarCost {
    amount: f64,
    backfilled: bool,
    /// The sidecar's `assetId`, if it has one — lets the caller push a
    /// freshly-backfilled cost straight into the local asset index.
    asset_id: Option<String>,
}

/// Read one image's `.json` sidecar. If `costUsd` is already present, trust
/// it as-is (never overwrite a previously-computed value, even if prices
/// have since changed). If absent, try to compute it from
/// provider+endpoint+prices; on success, write it back (backfill) and report
/// it; on failure, leave the sidecar untouched and report None.
fn process_image_sidecar(
    sidecar_path: &Path,
    prices: &HashMap<String, String>,
    overrides: &HashMap<String, f64>,
    is_video: bool,
) -> AppResult<Option<SidecarCost>> {
    let text = std::fs::read_to_string(sidecar_path)?;
    let mut value: Value = serde_json::from_str(&text)?;
    let obj = match value.as_object() {
        Some(o) => o,
        None => return Ok(None),
    };
    let asset_id = obj
        .get("assetId")
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(existing) = obj.get("costUsd").and_then(|v| v.as_f64()) {
        return Ok(Some(SidecarCost {
            amount: existing,
            backfilled: false,
            asset_id,
        }));
    }

    let provider = obj.get("provider").and_then(|v| v.as_str());
    let endpoint = match obj.get("endpoint").and_then(|v| v.as_str()) {
        Some(e) => e,
        None => return Ok(None),
    };
    let settings = obj.get("settings").and_then(|v| v.as_object());
    let resolution = settings
        .and_then(|s| s.get("resolution"))
        .and_then(|v| v.as_str());
    let duration_sec = settings.and_then(|s| s.get("duration")).and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(parse_duration_seconds))
    });
    // megapixels is None here — this is a retroactive, offline scan over
    // already-written sidecars; real dimension reading (see
    // media::image_dimensions_read) only happens at generation time in
    // output.ts. An area-billed model's pre-existing sidecar with no costUsd
    // stays unpriced through this path, same as before this field existed.
    let ctx = CostContext {
        is_video,
        duration_sec,
        resolution,
        megapixels: None,
    };
    let amount = match per_item_price(provider, endpoint, prices, overrides, &ctx) {
        Some(a) => a,
        None => return Ok(None),
    };

    if let Some(map) = value.as_object_mut() {
        map.insert("costUsd".to_string(), serde_json::json!(amount));
    }
    write_json_atomic(sidecar_path, &value)?;
    Ok(Some(SidecarCost {
        amount,
        backfilled: true,
        asset_id,
    }))
}
