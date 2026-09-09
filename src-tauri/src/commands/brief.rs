//! Brief analysis: pull text and embedded images out of a PDF or PPTX brief
//! so an LLM can derive a script from it, without a second manual pass to
//! copy images out by hand.
//!
//! Images land directly in the project's `BRIEF` reference folder
//! (`refroots::brief_dir`) — that alone is enough to make them show up as a
//! subfolder section of the Global SRC reference column, the same as any
//! other folder a person drops into the reference root.
//!
//! PPTX is a zip of XML + media, so every embedded image extracts reliably —
//! it's a raw byte copy, no re-encoding. PDF has no such shortcut: extracting
//! an embedded image image needs a low-level walk of the page's XObject
//! resources, and only `DCTDecode`-filtered streams (i.e. already-JPEG bytes)
//! are written out — anything else is counted as skipped rather than guessed
//! at, since reconstructing an arbitrary PDF color space/filter combination
//! into a normal image file is its own project.

use std::io::Read;
use std::path::{Path, PathBuf};

use lopdf::{Document, Object};
use regex::Regex;
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::commands::refroots::brief_dir;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefExtractResult {
    /// All extractable text, newline-structured (one section per slide/page).
    pub text: String,
    /// Absolute paths of every image written into the project's BRIEF folder.
    pub images_written: Vec<String>,
    /// Images the extractor found but could not turn into a plain file
    /// (PDF only — a non-JPEG-filtered XObject).
    pub images_skipped: u32,
}

#[tauri::command]
pub fn brief_extract(project_path: String, file_path: String) -> AppResult<BriefExtractResult> {
    let dir = brief_dir(Path::new(&project_path));
    std::fs::create_dir_all(&dir)?;

    let ext = Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "pptx" => extract_pptx(Path::new(&file_path), &dir),
        "pdf" => extract_pdf(Path::new(&file_path), &dir),
        other => Err(AppError::Msg(format!(
            "unsupported brief file type: .{other} (expected .pdf or .pptx)"
        ))),
    }
}

/// Write `bytes` to `dir/base_name`, uniquified against collisions, via the
/// same temp-then-rename convention `thumbs.rs::encode_thumb` uses so an
/// interrupted write never leaves a half-written file behind.
fn write_extracted_image(dir: &Path, base_name: &str, bytes: &[u8]) -> AppResult<PathBuf> {
    let mut dest = dir.join(base_name);
    if dest.exists() {
        let stem = dest
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("image")
            .to_string();
        let ext = dest
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let mut i = 1u32;
        loop {
            let candidate = dir.join(if ext.is_empty() {
                format!("{stem}_{i}")
            } else {
                format!("{stem}_{i}.{ext}")
            });
            if !candidate.exists() {
                dest = candidate;
                break;
            }
            i += 1;
        }
    }
    let tmp = dest.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    let _ = std::fs::remove_file(&dest);
    std::fs::rename(&tmp, &dest).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(dest)
}

// ---------- PPTX ----------

fn slide_number(zip_name: &str) -> usize {
    zip_name
        .trim_start_matches("ppt/slides/slide")
        .trim_end_matches(".xml")
        .parse()
        .unwrap_or(0)
}

/// Visible text runs (`<a:t>...</a:t>`) out of one slide's XML, paragraph
/// breaks (`</a:p>`) preserved as newlines. Deliberately not a full XML parse
/// — OOXML text extraction only ever needs these two tags, and pulling in a
/// real XML dependency for that would be a lot of weight for one regex's job.
fn slide_text(xml: &str) -> String {
    let run = Regex::new(r"<a:t>(.*?)</a:t>").unwrap();
    xml.split("</a:p>")
        .map(|para| {
            run.captures_iter(para)
                .map(|c| unescape_xml(&c[1]))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn unescape_xml(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn extract_pptx(file_path: &Path, dir: &Path) -> AppResult<BriefExtractResult> {
    let file = std::fs::File::open(file_path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| AppError::Msg(format!("{} is not a valid .pptx: {e}", file_path.display())))?;

    let mut media_names: Vec<String> = Vec::new();
    let mut slide_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::Msg(format!("reading pptx entry: {e}")))?;
        let name = entry.name().to_string();
        if name.starts_with("ppt/media/") && !name.ends_with('/') {
            media_names.push(name);
        } else if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
            slide_names.push(name);
        }
    }
    media_names.sort();
    slide_names.sort_by_key(|n| slide_number(n));

    let mut images_written = Vec::new();
    for name in &media_names {
        let mut entry = archive
            .by_name(name)
            .map_err(|e| AppError::Msg(format!("reading {name}: {e}")))?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        let base_name = Path::new(name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image")
            .to_string();
        images_written.push(write_extracted_image(dir, &base_name, &bytes)?);
    }

    let mut text = String::new();
    for (i, name) in slide_names.iter().enumerate() {
        let mut entry = archive
            .by_name(name)
            .map_err(|e| AppError::Msg(format!("reading {name}: {e}")))?;
        let mut xml = String::new();
        entry.read_to_string(&mut xml)?;
        let body = slide_text(&xml);
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&format!("## Slide {}\n{}", i + 1, body));
    }

    Ok(BriefExtractResult {
        text,
        images_written: images_written
            .into_iter()
            .map(|p| p.display().to_string())
            .collect(),
        images_skipped: 0,
    })
}

// ---------- PDF ----------

/// Whether a stream dictionary describes an image XObject at all (of any
/// filter) — used to decide whether a non-JPEG image counts as "skipped"
/// rather than just being an unrelated stream (fonts, content streams, etc.
/// are also `Object::Stream`s, and none of those should count).
fn is_image_xobject(dict: &lopdf::Dictionary) -> bool {
    dict.get(b"Subtype")
        .and_then(|o| o.as_name())
        .map(|n| n == b"Image")
        .unwrap_or(false)
}

/// An image XObject whose stream bytes are already a plain JPEG — `DCTDecode`
/// is JPEG's PDF filter name, so the stream content needs no re-encoding, only
/// a `.jpg` extension. Any other filter (`FlateDecode`+raw samples, `CCITTFax`,
/// `JPXDecode`, …) would need real image reconstruction to become a normal
/// file, which this deliberately doesn't attempt.
fn is_jpeg_image_xobject(dict: &lopdf::Dictionary) -> bool {
    is_image_xobject(dict)
        && matches!(
            dict.get(b"Filter").and_then(|o| o.as_name()),
            Ok(b"DCTDecode")
        )
}

fn extract_pdf(file_path: &Path, dir: &Path) -> AppResult<BriefExtractResult> {
    let text = pdf_extract::extract_text(file_path).map_err(|e| {
        AppError::Msg(format!(
            "{} text extraction failed: {e}",
            file_path.display()
        ))
    })?;

    let doc = Document::load(file_path)
        .map_err(|e| AppError::Msg(format!("{} is not a valid PDF: {e}", file_path.display())))?;

    let mut images_written = Vec::new();
    let mut images_skipped = 0u32;
    let mut counter = 0u32;

    for (object_id, object) in doc.objects.iter() {
        let stream = match object {
            Object::Stream(s) => s,
            _ => continue,
        };
        if !is_jpeg_image_xobject(&stream.dict) {
            if is_image_xobject(&stream.dict) {
                images_skipped += 1;
            }
            continue;
        }
        counter += 1;
        let base_name = format!("image{counter}_{}_{}.jpg", object_id.0, object_id.1);
        images_written.push(write_extracted_image(dir, &base_name, &stream.content)?);
    }

    Ok(BriefExtractResult {
        text,
        images_written: images_written
            .into_iter()
            .map(|p| p.display().to_string())
            .collect(),
        images_skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aislap-brief-test-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn slide_number_parses_the_numeric_suffix() {
        assert_eq!(slide_number("ppt/slides/slide1.xml"), 1);
        assert_eq!(slide_number("ppt/slides/slide12.xml"), 12);
        // Numeric sort matters: lexicographic would put slide10 before slide2.
        let mut names = vec![
            "ppt/slides/slide10.xml".to_string(),
            "ppt/slides/slide2.xml".to_string(),
            "ppt/slides/slide1.xml".to_string(),
        ];
        names.sort_by_key(|n| slide_number(n));
        assert_eq!(
            names,
            vec![
                "ppt/slides/slide1.xml",
                "ppt/slides/slide2.xml",
                "ppt/slides/slide10.xml",
            ]
        );
    }

    #[test]
    fn slide_text_joins_runs_within_a_paragraph_and_breaks_between() {
        let xml = r#"<a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t>world</a:t></a:r></a:p></a:p><a:p><a:r><a:t>Second line</a:t></a:r></a:p>"#;
        assert_eq!(slide_text(xml), "Hello world\nSecond line");
    }

    #[test]
    fn slide_text_unescapes_entities_and_drops_empty_paragraphs() {
        let xml = r#"<a:p><a:t>Q&amp;A &lt;live&gt;</a:t></a:p><a:p></a:p>"#;
        assert_eq!(slide_text(xml), "Q&A <live>");
    }

    #[test]
    fn unescape_xml_handles_all_five_entities() {
        assert_eq!(unescape_xml("&amp;&lt;&gt;&quot;&apos;"), "&<>\"'");
    }

    #[test]
    fn is_jpeg_image_xobject_requires_both_image_subtype_and_dct_decode() {
        let mut jpeg = lopdf::Dictionary::new();
        jpeg.set("Subtype", Object::Name(b"Image".to_vec()));
        jpeg.set("Filter", Object::Name(b"DCTDecode".to_vec()));
        assert!(is_jpeg_image_xobject(&jpeg));
        assert!(is_image_xobject(&jpeg));

        let mut flate = lopdf::Dictionary::new();
        flate.set("Subtype", Object::Name(b"Image".to_vec()));
        flate.set("Filter", Object::Name(b"FlateDecode".to_vec()));
        assert!(!is_jpeg_image_xobject(&flate));
        assert!(
            is_image_xobject(&flate),
            "still an image, just not a JPEG one"
        );

        let mut not_image = lopdf::Dictionary::new();
        not_image.set("Subtype", Object::Name(b"Form".to_vec()));
        not_image.set("Filter", Object::Name(b"DCTDecode".to_vec()));
        assert!(!is_jpeg_image_xobject(&not_image));
        assert!(!is_image_xobject(&not_image));
    }

    #[test]
    fn write_extracted_image_uniquifies_on_collision() {
        let dir = temp_dir("collision");
        let first = write_extracted_image(&dir, "image1.png", b"first").unwrap();
        let second = write_extracted_image(&dir, "image1.png", b"second").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"first");
        assert_eq!(std::fs::read(&second).unwrap(), b"second");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Builds a minimal in-memory .pptx (two slides, two media files) and
    /// runs the real extractor end to end — the one fully-reliable path this
    /// module promises.
    #[test]
    fn extract_pptx_pulls_every_image_and_orders_slide_text_numerically() {
        let pptx_path = temp_dir("pptx-src").join("brief.pptx");
        {
            let file = std::fs::File::create(&pptx_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();

            zip.start_file("ppt/slides/slide2.xml", opts).unwrap();
            zip.write_all(br#"<a:p><a:t>Second</a:t></a:p>"#).unwrap();

            zip.start_file("ppt/slides/slide1.xml", opts).unwrap();
            zip.write_all(br#"<a:p><a:t>First</a:t></a:p>"#).unwrap();

            zip.start_file("ppt/media/image1.png", opts).unwrap();
            zip.write_all(b"fake-png-bytes").unwrap();

            zip.start_file("ppt/media/image2.jpeg", opts).unwrap();
            zip.write_all(b"fake-jpeg-bytes").unwrap();

            zip.finish().unwrap();
        }

        let out_dir = temp_dir("pptx-out");
        let result = extract_pptx(&pptx_path, &out_dir).expect("extraction succeeds");

        assert_eq!(result.images_written.len(), 2);
        assert_eq!(result.images_skipped, 0);
        assert_eq!(result.text, "## Slide 1\nFirst\n\n## Slide 2\nSecond");
        for path in &result.images_written {
            assert!(Path::new(path).exists());
        }

        let _ = std::fs::remove_dir_all(&out_dir);
        let _ = std::fs::remove_dir_all(pptx_path.parent().unwrap());
    }
}
