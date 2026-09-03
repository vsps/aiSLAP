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

/// ByteDance's video token divisor: their video models bill on
/// `tokens = width * height * fps * duration / 1024`, and fal resells that
/// verbatim. Mirrors TOKEN_DIVISOR in falPrices.ts.
const TOKEN_DIVISOR: f64 = 1024.0;

/// Tokens in one billed unit, or None when the unit isn't token-billed.
///
/// `"units"` is the ambiguous one: on an image or 3D output a fal "unit" is
/// one output, but on a *video* output it is 1000 ByteDance tokens — so this
/// is only ever consulted for video (see `per_item_price`, where the token
/// branch precedes the flat one for exactly that reason). Mirrors
/// tokensPerBilledUnit(); see the TS doc comment for where the 1000 comes
/// from.
pub fn tokens_per_billed_unit(unit: &str) -> Option<f64> {
    static TOKENS: OnceLock<Regex> = OnceLock::new();
    static UNITS: OnceLock<Regex> = OnceLock::new();
    let tokens = TOKENS.get_or_init(|| Regex::new(r"(?i)^(?:(\d+)\s+)?tokens?\b").unwrap());
    if let Some(caps) = tokens.captures(unit) {
        return Some(match caps.get(1) {
            Some(n) => n.as_str().parse().ok()?,
            None => 1.0,
        });
    }
    UNITS
        .get_or_init(|| Regex::new(r"(?i)^units?\b").unwrap())
        .is_match(unit)
        .then_some(1000.0)
}

/// Frames in one billed unit ("16 frames" for sam-3 video), else None.
/// Mirrors framesPerBilledUnit().
pub fn frames_per_billed_unit(unit: &str) -> Option<f64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let caps = RE
        .get_or_init(|| Regex::new(r"(?i)^(?:(\d+)\s+)?frames?\b").unwrap())
        .captures(unit)?;
    Some(match caps.get(1) {
        Some(n) => n.as_str().parse().ok()?,
        None => 1.0,
    })
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
#[derive(Default)]
pub struct CostContext<'a> {
    pub is_video: bool,
    pub duration_sec: Option<f64>,
    pub resolution: Option<&'a str>,
    /// Actual output pixel count / 1,000,000, for area-billed units (see
    /// is_per_area_unit). Measured from the real output file, never guessed
    /// from a named size preset — `None` when unknown (e.g. not yet wired up
    /// for this call site, or the file's dimensions couldn't be read).
    pub megapixels: Option<f64>,
    /// Coded frame size and frame rate of the output video, for token- and
    /// frame-billed units. Measured with `video_info_probe`; no model in the
    /// registry declares a frame rate, so there is no other source. `None`
    /// leaves such a model unpriced rather than guessed.
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub fps: Option<f64>,
}

/// ByteDance video tokens for one output. Every factor must be known and
/// positive — a guessed frame rate is a guessed invoice. Mirrors videoTokens().
pub fn video_tokens(ctx: &CostContext) -> Option<f64> {
    let (w, h, fps, dur) = (ctx.width?, ctx.height?, ctx.fps?, ctx.duration_sec?);
    let all = [w, h, fps, dur];
    all.iter()
        .all(|n| n.is_finite() && *n > 0.0)
        .then(|| w * h * fps * dur / TOKEN_DIVISOR)
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
    // Video token billing is tested FIRST: "units" would otherwise be
    // swallowed by is_per_item_unit's `unit` alternative and priced flat,
    // which for Seedance 2.0 meant $0.014 a video instead of ~$1.50. An image
    // or 3D output still takes the flat branch below, where "units" genuinely
    // does mean one output.
    if ctx.is_video {
        if let Some(per_unit) = tokens_per_billed_unit(&parsed.unit) {
            return video_tokens(ctx).map(|t| parsed.amount * t / per_unit);
        }
    }
    if is_per_item_unit(&parsed.unit) {
        return Some(parsed.amount);
    }
    if ctx.is_video && is_per_second_unit(&parsed.unit) {
        return ctx.duration_sec.map(|d| parsed.amount * d);
    }
    if is_per_area_unit(&parsed.unit) {
        return ctx.megapixels.map(|mp| parsed.amount * mp);
    }
    // Frame-billed (sam-3 video: "$0.005 per 16 frames") — frame count from
    // the same probe as the token math.
    if let Some(per_unit) = frames_per_billed_unit(&parsed.unit) {
        if let (Some(fps), Some(dur)) = (ctx.fps, ctx.duration_sec) {
            return Some(parsed.amount * fps * dur / per_unit);
        }
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

    // A `const` can't spread `Default::default()`, so this one stays spelled
    // out in full.
    const NOT_VIDEO: CostContext = CostContext {
        is_video: false,
        duration_sec: None,
        resolution: None,
        megapixels: None,
        width: None,
        height: None,
        fps: None,
    };

    /// 720p / 24fps / 5s — the geometry the Seedance token formula was
    /// checked against. 1280*720*24*5/1024 = 108,000 tokens.
    fn seedance_720p_5s() -> CostContext<'static> {
        CostContext {
            is_video: true,
            duration_sec: Some(5.0),
            width: Some(1280.0),
            height: Some(720.0),
            fps: Some(24.0),
            ..Default::default()
        }
    }

    #[test]
    fn video_units_are_thousand_token_blocks_not_flat() {
        // The regression this whole branch exists for: "units" matches
        // is_per_item_unit's `unit` alternative, so Seedance 2.0 priced flat
        // at $0.014 a video instead of ~$1.50.
        let mut prices = HashMap::new();
        prices.insert(
            "bytedance/seedance-2.0/text-to-video".to_string(),
            "$0.014 per units".to_string(),
        );
        let overrides = HashMap::new();
        let got = per_item_price(
            Some("fal"),
            "bytedance/seedance-2.0/text-to-video",
            &prices,
            &overrides,
            &seedance_720p_5s(),
        )
        .unwrap();
        // 108 kilotokens * $0.014. The real billed figure for this generation
        // was $1.515, which is where the 1000-tokens-per-unit reading comes
        // from — see tokens_per_billed_unit.
        assert!((got - 1.512).abs() < 1e-9, "got {got}");
    }

    #[test]
    fn thousand_tokens_unit_prices_the_same_way() {
        let mut prices = HashMap::new();
        prices.insert(
            "bytedance/seedance-2.5/text-to-video".to_string(),
            "$0.0214 per 1000 tokens".to_string(),
        );
        let overrides = HashMap::new();
        let got = per_item_price(
            Some("fal"),
            "bytedance/seedance-2.5/text-to-video",
            &prices,
            &overrides,
            &seedance_720p_5s(),
        )
        .unwrap();
        assert!((got - 108.0 * 0.0214).abs() < 1e-9, "got {got}");
    }

    #[test]
    fn units_stay_flat_for_non_video_outputs() {
        // The other half of the ambiguity: for sam-3 / seedream / gpt-image a
        // fal "unit" really is one output, and the user's own override for
        // sam-3/3d-objects ($0.02) matches the fetched price exactly.
        let mut prices = HashMap::new();
        prices.insert(
            "fal-ai/sam-3/3d-objects".to_string(),
            "$0.02 per units".to_string(),
        );
        let overrides = HashMap::new();
        assert_eq!(
            per_item_price(
                Some("fal"),
                "fal-ai/sam-3/3d-objects",
                &prices,
                &overrides,
                &NOT_VIDEO
            ),
            Some(0.02)
        );
    }

    #[test]
    fn token_billing_needs_every_factor_and_yields_none_without_them() {
        let mut prices = HashMap::new();
        prices.insert("vid".to_string(), "$0.014 per units".to_string());
        let overrides = HashMap::new();
        // No probe ran: duration alone can't produce a token count, and a
        // guessed frame rate would be a guessed invoice.
        let no_geometry = CostContext {
            is_video: true,
            duration_sec: Some(5.0),
            ..Default::default()
        };
        assert_eq!(
            per_item_price(Some("fal"), "vid", &prices, &overrides, &no_geometry),
            None
        );
    }

    #[test]
    fn frame_billed_units_use_the_probed_frame_count() {
        // sam-3 video: "$0.005 per 16 frames". 24fps * 5s = 120 frames = 7.5
        // billed blocks.
        let mut prices = HashMap::new();
        prices.insert(
            "fal-ai/sam-3/video".to_string(),
            "$0.005 per 16 frames".to_string(),
        );
        let overrides = HashMap::new();
        let got = per_item_price(
            Some("fal"),
            "fal-ai/sam-3/video",
            &prices,
            &overrides,
            &seedance_720p_5s(),
        )
        .unwrap();
        assert!((got - 7.5 * 0.005).abs() < 1e-9, "got {got}");
    }

    #[test]
    fn compute_seconds_stays_unpriced() {
        // minimax h3-max bills GPU time, which no amount of output geometry
        // can reconstruct. Better unpriced than confidently wrong.
        let mut prices = HashMap::new();
        prices.insert(
            "minimax/h3-max/text-to-video".to_string(),
            "$0.00017 per compute seconds".to_string(),
        );
        let overrides = HashMap::new();
        assert_eq!(
            per_item_price(
                Some("fal"),
                "minimax/h3-max/text-to-video",
                &prices,
                &overrides,
                &seedance_720p_5s()
            ),
            None
        );
    }

    #[test]
    fn unit_parsers_read_their_multipliers() {
        assert_eq!(tokens_per_billed_unit("1000 tokens"), Some(1000.0));
        assert_eq!(tokens_per_billed_unit("tokens"), Some(1.0));
        assert_eq!(tokens_per_billed_unit("units"), Some(1000.0));
        assert_eq!(tokens_per_billed_unit("unit"), Some(1000.0));
        assert_eq!(tokens_per_billed_unit("seconds"), None);
        assert_eq!(tokens_per_billed_unit("megapixels"), None);
        assert_eq!(frames_per_billed_unit("16 frames"), Some(16.0));
        assert_eq!(frames_per_billed_unit("frame"), Some(1.0));
        assert_eq!(frames_per_billed_unit("seconds"), None);
    }

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
            ..Default::default()
        };
        let video_unknown = CostContext {
            is_video: true,
            duration_sec: None,
            resolution: None,
            megapixels: None,
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        };
        let ctx_720p = CostContext {
            is_video: false,
            duration_sec: None,
            resolution: Some("720p"),
            megapixels: None,
            ..Default::default()
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
            ..Default::default()
        };
        let ctx_1080p = CostContext {
            is_video: true,
            duration_sec: Some(5.0),
            resolution: Some("1080p"),
            megapixels: None,
            ..Default::default()
        };
        let ctx_unknown_res = CostContext {
            is_video: true,
            duration_sec: Some(5.0),
            resolution: None,
            megapixels: None,
            ..Default::default()
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
            ..Default::default()
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
