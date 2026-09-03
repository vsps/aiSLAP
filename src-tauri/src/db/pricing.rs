//! The shared price sheet: fal's fetched per-endpoint prices and the manual
//! per-endpoint overrides, kept in the Turso database so a team works from one
//! set of numbers instead of each machine's private `config.json`.
//!
//! **Remote-only, and app-global.** Unlike everything else in `db/`, this is
//! not scoped to a project — a price belongs to an endpoint, not to a job — so
//! these functions open the remote directly from `turso_config()` and never
//! touch a project's local index. `config.json` keeps its copy as the offline
//! cache: with no Turso configured, or with it unreachable, the app behaves
//! exactly as it did before.
//!
//! **Last write wins, per row.** Every entry is one row keyed by
//! (scope, key), and a push is a plain upsert — whoever fetched or typed most
//! recently is what everyone else reads next. Deliberately *not* a
//! whole-table replace: two people editing different overrides in the same
//! hour must not delete each other's work, which a "push my entire map" model
//! would do the moment one of them had a stale copy. Clearing an override is
//! therefore its own explicit delete (`pricing_forget`) rather than an
//! absence.

use std::collections::HashMap;

use libsql::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{db_err, open_remote};
use crate::commands::config::turso_config;
use crate::commands::system::system_username;
use crate::error::AppResult;

/// `scope` values. Two kinds of number share one table because they are one
/// subject — "what does this endpoint cost" — read together, written together,
/// and meaningless apart.
const SCOPE_PRICE: &str = "fal_price";
const SCOPE_OVERRIDE: &str = "override";

/// Created on the remote alongside the rest of the shared schema. `value` is
/// TEXT for both scopes: a fal price is already the `"$0.014 per units"`
/// string every consumer parses, and storing an override as text rather than
/// REAL keeps one column doing one job — it is parsed back on read, and a row
/// that fails to parse is skipped rather than poisoning the sheet.
pub(super) const SCHEMA_PRICING: &[&str] = &["CREATE TABLE IF NOT EXISTS pricing (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (scope, key)
    )"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedPricing {
    /// Endpoint → fal price string, e.g. `"$0.05 per megapixel"`.
    pub prices: HashMap<String, String>,
    /// `endpoint` or `endpoint::resolution` → dollars.
    pub overrides: HashMap<String, f64>,
    /// Most recent `updated_at` across every row — what the UI shows as the
    /// sheet's age. `None` for an empty sheet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Who last wrote the row that `updated_at` came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

async fn remote() -> AppResult<Option<Connection>> {
    let Some((url, token)) = turso_config()? else {
        return Ok(None);
    };
    Ok(Some(open_remote(url, token).await?))
}

/// Read the shared sheet. `Ok(None)` — not an error — when no Turso is
/// configured, which is the signal for the caller to stay on its local cache.
pub async fn pricing_pull() -> AppResult<Option<SharedPricing>> {
    let Some(conn) = remote().await? else {
        return Ok(None);
    };
    let mut rows = conn
        .query(
            "SELECT scope, key, value, updated_at, updated_by FROM pricing",
            (),
        )
        .await
        .map_err(db_err)?;

    let mut out = SharedPricing::default();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let scope: String = row.get(0).map_err(db_err)?;
        let key: String = row.get(1).map_err(db_err)?;
        let value: String = row.get(2).map_err(db_err)?;
        let updated_at: String = row.get(3).map_err(db_err)?;
        let updated_by: Option<String> = row.get(4).map_err(db_err)?;

        match scope.as_str() {
            SCOPE_PRICE => {
                out.prices.insert(key, value);
            }
            SCOPE_OVERRIDE => {
                // A row that won't parse is one bad edit, not a broken sheet.
                if let Ok(n) = value.parse::<f64>() {
                    if n.is_finite() {
                        out.overrides.insert(key, n);
                    }
                }
            }
            _ => continue,
        }

        // RFC3339 sorts lexicographically, so "newest row" is a string compare.
        if out
            .updated_at
            .as_deref()
            .is_none_or(|cur| cur < &*updated_at)
        {
            out.updated_at = Some(updated_at);
            out.updated_by = updated_by;
        }
    }
    Ok(Some(out))
}

/// Upsert prices and/or overrides. Returns the number of rows written, or
/// `None` when no Turso is configured.
pub async fn pricing_push(
    prices: HashMap<String, String>,
    overrides: HashMap<String, f64>,
) -> AppResult<Option<u32>> {
    let Some(conn) = remote().await? else {
        return Ok(None);
    };
    let now = chrono::Utc::now().to_rfc3339();
    let by = system_username();

    // One transaction: a half-written price sheet is a set of numbers that
    // never existed together, and a fetch pushes 50-odd rows at a time.
    let tx = conn.transaction().await.map_err(db_err)?;
    let mut written = 0u32;
    for (key, value) in prices {
        upsert_row(&tx, SCOPE_PRICE, &key, &value, &now, &by).await?;
        written += 1;
    }
    for (key, amount) in overrides {
        upsert_row(&tx, SCOPE_OVERRIDE, &key, &amount.to_string(), &now, &by).await?;
        written += 1;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(Some(written))
}

/// Drop one override from the sheet — the explicit counterpart to clearing
/// the field locally. Without this, an absence in a pushed map would be
/// indistinguishable from a key the pusher simply hadn't fetched yet.
pub async fn pricing_forget(key: String) -> AppResult<Option<bool>> {
    let Some(conn) = remote().await? else {
        return Ok(None);
    };
    let removed = conn
        .execute(
            "DELETE FROM pricing WHERE scope = ?1 AND key = ?2",
            params!(SCOPE_OVERRIDE.to_string(), key),
        )
        .await
        .map_err(db_err)?;
    Ok(Some(removed > 0))
}

async fn upsert_row(
    conn: &Connection,
    scope: &str,
    key: &str,
    value: &str,
    now: &str,
    by: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO pricing (scope, key, value, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(scope, key) DO UPDATE SET
           value=excluded.value, updated_at=excluded.updated_at,
           updated_by=excluded.updated_by",
        params!(
            scope.to_string(),
            key.to_string(),
            value.to_string(),
            now.to_string(),
            by.to_string()
        ),
    )
    .await
    .map_err(db_err)?;
    Ok(())
}
