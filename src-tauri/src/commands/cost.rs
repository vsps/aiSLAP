//! Project-wide cost aggregation: walks every image sidecar under a project,
//! backfills `costUsd` on older sidecars where a per-item fal price is now
//! cached, and rolls the totals up into shot/sequence sidecars plus a
//! project-wide grand total. Read-heavy; writes only sidecars that are
//! missing costUsd and can now be priced (idempotent and safe to re-run).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::config::provider_key_get;
use crate::commands::fsutil::{as_str, is_video_ext, sidecar_path, SEQUENCE_SIDECAR, SHOT_SIDECAR};
use crate::commands::session::with_shot_sidecar;
use crate::commands::walk;
use crate::db;
use crate::domain::{Config, SequenceSidecar, ShotSidecar};
use crate::error::{run_blocking, AppError, AppResult};
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

/// Cheap, read-only reload of the *last* computed cost scan — reads the
/// per-shot totals `project_cost_scan` already persisted into each shot's
/// `shot.json` (see the `with_shot_sidecar` write above), without re-walking
/// every image, touching fal prices, or writing anything. This is what lets
/// the UI show real numbers the moment a project opens instead of "not yet
/// calculated" until the user re-clicks Recalculate every session. A shot
/// never scanned (no cost fields in its sidecar yet) contributes zero, same
/// as an empty one — `project_cost_scan` remains the only way to actually
/// price/backfill anything.
#[tauri::command]
pub async fn project_cost_scan_cached(project_path: String) -> AppResult<ProjectCostScan> {
    run_blocking(move || project_cost_scan_cached_impl(project_path)).await
}

fn project_cost_scan_cached_impl(project_path: String) -> AppResult<ProjectCostScan> {
    let root = PathBuf::from(&project_path);
    let walk = walk::project_walk(&root)?;

    let mut project_total = 0.0f64;
    let mut project_known = 0u32;
    let mut project_unknown = 0u32;
    let mut sequences: Vec<SequenceCost> = Vec::new();

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
            let sidecar: ShotSidecar = read_json_or_default(&shot_dir.join(SHOT_SIDECAR))?;
            let shot_total = sidecar.total_cost_usd.unwrap_or(0.0);
            let shot_known = sidecar.known_image_count.unwrap_or(0);
            let shot_unknown = sidecar.unknown_image_count.unwrap_or(0);

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
        }

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

    Ok(ProjectCostScan {
        total_cost_usd: project_total,
        known_image_count: project_known,
        unknown_image_count: project_unknown,
        backfilled_count: 0,
        sequences,
    })
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

// ----- per-image cost report (project_cost_lines) -----
//
// A flat, per-image view for the Reports UI — every media file under the
// project gets one row, filterable/aggregatable client-side (by user, by
// model, into a Sankey breakdown). Deliberately read-only: it trusts an
// existing `costUsd` and reports `None` otherwise, never calls
// `per_item_price` or writes a sidecar. Recalculate (`project_cost_scan`
// above) already owns backfilling costUsd; having a second code path
// compute "the" estimate here risks the two disagreeing if pricing config
// changes between calls in the same session.

/// One row per media file (priced or not). Sequence/shot/version names are
/// not globally unique across a project, so `shot_key` ("<sequence>/<shot>")
/// is precomputed here — the frontend derives a version-level key from it
/// the same way — giving Sankey node ids that never collide across
/// sequences that happen to share a shot or version name.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CostReportLine {
    /// The sidecar's assetId when present, else the media file's path
    /// relative to the project root (forward-slash) — always unique either way.
    pub id: String,
    pub sequence: String,
    pub shot: String,
    pub shot_key: String,
    pub version: String,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub model: Option<String>,
    pub generated_by: Option<String>,
    /// None = no sidecar, an unparsable one, or one with no costUsd yet.
    pub cost_usd: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCostReport {
    pub generated_at: String,
    pub lines: Vec<CostReportLine>,
}

#[tauri::command]
pub async fn project_cost_lines(project_path: String) -> AppResult<ProjectCostReport> {
    run_blocking(move || project_cost_lines_impl(project_path)).await
}

fn project_cost_lines_impl(project_path: String) -> AppResult<ProjectCostReport> {
    let root = PathBuf::from(&project_path);
    let mut lines = Vec::new();
    let walk = walk::project_walk(&root)?;

    for seq_dir in &walk.sequences {
        let Some(seq_name) = seq_dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        for shot in walk.shots(seq_dir)? {
            for (version_dir, media_path) in walk::shot_media(&shot.media_root)? {
                let version_name = version_dir
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                let rel_id = media_path
                    .strip_prefix(&root)
                    .unwrap_or(&media_path)
                    .to_string_lossy()
                    .replace('\\', "/");

                let mut line = CostReportLine {
                    id: rel_id,
                    sequence: seq_name.to_string(),
                    shot: shot.shot_name.clone(),
                    shot_key: format!("{seq_name}/{}", shot.shot_name),
                    version: version_name,
                    provider: None,
                    model_id: None,
                    model: None,
                    generated_by: None,
                    cost_usd: None,
                };

                let sc_path = sidecar_path(&media_path);
                if let Ok(text) = std::fs::read_to_string(&sc_path) {
                    if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&text) {
                        line.provider = obj.get("provider").and_then(|v| v.as_str()).map(String::from);
                        line.model_id = obj.get("modelId").and_then(|v| v.as_str()).map(String::from);
                        line.model = obj.get("model").and_then(|v| v.as_str()).map(String::from);
                        line.generated_by =
                            obj.get("generatedBy").and_then(|v| v.as_str()).map(String::from);
                        line.cost_usd = obj.get("costUsd").and_then(|v| v.as_f64());
                        if let Some(id) = obj.get("assetId").and_then(|v| v.as_str()) {
                            line.id = id.to_string();
                        }
                    }
                }

                lines.push(line);
            }
        }
    }

    Ok(ProjectCostReport {
        generated_at: Utc::now().to_rfc3339(),
        lines,
    })
}

// ----- actual-cost reconciliation (fal billing-events) -----
//
// Everything above prices images from published/estimated unit prices —
// `costUsd` is always a computation, never a number fal actually charged.
// This reconciles it against fal's own billing ledger
// (https://fal.ai/docs/platform-apis/v1/models/billing-events), keyed by the
// `falRequestId` output.ts stamps onto every fal-generated sidecar. A sidecar
// already marked `costUsdActual: true` is left alone — once we have a real
// charge for a request we never overwrite it with a later estimate.

const BILLING_EVENTS_URL: &str = "https://api.fal.ai/v1/models/billing-events";
const MAX_REQUEST_IDS_PER_CALL: usize = 50;
/// Kept under the documented 90-day cap with room for the ±1-day pad added
/// around each batch's timestamp span.
const MAX_BATCH_SPAN_DAYS: i64 = 85;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileCostResult {
    /// Distinct fal request ids looked up.
    pub checked: u32,
    /// Sidecars whose costUsd was updated to a real billed amount.
    pub reconciled: u32,
    /// Requests fal's billing-events API had no record for yet (most likely
    /// billing lag — safe to re-run the reconcile later).
    pub unavailable: u32,
}

#[derive(Clone)]
struct PendingReconcile {
    sidecar_path: PathBuf,
    request_id: String,
    asset_id: Option<String>,
    timestamp: DateTime<Utc>,
}

#[derive(Deserialize)]
struct BillingEventsPage {
    #[serde(default)]
    billing_events: Vec<BillingEvent>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct BillingEvent {
    request_id: String,
    cost_total: f64,
}

/// Reconcile every fal-generated sidecar under `project_path` that has a
/// `falRequestId` but no confirmed `costUsdActual` against fal's real billing
/// ledger. Requires a fal key scoped for the billing-events endpoint (fal
/// docs call this an "admin" key) — a regular generation key may 401/403,
/// which surfaces as an error rather than silently leaving costs unreconciled.
#[tauri::command]
pub async fn reconcile_actual_costs(project_path: String) -> AppResult<ReconcileCostResult> {
    let api_key = provider_key_get("fal".to_string())?;
    if api_key.is_empty() {
        return Err(AppError::Msg(
            "fal API key not configured — open Settings.".into(),
        ));
    }

    let root = PathBuf::from(&project_path);
    let pending = run_blocking(move || collect_pending_reconciles(&root)).await?;
    if pending.is_empty() {
        return Ok(ReconcileCostResult {
            checked: 0,
            reconciled: 0,
            unavailable: 0,
        });
    }

    let checked = pending
        .iter()
        .map(|p| p.request_id.as_str())
        .collect::<HashSet<_>>()
        .len() as u32;

    let costs = fetch_billing_costs(&api_key, &pending).await?;

    let root2 = PathBuf::from(&project_path);
    let (db_updates, reconciled) =
        run_blocking(move || write_reconciled_costs(pending, costs)).await?;

    if let Err(e) = db::assets_cost_update(&root2, &db_updates).await {
        tracing::warn!("cost reconcile: DB cost update failed: {e}");
    }

    Ok(ReconcileCostResult {
        checked,
        reconciled,
        unavailable: checked.saturating_sub(reconciled),
    })
}

/// Walk every sidecar in the project looking for a fal request id awaiting
/// reconciliation. A missing/unparsable `timestamp` falls back to "now" —
/// only affects which query batch it lands in, never correctness.
fn collect_pending_reconciles(root: &Path) -> AppResult<Vec<PendingReconcile>> {
    let mut out = Vec::new();
    let walk = walk::project_walk(root)?;
    for seq_dir in &walk.sequences {
        for shot in walk.shots(seq_dir)? {
            for (_version, media_path) in walk::shot_media(&shot.media_root)? {
                let sc_path = sidecar_path(&media_path);
                let Ok(text) = std::fs::read_to_string(&sc_path) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let Some(obj) = value.as_object() else {
                    continue;
                };
                if obj.get("costUsdActual").and_then(|v| v.as_bool()) == Some(true) {
                    continue;
                }
                let Some(request_id) = obj.get("falRequestId").and_then(|v| v.as_str()) else {
                    continue;
                };
                let asset_id = obj
                    .get("assetId")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let timestamp = obj
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(Utc::now);
                out.push(PendingReconcile {
                    sidecar_path: sc_path,
                    request_id: request_id.to_string(),
                    asset_id,
                    timestamp,
                });
            }
        }
    }
    Ok(out)
}

/// Group distinct request ids into query batches that respect both fal's
/// 50-id-per-call limit and its 90-day date-range cap — batches are built
/// from ids sorted by timestamp, closing whichever limit is hit first.
fn build_batches(pending: &[PendingReconcile]) -> Vec<(Vec<String>, DateTime<Utc>, DateTime<Utc>)> {
    let mut earliest: HashMap<&str, DateTime<Utc>> = HashMap::new();
    for p in pending {
        earliest
            .entry(p.request_id.as_str())
            .and_modify(|t| *t = (*t).min(p.timestamp))
            .or_insert(p.timestamp);
    }
    let mut ids: Vec<(String, DateTime<Utc>)> = earliest
        .into_iter()
        .map(|(id, ts)| (id.to_string(), ts))
        .collect();
    ids.sort_by_key(|(_, ts)| *ts);

    let mut batches = Vec::new();
    let mut cur_ids: Vec<String> = Vec::new();
    let mut cur_min: Option<DateTime<Utc>> = None;
    let mut cur_max: Option<DateTime<Utc>> = None;

    for (id, ts) in ids {
        let exceeds_count = cur_ids.len() >= MAX_REQUEST_IDS_PER_CALL;
        let exceeds_span = cur_min.is_some_and(|min| (ts - min).num_days() > MAX_BATCH_SPAN_DAYS);
        if !cur_ids.is_empty() && (exceeds_count || exceeds_span) {
            batches.push((
                std::mem::take(&mut cur_ids),
                cur_min.take().unwrap(),
                cur_max.take().unwrap(),
            ));
        }
        cur_min = Some(cur_min.map_or(ts, |m| m.min(ts)));
        cur_max = Some(cur_max.map_or(ts, |m| m.max(ts)));
        cur_ids.push(id);
    }
    if !cur_ids.is_empty() {
        batches.push((cur_ids, cur_min.unwrap(), cur_max.unwrap()));
    }
    batches
}

/// Query fal's billing-events API for every pending request id, batched per
/// `build_batches`. Never partially fails silently: a chunk that 401/403s
/// (wrong key scope) or otherwise errors aborts the whole reconcile with a
/// message the user can act on, rather than reporting a misleadingly low
/// `unavailable` count.
async fn fetch_billing_costs(
    api_key: &str,
    pending: &[PendingReconcile],
) -> AppResult<HashMap<String, f64>> {
    let client = reqwest::Client::new();
    let mut out: HashMap<String, f64> = HashMap::new();
    let now = Utc::now();

    for (ids, min_ts, max_ts) in build_batches(pending) {
        let start = min_ts - Duration::days(1);
        let end = std::cmp::min(max_ts + Duration::days(1), now + Duration::hours(1));

        let mut cursor: Option<String> = None;
        loop {
            let mut url = reqwest::Url::parse(BILLING_EVENTS_URL)
                .map_err(|e| AppError::Msg(format!("billing-events URL: {e}")))?;
            {
                let mut qp = url.query_pairs_mut();
                qp.append_pair("request_id", &ids.join(","));
                qp.append_pair("start", &start.to_rfc3339());
                qp.append_pair("end", &end.to_rfc3339());
                qp.append_pair("limit", "1000");
                if let Some(c) = &cursor {
                    qp.append_pair("cursor", c);
                }
            }

            let res = client
                .get(url)
                .header("Authorization", format!("Key {api_key}"))
                .send()
                .await
                .map_err(|e| AppError::Msg(format!("fal billing-events request: {e}")))?;

            if !res.status().is_success() {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                return Err(AppError::Msg(format!(
                    "fal billing-events API: HTTP {status} — {}. This endpoint needs a fal key with billing-events access.",
                    body.chars().take(300).collect::<String>()
                )));
            }

            let text = res
                .text()
                .await
                .map_err(|e| AppError::Msg(format!("billing-events body: {e}")))?;
            let page: BillingEventsPage = serde_json::from_str(&text)
                .map_err(|e| AppError::Msg(format!("billing-events JSON: {e}")))?;

            for ev in page.billing_events {
                out.insert(ev.request_id, ev.cost_total);
            }

            cursor = if page.has_more { page.next_cursor } else { None };
            if cursor.is_none() {
                break;
            }
        }
    }

    Ok(out)
}

/// Write real costs back into their sidecars. A request id with multiple
/// output files (a batch job) divides its `cost_total` evenly across every
/// pending sidecar that shares it — the same apportioning output.ts already
/// does at write time with the estimate, just with the real total now that
/// it's known. Request ids fal's ledger has no event for yet are left
/// untouched (`costUsd` stays the earlier estimate) so a later re-run can
/// pick them up once billing catches up.
fn write_reconciled_costs(
    pending: Vec<PendingReconcile>,
    costs: HashMap<String, f64>,
) -> AppResult<(Vec<(String, f64)>, u32)> {
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for p in &pending {
        *counts.entry(p.request_id.as_str()).or_insert(0) += 1;
    }

    let mut db_updates = Vec::new();
    let mut reconciled = 0u32;

    for p in &pending {
        let Some(&total) = costs.get(&p.request_id) else {
            continue;
        };
        let count = *counts.get(p.request_id.as_str()).unwrap_or(&1) as f64;
        let amount = total / count;

        let Ok(text) = std::fs::read_to_string(&p.sidecar_path) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(map) = value.as_object_mut() else {
            continue;
        };
        map.insert("costUsd".to_string(), serde_json::json!(amount));
        map.insert("costUsdActual".to_string(), serde_json::json!(true));
        if write_json_atomic(&p.sidecar_path, &value).is_err() {
            continue;
        }

        reconciled += 1;
        if let Some(id) = &p.asset_id {
            db_updates.push((id.clone(), amount));
        }
    }

    Ok((db_updates, reconciled))
}

#[cfg(test)]
mod cost_lines_tests {
    use super::*;
    use crate::testutil::TestProject;

    #[test]
    fn one_row_per_media_file_native_project() {
        let p = TestProject::new("cost-lines-native");
        p.media(
            "seq1/shot1/gen001/a.png",
            Some(serde_json::json!({
                "provider": "fal",
                "modelId": "fal-ai/foo",
                "model": "Foo",
                "generatedBy": "alice",
                "costUsd": 0.05,
                "assetId": "asset-a",
            })),
        );
        // No sidecar at all — still counted, just unpriced.
        p.media("seq1/shot1/gen001/b.png", None);

        let report = project_cost_lines_impl(p.root_str()).unwrap();
        assert_eq!(report.lines.len(), 2);

        let a = report.lines.iter().find(|l| l.id == "asset-a").unwrap();
        assert_eq!(a.sequence, "seq1");
        assert_eq!(a.shot, "shot1");
        assert_eq!(a.shot_key, "seq1/shot1");
        assert_eq!(a.version, "gen001");
        assert_eq!(a.model_id.as_deref(), Some("fal-ai/foo"));
        assert_eq!(a.generated_by.as_deref(), Some("alice"));
        assert_eq!(a.cost_usd, Some(0.05));

        let b = report
            .lines
            .iter()
            .find(|l| l.id != "asset-a")
            .expect("sidecar-less file still gets a row");
        assert_eq!(b.shot_key, "seq1/shot1");
        assert_eq!(b.cost_usd, None);
        assert!(b.id.ends_with("b.png"), "falls back to rel path: {}", b.id);
    }

    #[test]
    fn resolves_prism_layout_sequence_and_shot() {
        let p = TestProject::prism("cost-lines-prism");
        p.media(
            "03_Production/Shots/MOD/s0010/Renders/AI/v0001/a.png",
            Some(serde_json::json!({ "costUsd": 1.5 })),
        );

        let report = project_cost_lines_impl(p.root_str()).unwrap();
        assert_eq!(report.lines.len(), 1);
        assert_eq!(report.lines[0].shot, "s0010");
        assert_eq!(report.lines[0].version, "v0001");
        assert_eq!(report.lines[0].cost_usd, Some(1.5));
    }

    #[test]
    fn cached_scan_reads_persisted_totals_without_a_fresh_walk() {
        let p = TestProject::new("cost-cached");
        p.media("seq1/shot1/gen001/a.png", None);
        with_shot_sidecar(&p.root.join("seq1/shot1").to_string_lossy(), |s| {
            s.total_cost_usd = Some(2.5);
            s.known_image_count = Some(1);
            s.unknown_image_count = Some(0);
        })
        .unwrap();

        let scan = project_cost_scan_cached_impl(p.root_str()).unwrap();
        assert_eq!(scan.total_cost_usd, 2.5);
        assert_eq!(scan.known_image_count, 1);
        assert_eq!(scan.sequences[0].shots[0].total_cost_usd, 2.5);
    }

    #[test]
    fn cached_scan_of_a_never_scanned_shot_is_zero_not_an_error() {
        let p = TestProject::new("cost-cached-empty");
        p.media("seq1/shot1/gen001/a.png", None);

        let scan = project_cost_scan_cached_impl(p.root_str()).unwrap();
        assert_eq!(scan.total_cost_usd, 0.0);
        assert_eq!(scan.known_image_count, 0);
        assert_eq!(scan.unknown_image_count, 0);
    }
}
