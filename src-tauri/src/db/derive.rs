//! Derive a price table from what was actually charged.
//!
//! fal's pricing API reports **one price per endpoint, with no resolution
//! dimension** — so a model that really costs 2× at 1080p reports the 720p
//! number and nothing else. Modelling each vendor's formula only goes so far
//! (ByteDance's token maths is knowable; minimax's "compute seconds" is GPU
//! time and knowable by nobody), and every formula is another thing to keep
//! true as vendors change.
//!
//! This inverts the problem: group generations by (endpoint, resolution),
//! divide what fal billed by what was produced, and read the real rate off
//! the group. No vendor formula, no per-model configuration, and it prices
//! the models no formula can.
//!
//! **Only reconciled rows count.** `cost_usd_actual` marks a row whose cost
//! came from fal's billing ledger rather than our own estimate. Averaging
//! estimates would derive the price table from the price table — a number
//! that agrees with itself and nothing else — so an unreconciled row is
//! skipped entirely, and a sample count comes back with every proposal so
//! nobody has to trust a rate built from one generation.

use std::collections::HashMap;

use libsql::Connection;
use serde::{Deserialize, Serialize};

use super::trace::local_index_files;
use super::{db_err, local_db, open_remote};
use crate::commands::config::turso_config;
use crate::error::AppResult;

/// One proposed price, for one endpoint at one resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedPrice {
    pub endpoint: String,
    /// `None` when the generations carried no `resolution` setting — the
    /// proposal is then for the flat endpoint key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    /// The override key this writes to: `endpoint` or `endpoint::resolution`.
    pub key: String,
    /// `"video"` rates are per second (matching how an override is applied to
    /// video); everything else is per output.
    pub kind: String,
    /// Median rate — not the mean. One retried or partially-billed job would
    /// drag a mean and leave no trace; the median ignores it.
    pub rate: f64,
    /// Reconciled generations behind this figure.
    pub samples: u32,
    /// Cheapest and dearest sample. A wide spread means the group is mixing
    /// things the (endpoint, resolution) key doesn't separate — a duration
    /// the settings didn't record, say — and the median should be distrusted.
    pub min: f64,
    pub max: f64,
    /// Total actually billed across the samples, so the UI can show what the
    /// figure is standing on.
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedPricing {
    pub prices: Vec<DerivedPrice>,
    /// `"remote"` (the team's shared index) or `"local"` (this machine's
    /// project indexes).
    pub source: String,
    /// Rows with a cost that were skipped for not being reconciled — the
    /// number that tells a user why their table is thin.
    pub unreconciled: u32,
    /// Reconciled rows that still couldn't produce a rate: a video with no
    /// recorded duration, a non-positive cost.
    pub unusable: u32,
}

/// One reconciled generation, reduced to the rate it implies.
struct Sample {
    key: String,
    endpoint: String,
    resolution: Option<String>,
    kind: String,
    rate: f64,
    cost: f64,
}

/// Pull the rate out of one row. `None` when the row can't yield one.
fn sample_from(
    endpoint: Option<String>,
    kind: String,
    cost: Option<f64>,
    settings_json: Option<String>,
) -> Option<Sample> {
    let endpoint = endpoint.filter(|e| !e.is_empty())?;
    let cost = cost.filter(|c| c.is_finite() && *c > 0.0)?;

    let settings: serde_json::Value = settings_json
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    let resolution = settings
        .get("resolution")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);

    // Video overrides are applied as $/sec, so that is what has to be derived
    // — which needs the duration that produced this charge. A generation that
    // didn't record one can't be turned into a rate at all: dividing by a
    // guess would bake the guess into everyone's price sheet.
    let rate = if kind == "video" {
        let duration = settings
            .get("duration")
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(crate::pricing::parse_duration_seconds))
            })
            .filter(|d| d.is_finite() && *d > 0.0)?;
        cost / duration
    } else {
        cost
    };

    let key = match &resolution {
        Some(r) => format!("{endpoint}::{r}"),
        None => endpoint.clone(),
    };
    Some(Sample {
        key,
        endpoint,
        resolution,
        kind,
        rate,
        cost,
    })
}

fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

/// Read every reconciled generation from one index and reduce it to samples.
async fn collect(conn: &Connection, out: &mut Vec<Sample>, report: &mut DerivedPricing) {
    // `cost_usd_actual = 1` is the whole point — see the module docs.
    let Ok(mut rows) = conn
        .query(
            "SELECT endpoint, kind, cost_usd, settings_json, COALESCE(cost_usd_actual, 0) \
             FROM assets WHERE deleted_at IS NULL AND cost_usd IS NOT NULL",
            (),
        )
        .await
    else {
        return;
    };
    while let Ok(Some(row)) = rows.next().await {
        let endpoint = row.get::<Option<String>>(0).unwrap_or(None);
        let kind = row.get::<String>(1).unwrap_or_default();
        let cost = row.get::<Option<f64>>(2).unwrap_or(None);
        let settings = row.get::<Option<String>>(3).unwrap_or(None);
        let actual = row.get::<i64>(4).unwrap_or(0) != 0;

        if !actual {
            report.unreconciled += 1;
            continue;
        }
        match sample_from(endpoint, kind, cost, settings) {
            Some(s) => out.push(s),
            None => report.unusable += 1,
        }
    }
}

/// Derive per-resolution rates from real spend.
///
/// Prefers the shared remote index — that is what makes the table reflect the
/// whole team's spend rather than one machine's — and falls back to every
/// local project index when no Turso is configured.
pub async fn pricing_derive() -> AppResult<DerivedPricing> {
    let mut report = DerivedPricing::default();
    let mut samples: Vec<Sample> = Vec::new();

    if let Some((url, token)) = turso_config()? {
        let conn = open_remote(url, token).await?;
        report.source = "remote".to_string();
        collect(&conn, &mut samples, &mut report).await;
    } else {
        report.source = "local".to_string();
        for file in local_index_files()? {
            match local_db(&file)
                .await
                .and_then(|db| db.connect().map_err(db_err))
            {
                Ok(conn) => collect(&conn, &mut samples, &mut report).await,
                Err(e) => tracing::warn!("derive: skipping index {}: {e}", file.display()),
            }
        }
    }

    let mut grouped: HashMap<String, Vec<Sample>> = HashMap::new();
    for s in samples {
        grouped.entry(s.key.clone()).or_default().push(s);
    }

    for (key, group) in grouped {
        let mut rates: Vec<f64> = group.iter().map(|s| s.rate).collect();
        rates.sort_by(|a, b| a.partial_cmp(b).expect("rates are finite"));
        let head = &group[0];
        report.prices.push(DerivedPrice {
            endpoint: head.endpoint.clone(),
            resolution: head.resolution.clone(),
            key,
            kind: head.kind.clone(),
            rate: median(&rates),
            samples: group.len() as u32,
            min: rates[0],
            max: rates[rates.len() - 1],
            total_cost_usd: group.iter().map(|s| s.cost).sum(),
        });
    }

    // Best-evidenced first: a rate built on 40 generations should not be
    // buried under one built on 1, whatever they happen to be called.
    report.prices.sort_by(|a, b| {
        b.samples
            .cmp(&a.samples)
            .then_with(|| a.endpoint.cmp(&b.endpoint))
            .then_with(|| a.key.cmp(&b.key))
    });
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(res: Option<&str>, duration: Option<&str>) -> Option<String> {
        let mut map = serde_json::Map::new();
        if let Some(r) = res {
            map.insert("resolution".into(), serde_json::json!(r));
        }
        if let Some(d) = duration {
            map.insert("duration".into(), serde_json::json!(d));
        }
        Some(serde_json::Value::Object(map).to_string())
    }

    #[test]
    fn video_rate_is_per_second_and_keyed_by_resolution() {
        let s = sample_from(
            Some("bytedance/seedance-2.0/text-to-video".into()),
            "video".into(),
            Some(1.512),
            settings(Some("720p"), Some("5")),
        )
        .unwrap();
        assert_eq!(s.key, "bytedance/seedance-2.0/text-to-video::720p");
        assert!((s.rate - 0.3024).abs() < 1e-9, "{}", s.rate);
    }

    #[test]
    fn image_rate_is_the_charge_itself() {
        let s = sample_from(
            Some("fal-ai/nano-banana-2".into()),
            "image".into(),
            Some(0.16),
            settings(Some("4K"), None),
        )
        .unwrap();
        assert_eq!(s.key, "fal-ai/nano-banana-2::4K");
        assert_eq!(s.rate, 0.16);
    }

    #[test]
    fn video_without_a_recorded_duration_yields_no_rate() {
        // Dividing by a guessed duration would bake the guess into the whole
        // team's price sheet.
        assert!(sample_from(
            Some("vid".into()),
            "video".into(),
            Some(2.0),
            settings(Some("720p"), None),
        )
        .is_none());
    }

    #[test]
    fn a_zero_or_missing_charge_is_not_a_rate() {
        assert!(sample_from(Some("x".into()), "image".into(), Some(0.0), None).is_none());
        assert!(sample_from(Some("x".into()), "image".into(), None, None).is_none());
        assert!(sample_from(None, "image".into(), Some(1.0), None).is_none());
    }

    #[test]
    fn no_resolution_setting_proposes_the_flat_endpoint_key() {
        let s = sample_from(
            Some("fal-ai/flux/dev".into()),
            "image".into(),
            Some(0.05),
            None,
        )
        .unwrap();
        assert_eq!(s.key, "fal-ai/flux/dev");
        assert!(s.resolution.is_none());
    }

    #[test]
    fn median_ignores_a_single_outlier() {
        // Four ordinary generations and one that billed 10x — a mean would
        // land at 2.2, well outside anything actually charged.
        assert_eq!(median(&[0.3, 0.3, 0.3, 0.3, 10.0]), 0.3);
        // Even length averages the middle pair.
        assert!((median(&[0.2, 0.4]) - 0.3).abs() < 1e-9);
    }
}
