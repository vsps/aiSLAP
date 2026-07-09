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

/// Per-output price for one fal endpoint, or None when not fal, unpriced, or
/// billed by time/size rather than per output. Mirrors perItemPrice().
pub fn per_item_price(
    provider: Option<&str>,
    endpoint: &str,
    prices: &HashMap<String, String>,
) -> Option<f64> {
    if provider.unwrap_or("fal") != "fal" {
        return None;
    }
    let parsed = parse_fal_price(prices.get(endpoint)?)?;
    is_per_item_unit(&parsed.unit).then_some(parsed.amount)
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
    }

    #[test]
    fn per_item_price_end_to_end_and_provider_defaults_to_fal() {
        let mut prices = HashMap::new();
        prices.insert("fal-ai/foo".to_string(), "$0.01 per image".to_string());
        assert_eq!(per_item_price(Some("fal"), "fal-ai/foo", &prices), Some(0.01));
        assert_eq!(per_item_price(Some("replicate"), "fal-ai/foo", &prices), None);
        assert_eq!(per_item_price(None, "fal-ai/foo", &prices), Some(0.01));
    }

    #[test]
    fn missing_or_unparsable_price_text_returns_none() {
        let prices = HashMap::new();
        assert_eq!(per_item_price(Some("fal"), "fal-ai/unknown", &prices), None);
    }
}
