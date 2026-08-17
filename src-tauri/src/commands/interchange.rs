//! Timeline interchange export — write the edit list as an *edit decision*
//! rather than a rendered movie, so a rough cut assembled here can be conformed
//! in DaVinci Resolve, Premiere or Final Cut against the original files.
//!
//! Two targets, both plain text and both written without any third-party
//! library:
//!
//! * **OTIO** (`.otio`) — OpenTimelineIO's JSON schema. Native import in
//!   Resolve 17+ (free and Studio) and Premiere. The preferred target.
//! * **FCP7 XML** (`.xml`, `xmeml` v5) — the older lingua franca. Broader
//!   reach than OTIO for anything that hasn't adopted it yet.
//!
//! Deliberately *not* EDL: CMX3600 conforms by source timecode, which
//! generated clips don't have, and its 8-character reel names can't carry a
//! filename. Both formats here relink by absolute path instead.
//!
//! Everything except the final `fs::write` is a pure function, so the fiddly
//! parts — frame quantisation, path→URL, XML escaping — are unit-tested below.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::commands::media::{ExportSegment, ExportSegmentKind};
use crate::error::{run_blocking, AppError, AppResult};

/// Nominal file duration given to stills, which have no intrinsic length.
/// One hour at the sequence rate, the usual NLE convention.
const STILL_FILE_SECONDS: i64 = 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InterchangeFormat {
    Otio,
    Xmeml,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineInterchangeParams {
    pub segments: Vec<ExportSegment>,
    pub output_path: String,
    pub format: InterchangeFormat,
    /// Sequence name written into the file.
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// Sequence-level settings shared by both writers.
pub struct InterchangeOpts {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl InterchangeOpts {
    fn from_params(p: &TimelineInterchangeParams) -> Self {
        Self {
            name: if p.name.trim().is_empty() {
                "aiSLAP timeline".to_string()
            } else {
                p.name.trim().to_string()
            },
            width: p.width.max(2),
            height: p.height.max(2),
            fps: p.fps.max(1),
        }
    }
}

// ---------- frame layout ----------

/// One segment resolved onto the timeline in whole frames.
struct Placed<'a> {
    kind: &'a ExportSegmentKind,
    /// Timeline position, in frames from zero.
    start: i64,
    /// Length in frames. Never zero — both formats reject empty items.
    frames: i64,
}

impl Placed<'_> {
    fn end(&self) -> i64 {
        self.start + self.frames
    }
}

/// Lay the segments out in frames.
///
/// Each boundary is quantised from the *cumulative* second rather than by
/// summing per-segment frame counts, so rounding error can't accumulate across
/// a long sequence: a 200-clip timeline of 0.7s clips lands on the same last
/// frame as `round(total * fps)`. Segments stay butt-joined — segment N starts
/// exactly where N-1 ended — because gaps are carried as `Blank` segments, not
/// as holes.
fn place(segments: &[ExportSegment], fps: u32) -> Vec<Placed<'_>> {
    let rate = f64::from(fps);
    let mut out = Vec::with_capacity(segments.len());
    let mut cum_sec = 0.0f64;
    let mut cursor = 0i64;
    for seg in segments {
        let dur = if seg.duration_sec.is_finite() {
            seg.duration_sec.max(0.0)
        } else {
            0.0
        };
        cum_sec += dur;
        let target_end = (cum_sec * rate).round() as i64;
        let frames = (target_end - cursor).max(1);
        out.push(Placed {
            kind: &seg.kind,
            start: cursor,
            frames,
        });
        cursor += frames;
    }
    out
}

fn secs_to_frames(sec: f64, fps: u32) -> i64 {
    if !sec.is_finite() || sec <= 0.0 {
        return 0;
    }
    (sec * f64::from(fps)).round() as i64
}

/// Filename without directory or extension — the clip name a host NLE shows.
fn stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

// ---------- path → file URL ----------

/// Percent-encode a path that has already been slash-normalised.
///
/// `/` and `:` are left intact — the first is the separator, and the second has
/// to survive for a Windows drive letter (`C:`), where it is legal in a path
/// segment. Iterating bytes rather than chars means non-ASCII is encoded as its
/// UTF-8 octets, which is what RFC 3986 asks for.
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = char::from(*b);
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '/' | ':') {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Absolute path → `file:` URL.
///
/// `authority` is what goes between `file://` and the path — empty for OTIO
/// (`file:///C:/…`), `localhost` for xmeml (`file://localhost/C:/…`), which is
/// the form FCP7 wrote and every importer recognises. A UNC path keeps its own
/// server as the authority and ignores the argument.
fn file_url(path: &str, authority: &str) -> String {
    let unified = path.replace('\\', "/");
    if let Some(unc) = unified.strip_prefix("//") {
        // \\server\share\file → file://server/share/file
        return format!("file://{}", percent_encode_path(unc));
    }
    format!(
        "file://{authority}/{}",
        percent_encode_path(unified.trim_start_matches('/'))
    )
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

// ---------- OTIO ----------

fn otio_rational(value: i64, fps: u32) -> Value {
    json!({
        "OTIO_SCHEMA": "RationalTime.1",
        "rate": f64::from(fps),
        "value": value as f64,
    })
}

fn otio_range(start: i64, duration: i64, fps: u32) -> Value {
    json!({
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": otio_rational(start, fps),
        "duration": otio_rational(duration, fps),
    })
}

/// Serialise as an OTIO `Timeline.1` with a single video track.
pub fn build_otio(segments: &[ExportSegment], o: &InterchangeOpts) -> String {
    let fps = o.fps;
    let placed = place(segments, fps);
    let mut children: Vec<Value> = Vec::with_capacity(placed.len());

    for p in &placed {
        match p.kind {
            ExportSegmentKind::Blank => {
                children.push(json!({
                    "OTIO_SCHEMA": "Gap.1",
                    "name": "",
                    "source_range": otio_range(0, p.frames, fps),
                    "effects": [],
                    "markers": [],
                    "metadata": {},
                }));
            }
            ExportSegmentKind::Image { path } => {
                children.push(otio_clip(path, 0, p.frames, None, fps));
            }
            ExportSegmentKind::Video {
                path,
                source_offset_sec,
                source_duration_sec,
            } => {
                let in_frames = secs_to_frames(*source_offset_sec, fps);
                let available = source_duration_sec
                    .filter(|d| d.is_finite() && *d > 0.0)
                    .map(|d| secs_to_frames(d, fps));
                children.push(otio_clip(path, in_frames, p.frames, available, fps));
            }
        }
    }

    let doc = json!({
        "OTIO_SCHEMA": "Timeline.1",
        "name": o.name,
        "global_start_time": otio_rational(0, fps),
        "metadata": {
            "aislap": {
                "width": o.width,
                "height": o.height,
            }
        },
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "source_range": Value::Null,
            "effects": [],
            "markers": [],
            "metadata": {},
            "children": [{
                "OTIO_SCHEMA": "Track.1",
                "name": "V1",
                "kind": "Video",
                "source_range": Value::Null,
                "effects": [],
                "markers": [],
                "metadata": {},
                "children": children,
            }],
        },
    });

    serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".to_string())
}

/// A `Clip.1` whose `source_range` is the used slice and whose
/// `available_range`, when the source duration is known, tells the host that
/// media continues past it — which is what makes the trim adjustable after
/// import rather than baked in.
fn otio_clip(
    path: &str,
    in_frames: i64,
    frames: i64,
    available_frames: Option<i64>,
    fps: u32,
) -> Value {
    let mut media_ref = Map::new();
    media_ref.insert(
        "OTIO_SCHEMA".into(),
        Value::String("ExternalReference.1".into()),
    );
    media_ref.insert("name".into(), Value::String(file_name(path)));
    media_ref.insert("target_url".into(), Value::String(file_url(path, "")));
    media_ref.insert("metadata".into(), Value::Object(Map::new()));
    // A still has no intrinsic length, so it gets no available_range at all
    // rather than a fabricated one.
    if let Some(avail) = available_frames {
        media_ref.insert(
            "available_range".into(),
            otio_range(0, avail.max(frames), fps),
        );
    }

    json!({
        "OTIO_SCHEMA": "Clip.1",
        "name": stem(path),
        "source_range": otio_range(in_frames, frames, fps),
        "effects": [],
        "markers": [],
        "metadata": {},
        "media_reference": Value::Object(media_ref),
    })
}

// ---------- FCP7 XML (xmeml v5) ----------

fn xmeml_rate(fps: u32, indent: &str) -> String {
    format!(
        "{indent}<rate>\n{indent}  <timebase>{fps}</timebase>\n{indent}  <ntsc>FALSE</ntsc>\n{indent}</rate>\n"
    )
}

/// Serialise as `xmeml` version 5 with a single video track.
///
/// Semantics worth keeping straight: `start`/`end` are *timeline* frames,
/// `in`/`out` are *source* frames, and a gap is the **absence** of a clipitem —
/// there is no blank element, the numbering simply skips. A `<file>` is
/// declared in full on first use and referenced by id afterwards, which matters
/// because the same take can legitimately sit in two clips.
pub fn build_xmeml(segments: &[ExportSegment], o: &InterchangeOpts) -> String {
    let fps = o.fps;
    let placed = place(segments, fps);
    let total = placed.last().map_or(0, Placed::end);
    let still_frames = STILL_FILE_SECONDS * i64::from(fps);

    let mut file_ids: HashMap<&str, usize> = HashMap::new();
    let mut track = String::new();

    for (i, p) in placed.iter().enumerate() {
        let (path, in_frames, file_frames) = match p.kind {
            // Gaps are holes in the numbering, not elements.
            ExportSegmentKind::Blank => continue,
            ExportSegmentKind::Image { path } => (path.as_str(), 0, still_frames),
            ExportSegmentKind::Video {
                path,
                source_offset_sec,
                source_duration_sec,
            } => {
                let in_frames = secs_to_frames(*source_offset_sec, fps);
                let file_frames = source_duration_sec
                    .filter(|d| d.is_finite() && *d > 0.0)
                    .map(|d| secs_to_frames(d, fps))
                    .unwrap_or(in_frames + p.frames)
                    // The file cannot be shorter than the slice taken from it.
                    .max(in_frames + p.frames);
                (path.as_str(), in_frames, file_frames)
            }
        };

        let next_id = file_ids.len() + 1;
        let (file_id, first_use) = match file_ids.get(path) {
            Some(id) => (*id, false),
            None => {
                file_ids.insert(path, next_id);
                (next_id, true)
            }
        };

        track.push_str(&format!(
            "          <clipitem id=\"clipitem-{}\">\n\
             \x20           <name>{}</name>\n\
             \x20           <enabled>TRUE</enabled>\n\
             \x20           <duration>{}</duration>\n",
            i + 1,
            xml_escape(&stem(path)),
            file_frames,
        ));
        track.push_str(&xmeml_rate(fps, "            "));
        track.push_str(&format!(
            "            <start>{}</start>\n\
             \x20           <end>{}</end>\n\
             \x20           <in>{}</in>\n\
             \x20           <out>{}</out>\n",
            p.start,
            p.end(),
            in_frames,
            in_frames + p.frames,
        ));

        if first_use {
            track.push_str(&format!(
                "            <file id=\"file-{file_id}\">\n\
                 \x20             <name>{}</name>\n\
                 \x20             <pathurl>{}</pathurl>\n",
                xml_escape(&file_name(path)),
                xml_escape(&file_url(path, "localhost")),
            ));
            track.push_str(&xmeml_rate(fps, "              "));
            track.push_str(&format!(
                "              <duration>{file_frames}</duration>\n\
                 \x20             <media>\n\
                 \x20               <video>\n\
                 \x20                 <samplecharacteristics>\n\
                 \x20                   <width>{}</width>\n\
                 \x20                   <height>{}</height>\n\
                 \x20                 </samplecharacteristics>\n\
                 \x20               </video>\n\
                 \x20             </media>\n\
                 \x20           </file>\n",
                o.width, o.height,
            ));
        } else {
            track.push_str(&format!("            <file id=\"file-{file_id}\"/>\n"));
        }

        track.push_str("          </clipitem>\n");
    }

    let mut out = String::new();
    out.push_str(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE xmeml>\n<xmeml version=\"5\">\n",
    );
    out.push_str("  <sequence id=\"aislap-sequence\">\n");
    out.push_str(&format!("    <name>{}</name>\n", xml_escape(&o.name)));
    out.push_str(&format!("    <duration>{total}</duration>\n"));
    out.push_str(&xmeml_rate(fps, "    "));
    out.push_str(
        "    <media>\n      <video>\n        <format>\n          <samplecharacteristics>\n",
    );
    out.push_str(&xmeml_rate(fps, "            "));
    out.push_str(&format!(
        "            <width>{}</width>\n            <height>{}</height>\n",
        o.width, o.height
    ));
    out.push_str("          </samplecharacteristics>\n        </format>\n        <track>\n");
    out.push_str(&track);
    out.push_str("        </track>\n      </video>\n    </media>\n  </sequence>\n</xmeml>\n");
    out
}

// ---------- command ----------

#[tauri::command]
pub async fn timeline_export_interchange(params: TimelineInterchangeParams) -> AppResult<()> {
    run_blocking(move || timeline_export_interchange_impl(params)).await
}

fn timeline_export_interchange_impl(params: TimelineInterchangeParams) -> AppResult<()> {
    if params.segments.is_empty() {
        return Err(AppError::Msg("no segments to export".into()));
    }
    let out = PathBuf::from(&params.output_path);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let opts = InterchangeOpts::from_params(&params);
    let text = match params.format {
        InterchangeFormat::Otio => build_otio(&params.segments, &opts),
        InterchangeFormat::Xmeml => build_xmeml(&params.segments, &opts),
    };
    std::fs::write(&out, text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(fps: u32) -> InterchangeOpts {
        InterchangeOpts {
            name: "SEQ01".into(),
            width: 1920,
            height: 1080,
            fps,
        }
    }

    fn video(path: &str, dur: f64, offset: f64, src: Option<f64>) -> ExportSegment {
        ExportSegment {
            kind: ExportSegmentKind::Video {
                path: path.into(),
                source_offset_sec: offset,
                source_duration_sec: src,
            },
            duration_sec: dur,
        }
    }

    fn image(path: &str, dur: f64) -> ExportSegment {
        ExportSegment {
            kind: ExportSegmentKind::Image { path: path.into() },
            duration_sec: dur,
        }
    }

    fn blank(dur: f64) -> ExportSegment {
        ExportSegment {
            kind: ExportSegmentKind::Blank,
            duration_sec: dur,
        }
    }

    #[test]
    fn frame_layout_does_not_drift_over_a_long_sequence() {
        // 0.7s at 25fps is 17.5 frames — the worst case for per-clip rounding.
        let segs: Vec<ExportSegment> = (0..200).map(|_| blank(0.7)).collect();
        let placed = place(&segs, 25);
        assert_eq!(placed.len(), 200);
        // Butt-joined: every segment starts where the previous ended.
        for w in placed.windows(2) {
            assert_eq!(w[0].end(), w[1].start);
        }
        // And the last frame matches the total, not the sum of rounded clips.
        assert_eq!(
            placed.last().unwrap().end(),
            (200.0_f64 * 0.7 * 25.0).round() as i64
        );
        assert_eq!(placed.last().unwrap().end(), 3500);
    }

    #[test]
    fn frame_layout_never_emits_a_zero_length_item() {
        let segs = [blank(0.0), blank(f64::NAN), blank(-3.0)];
        let placed = place(&segs, 25);
        assert!(placed.iter().all(|p| p.frames >= 1));
        for w in placed.windows(2) {
            assert_eq!(w[0].end(), w[1].start);
        }
    }

    #[test]
    fn otio_maps_slip_offset_to_source_range_start() {
        let json = build_otio(&[video("/m/a.mp4", 4.0, 2.0, Some(10.0))], &opts(25));
        let v: Value = serde_json::from_str(&json).unwrap();
        let clip = &v["tracks"]["children"][0]["children"][0];
        assert_eq!(clip["OTIO_SCHEMA"], "Clip.1");
        assert_eq!(clip["source_range"]["start_time"]["value"], 50.0);
        assert_eq!(clip["source_range"]["duration"]["value"], 100.0);
        // available_range tells the host the media runs past the trim.
        assert_eq!(
            clip["media_reference"]["available_range"]["duration"]["value"],
            250.0
        );
        assert_eq!(clip["media_reference"]["target_url"], "file:///m/a.mp4");
    }

    #[test]
    fn otio_writes_blanks_as_gaps_and_stills_without_available_range() {
        let json = build_otio(&[blank(1.0), image("/m/still.png", 2.0)], &opts(25));
        let v: Value = serde_json::from_str(&json).unwrap();
        let kids = &v["tracks"]["children"][0]["children"];
        assert_eq!(kids[0]["OTIO_SCHEMA"], "Gap.1");
        assert_eq!(kids[0]["source_range"]["duration"]["value"], 25.0);
        assert_eq!(kids[1]["OTIO_SCHEMA"], "Clip.1");
        assert_eq!(kids[1]["source_range"]["start_time"]["value"], 0.0);
        assert!(kids[1]["media_reference"].get("available_range").is_none());
    }

    #[test]
    fn xmeml_separates_timeline_frames_from_source_frames() {
        let xml = build_xmeml(&[video("/m/a.mp4", 4.0, 2.0, Some(10.0))], &opts(25));
        assert!(xml.contains("<start>0</start>"));
        assert!(xml.contains("<end>100</end>"));
        assert!(xml.contains("<in>50</in>"));
        assert!(xml.contains("<out>150</out>"));
        assert!(xml.contains("<pathurl>file://localhost/m/a.mp4</pathurl>"));
    }

    #[test]
    fn xmeml_leaves_a_hole_for_a_gap_instead_of_an_element() {
        let xml = build_xmeml(
            &[
                video("/m/a.mp4", 2.0, 0.0, None),
                blank(1.0),
                video("/m/b.mp4", 2.0, 0.0, None),
            ],
            &opts(25),
        );
        assert_eq!(xml.matches("<clipitem").count(), 2);
        // Second clip starts at 75, not 50 — the gap consumed 25 frames.
        assert!(xml.contains("<start>75</start>"));
        assert!(xml.contains("<end>125</end>"));
    }

    #[test]
    fn xmeml_declares_each_file_once_then_references_it() {
        let xml = build_xmeml(
            &[
                video("/m/a.mp4", 2.0, 0.0, Some(9.0)),
                video("/m/b.mp4", 2.0, 0.0, Some(9.0)),
                video("/m/a.mp4", 2.0, 4.0, Some(9.0)),
            ],
            &opts(25),
        );
        assert_eq!(xml.matches("<pathurl>").count(), 2);
        assert_eq!(xml.matches("<file id=\"file-1\"/>").count(), 1);
        assert_eq!(xml.matches("<file id=\"file-1\">").count(), 1);
    }

    #[test]
    fn xmeml_never_claims_a_file_shorter_than_the_slice_taken_from_it() {
        // Source duration missing: the file must still cover offset + length.
        let xml = build_xmeml(&[video("/m/a.mp4", 4.0, 2.0, None)], &opts(25));
        assert!(xml.contains("<out>150</out>"));
        assert!(xml.contains("<duration>150</duration>"));
    }

    #[test]
    fn xmeml_escapes_markup_in_filenames() {
        let xml = build_xmeml(&[video("/m/a & b <x>.mp4", 1.0, 0.0, None)], &opts(25));
        assert!(xml.contains("<name>a &amp; b &lt;x&gt;</name>"));
        assert!(!xml.contains("a & b"));
    }

    #[test]
    fn windows_paths_become_file_urls_with_the_drive_letter_intact() {
        assert_eq!(
            file_url(r"C:\Users\p\My Shots\a.mp4", ""),
            "file:///C:/Users/p/My%20Shots/a.mp4"
        );
        assert_eq!(
            file_url(r"C:\Users\p\a.mp4", "localhost"),
            "file://localhost/C:/Users/p/a.mp4"
        );
    }

    #[test]
    fn unc_paths_keep_their_server_as_the_authority() {
        assert_eq!(
            file_url(r"\\nas\share\a.mp4", "localhost"),
            "file://nas/share/a.mp4"
        );
    }

    #[test]
    fn percent_encoding_covers_reserved_and_non_ascii() {
        assert_eq!(percent_encode_path("a b"), "a%20b");
        assert_eq!(percent_encode_path("a#b?c%d"), "a%23b%3Fc%25d");
        assert_eq!(percent_encode_path("a&b"), "a%26b");
        // UTF-8 octets, not the char.
        assert_eq!(percent_encode_path("é"), "%C3%A9");
        // Unreserved and separators survive.
        assert_eq!(percent_encode_path("C:/a-b_c.d~e/f"), "C:/a-b_c.d~e/f");
    }

    #[test]
    fn a_still_gets_a_nominal_hour_long_file_duration() {
        let xml = build_xmeml(&[image("/m/s.png", 2.0)], &opts(25));
        assert!(xml.contains(&format!("<duration>{}</duration>", 3600 * 25)));
        assert!(xml.contains("<in>0</in>"));
        assert!(xml.contains("<out>50</out>"));
    }

    #[test]
    fn empty_segments_are_rejected_rather_than_writing_a_stub_file() {
        let p = TimelineInterchangeParams {
            segments: vec![],
            output_path: "out.otio".into(),
            format: InterchangeFormat::Otio,
            name: "x".into(),
            width: 1920,
            height: 1080,
            fps: 25,
        };
        assert!(timeline_export_interchange_impl(p).is_err());
    }
}
