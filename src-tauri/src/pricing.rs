//! Pure fal price-string parsing, ported from src/lib/falPrices.ts
//! (parseFalPrice/isPerItemUnit/perItemPrice). Keep in sync if that file's
//! parsing rules change.

use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

pub struct ParsedPrice {
    pub amount: f64,
    pub unit: String,
}

fn price_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\$\s*(\d+(?:\.\d+)?)(?:[^.,]*?\bper\s+([^,.]+))?").unwrap())
}

/// Extract the first "$X per <unit>" from a price string. Mirrors
/// parseFalPrice() in falPrices.ts.
pub fn parse_fal_price(text: &str) -> Option<ParsedPrice> {
    let caps = price_re().captures(text)?;
    let amount: f64 = caps.get(1)?.as_str().parse().ok()?;
    if !amount.is_finite() {
        return None;
    }
    let unit = caps
        .get(2)
        .map(|m| m.as_str().trim().to_lowercase())
        .unwrap_or_default();
    Some(ParsedPrice { amount, unit })
}

/// Units where one billed unit == one output. Mirrors isPerItemUnit():
/// /^(request|image|video|unit|generation)s?\b/i
pub fn is_per_item_unit(unit: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(request|image|video|unit|generation)s?\b").unwrap())
        .is_match(unit)
}

/// Seconds-billed units — almost every video model. Distinct from
/// is_per_item_unit() because the total depends on the output's actual
/// duration. Mirrors isPerSecondUnit().
pub fn is_per_second_unit(unit: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^sec(ond)?s?\b").unwrap())
        .is_match(unit)
}

/// Area-billed units (fal's official pricing API reports "megapixels" for
/// e.g. the FLUX family and Topaz image upscale) — distinct from
/// is_per_item_unit()/is_per_second_unit() because the total depends on the
/// output's actual pixel dimensions, not a flat amount or a duration.
/// Mirrors isPerAreaUnit().
pub fn is_per_area_unit(unit: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^megapixels?\b").unwrap())
        .is_match(unit)
}

/// Parse a `duration` setting value (already extracted to a plain string,
/// e.g. "8", "8s") to seconds. Mirrors parseDurationSeconds(); non-numeric
/// values (e.g. seedance-2's "auto") return None.
pub fn parse_duration_seconds(raw: &str) -> Option<f64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let m = RE
        .get_or_init(|| Regex::new(r"^(\d+(?:\.\d+)?)").unwrap())
        .captures(raw)?;
    let n: f64 = m.get(1)?.as_str().parse().ok()?;
    n.is_finite().then_some(n)
}

/// Per-generation cost inputs beyond provider/endpoint — everything needed
/// to resolve a per-resolution or per-second price. Mirrors CostContext in
/// falPrices.ts.
pub struct CostContext<'a> {
    pub is_video: bool,
    pub duration_sec: Option<f64>,
    pub resolution: Option<&'a str>,
    /// Actual output pixel count / 1,000,000, for area-billed units (see
    /// is_per_area_unit). Measured from the real output file, never guessed
    /// from a named size preset — `None` when unknown (e.g. not yet wired up
    /// for this call site, or the file's dimensions couldn't be read).
    pub megapixels: Option<f64>,
}

/// Per-output price for one endpoint. A user-entered override always wins
/// when present — it's the only way to price non-fal models, or a specific
/// resolution, since only fal has a pricing API and only at the model level.
/// For video, both an override and a fetched price are interpreted as $/sec
/// and multiplied by `ctx.duration_sec`; without a known duration a
/// per-second price can't be resolved to a total (None). Mirrors perItemPrice().
pub fn per_item_price(
    provider: Option<&str>,
    endpoint: &str,
    prices: &HashMap<String, String>,
    overrides: &HashMap<String, f64>,
    ctx: &CostContext,
) -> Option<f64> {
    let override_amount = ctx
        .resolution
        .and_then(|r| overrides.get(&format!("{endpoint}::{r}")))
        .or_else(|| overrides.get(endpoint))
        .copied();
    if let Some(amount) = override_amount {
        if amount.is_finite() {
            if !ctx.is_video {
                return Some(amount);
            }
            return ctx.duration_sec.map(|d| amount * d);
        }
    }
    if provider.unwrap_or("fal") != "fal" {
        return None;
    }
    let text = ctx
        .resolution
        .and_then(|r| prices.get(&format!("{endpoint}::{r}")))
        .or_else(|| prices.get(endpoint))?;
    let parsed = parse_fal_price(text)?;
    if is_per_item_unit(&parsed.unit) {
        return Some(parsed.amount);
    }
    if ctx.is_video && is_per_second_unit(&parsed.unit) {
        return ctx.duration_sec.map(|d| parsed.amount * d);
    }
    if is_per_area_unit(&parsed.unit) {
        return ctx.megapixels.map(|mp| parsed.amount * mp);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_per_request() {
        let p = parse_fal_price("$0.005 per request").unwrap();
        assert!((p.amount - 0.005).abs() < 1e-9);
        assert_eq!(p.unit, "request");
    }

    #[test]
    fn parses_text_with_extra_words_before_unit() {
        let p = parse_fal_price("Your request will cost $0.03 per image generated").unwrap();
        assert!((p.amount - 0.03).abs() < 1e-9);
        assert_eq!(p.unit, "image generated");
    }

    #[test]
    fn rejects_time_based_units() {
        let p = parse_fal_price("$0.002 per second").unwrap();
        assert!(!is_per_item_unit(&p.unit));
        assert!(is_per_second_unit(&p.unit));
    }

    #[test]
    fn parses_duration_variants() {
        assert_eq!(parse_duration_seconds("8"), Some(8.0));
        assert_eq!(parse_duration_seconds("8s"), Some(8.0));
        assert_eq!(parse_duration_seconds("auto"), None);
    }

    const NOT_VIDEO: CostContext = CostContext {
        is_video: false,
        duration_sec: None,
        resolution: None,
        megapixels: None,
    };

    #[test]
    fn per_item_price_end_to_end_and_provider_defaults_to_fal() {
        let mut prices = HashMap::new();
        prices.insert("fal-ai/foo".to_string(), "$0.01 per image".to_string());
        let overrides = HashMap::new();
        assert_eq!(
            per_item_price(Some("fal"), "fal-ai/foo", &prices, &overrides, &NOT_VIDEO),
            Some(0.01)
        );
        assert_eq!(
            per_item_price(
                Some("replicate"),
                "fal-ai/foo",
                &prices,
                &overrides,
                &NOT_VIDEO
            ),
            None
        );
        assert_eq!(
            per_item_price(None, "fal-ai/foo", &prices, &overrides, &NOT_VIDEO),
            Some(0.01)
        );
    }

    #[test]
    fn missing_or_unparsable_price_text_returns_none() {
        let prices = HashMap::new();
        let overrides = HashMap::new();
        assert_eq!(
            per_item_price(
                Some("fal"),
                "fal-ai/unknown",
                &prices,
                &overrides,
                &NOT_VIDEO
            ),
            None
        );
    }

    #[test]
    fn override_wins_for_any_provider_including_unpriced_and_non_fal() {
        let prices = HashMap::new();
        let mut overrides = HashMap::new();
        overrides.insert("replicate-model/foo".to_string(), 0.42);
        assert_eq!(
            per_item_price(
                Some("replicate"),
                "replicate-model/foo",
                &prices,
                &overrides,
                &NOT_VIDEO
            ),
            Some(0.42)
        );
    }

    #[test]
    fn video_override_is_per_second_and_needs_a_known_duration() {
        let prices = HashMap::new();
        let mut overrides = HashMap::new();
        overrides.insert("fal-ai/vid".to_string(), 0.05);
        let video_5s = CostContext {
            is_video: true,
            duration_sec: Some(5.0),
            resolution: None,
            megapixels: None,
        };
        let video_unknown = CostContext {
            is_video: true,
            duration_sec: None,
            resolution: None,
            megapixels: None,
        };
        assert_eq!(
            per_item_price(Some("fal"), "fal-ai/vid", &prices, &overrides, &video_5s),
            Some(0.25)
        );
        assert_eq!(
            per_item_price(
                Some("fal"),
                "fal-ai/vid",
                &prices,
                &overrides,
                &video_unknown
            ),
            None
        );
    }

    #[test]
    fn video_fetched_per_second_price_multiplies_by_duration() {
        let mut prices = HashMap::new();
        prices.insert("fal-ai/vid".to_string(), "$0.08 per second".to_string());
        let overrides = HashMap::new();
        let video_10s = CostContext {
            is_video: true,
            duration_sec: Some(10.0),
            resolution: None,
            megapixels: None,
        };
        assert_eq!(
            per_item_price(Some("fal"), "fal-ai/vid", &prices, &overrides, &video_10s),
            Some(0.8)
        );
    }

    #[test]
    fn resolution_scoped_override_falls_back_to_flat_endpoint_override() {
        let prices = HashMap::new();
        let mut overrides = HashMap::new();
        overrides.insert("fal-ai/img::1080p".to_string(), 0.02);
        overrides.insert("fal-ai/img".to_string(), 0.01);
        let ctx_1080p = CostContext {
            is_video: false,
            duration_sec: None,
            resolution: Some("1080p"),
            megapixels: None,
        };
        let ctx_720p = CostContext {
            is_video: false,
            duration_sec: None,
            resolution: Some("720p"),
            megapixels: None,
        };
        assert_eq!(
            per_item_price(Some("fal"), "fal-ai/img", &prices, &overrides, &ctx_1080p),
            Some(0.02)
        );
        assert_eq!(
            per_item_price(Some("fal"), "fal-ai/img", &prices, &overrides, &ctx_720p),
            Some(0.01)
        );
    }

    #[test]
    fn resolution_scoped_fetched_price_falls_back_to_flat_endpoint_price() {
        // fal's official pricing API only ever returns one flat unit_price
        // per endpoint (see falPrices.ts), so `prices` in production never
        // actually contains a `::resolution` compound key — only
        // `priceOverrides` can. This test just confirms the compound-key
        // lookup is still a no-op passthrough to the flat key when `prices`
        // happens to hold one anyway (e.g. cached config.json data from
        // before that migration), rather than a real currently-populated path.
        let mut prices = HashMap::new();
        prices.insert(
            "fal-ai/vid::720p".to_string(),
            "$0.10 per second".to_string(),
        );
        prices.insert(
            "fal-ai/vid::1080p".to_string(),
            "$0.15 per second".to_string(),
        );
        prices.insert(
            "fal-ai/vid".to_string(),
            "Your request will cost $0.10 per second for 720p, $0.15 per second for 1080p."
                .to_string(),
        );
        let overrides = HashMap::new();
        let ctx_720p = CostContext {
            is_video: true,
            duration_sec: Some(5.0),
            resolution: Some("720p"),
            megapixels: None,
        };
        let ctx_1080p = CostContext {
            is_video: true,
            duration_sec: Some(5.0),
            resolution: Some("1080p"),
            megapixels: None,
        };
        let ctx_unknown_res = CostContext {
            is_video: true,
            duration_sec: Some(5.0),
            resolution: None,
            megapixels: None,
        };
        assert_eq!(
            per_item_price(Some("fal"), "fal-ai/vid", &prices, &overrides, &ctx_720p),
            Some(0.5)
        );
        assert_eq!(
            per_item_price(Some("fal"), "fal-ai/vid", &prices, &overrides, &ctx_1080p),
            Some(0.75)
        );
        // No resolution context: falls back to the flat text, which resolves
        // to the first ($0.10/sec) tier rather than failing outright.
        assert_eq!(
            per_item_price(
                Some("fal"),
                "fal-ai/vid",
                &prices,
                &overrides,
                &ctx_unknown_res
            ),
            Some(0.5)
        );
    }

    #[test]
    fn area_billed_price_multiplies_by_measured_megapixels() {
        let mut prices = HashMap::new();
        prices.insert(
            "fal-ai/flux/dev".to_string(),
            "$0.025 per megapixels".to_string(),
        );
        let overrides = HashMap::new();
        // 1024x1024 = 1.048576 MP — a real measured output size, not a guess.
        let ctx = CostContext {
            is_video: false,
            duration_sec: None,
            resolution: None,
            megapixels: Some(1.048576),
        };
        let amount =
            per_item_price(Some("fal"), "fal-ai/flux/dev", &prices, &overrides, &ctx).unwrap();
        assert!((amount - 0.025 * 1.048576).abs() < 1e-9);
    }

    #[test]
    fn area_billed_price_without_measured_dimensions_returns_none() {
        let mut prices = HashMap::new();
        prices.insert(
            "fal-ai/flux/dev".to_string(),
            "$0.025 per megapixels".to_string(),
        );
        let overrides = HashMap::new();
        assert_eq!(
            per_item_price(
                Some("fal"),
                "fal-ai/flux/dev",
                &prices,
                &overrides,
                &NOT_VIDEO
            ),
            None
        );
    }
}
