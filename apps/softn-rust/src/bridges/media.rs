//! Still-photo sanitation with no filesystem or network access. Output is a new
//! JPEG containing pixels only; no input EXIF, GPS, ICC, XMP or PNG text survives.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::{
        jpeg::{JpegDecoder, JpegEncoder},
        png::PngDecoder,
        webp::WebPDecoder,
    },
    DynamicImage, ImageDecoder, ImageFormat, Limits,
};
use std::io::Cursor;

pub const MAX_PHOTO_BYTES: usize = 4_000_000;
pub const MAX_PHOTO_PIXELS: u64 = 16_000_000;

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits
}

fn decode<D: ImageDecoder>(mut decoder: D) -> Result<DynamicImage, String> {
    decoder
        .set_limits(limits())
        .map_err(|_| "Photo exceeds decoder limits")?;
    let (width, height) = decoder.dimensions();
    if width < 32
        || height < 32
        || u64::from(width) * u64::from(height) > MAX_PHOTO_PIXELS
        || decoder.total_bytes() > 64 * 1024 * 1024
    {
        return Err("Use a photo between 32 pixels and 16 megapixels".into());
    }
    let orientation = decoder
        .orientation()
        .map_err(|_| "Invalid photo orientation metadata")?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| "Photo decoding failed")?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn jpeg(image: &DynamicImage, side: u32, max_bytes: usize) -> Result<String, String> {
    let resized = image
        .thumbnail(side.min(image.width()), side.min(image.height()))
        .to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 82)
        .encode_image(&resized)
        .map_err(|_| "Photo encoding failed")?;
    if bytes.len() > max_bytes {
        return Err("Photo is too complex; resize it before uploading".into());
    }
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}

pub fn sanitize_photo(data_url: &str) -> Result<serde_json::Value, String> {
    if data_url.len() > 5_600_000 {
        return Err("Use a photo smaller than 4 MB".into());
    }
    let (kind, encoded) = data_url
        .split_once(',')
        .ok_or("Use a JPEG, PNG or WebP photo")?;
    let expected = match kind {
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/webp;base64" => ImageFormat::WebP,
        _ => return Err("Use a still JPEG, PNG or WebP photo".into()),
    };
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid photo encoding")?;
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err("Use a photo smaller than 4 MB".into());
    }
    if image::guess_format(&bytes).map_err(|_| "Invalid photo")? != expected {
        return Err("Photo content does not match its declared image type".into());
    }
    let input = Cursor::new(&bytes);
    let image = match expected {
        ImageFormat::Jpeg => decode(JpegDecoder::new(input).map_err(|_| "Invalid JPEG photo")?)?,
        ImageFormat::Png => {
            let decoder =
                PngDecoder::with_limits(input, limits()).map_err(|_| "Invalid PNG photo")?;
            if decoder
                .is_apng()
                .map_err(|_| "Invalid PNG animation metadata")?
            {
                return Err("Animated photos are not supported".into());
            }
            decode(decoder)?
        }
        ImageFormat::WebP => {
            let decoder = WebPDecoder::new(input).map_err(|_| "Invalid WebP photo")?;
            if decoder.has_animation() {
                return Err("Animated photos are not supported".into());
            }
            decode(decoder)?
        }
        _ => return Err("Unsupported photo format".into()),
    };
    Ok(serde_json::json!({"sanitized":true,
        "image":jpeg(&image, 960, 400_000)?,
        "thumbnail":jpeg(&image, 240, 60_000)?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strips_private_metadata_applies_orientation_and_rejects_animation() {
        let oriented = include_bytes!("../../tests/fixtures/oriented.jpg");
        let result = sanitize_photo(&format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(oriented)
        ))
        .unwrap();
        let bytes = STANDARD
            .decode(result["image"].as_str().unwrap().split_once(',').unwrap().1)
            .unwrap();
        let mut decoder = JpegDecoder::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(decoder.dimensions(), (32, 48));
        assert!(decoder.exif_metadata().unwrap().is_none());
        assert!(!bytes.windows(7).any(|window| window == b"private"));
        for (bytes, mime) in [
            (
                include_bytes!("../../tests/fixtures/animated.png").as_slice(),
                "png",
            ),
            (
                include_bytes!("../../tests/fixtures/animated.webp").as_slice(),
                "webp",
            ),
        ] {
            assert!(sanitize_photo(&format!(
                "data:image/{mime};base64,{}",
                STANDARD.encode(bytes)
            ))
            .unwrap_err()
            .contains("Animated"));
        }
    }
    #[test]
    fn sanitizes_still_formats_and_bounds_output() {
        let image = DynamicImage::new_rgb8(1200, 800);
        for (format, mime) in [
            (ImageFormat::Jpeg, "jpeg"),
            (ImageFormat::Png, "png"),
            (ImageFormat::WebP, "webp"),
        ] {
            let mut input = Cursor::new(Vec::new());
            image.write_to(&mut input, format).unwrap();
            let result = sanitize_photo(&format!(
                "data:image/{mime};base64,{}",
                STANDARD.encode(input.into_inner())
            ))
            .unwrap();
            assert_eq!(result["sanitized"], true);
            for (field, side) in [("image", 960), ("thumbnail", 240)] {
                let bytes = STANDARD
                    .decode(result[field].as_str().unwrap().split_once(',').unwrap().1)
                    .unwrap();
                let decoder = JpegDecoder::new(Cursor::new(bytes)).unwrap();
                let (width, height) = decoder.dimensions();
                assert!(width <= side && height <= side);
            }
        }
    }
    #[test]
    fn rejects_unsupported_malformed_and_oversized_photos() {
        assert!(sanitize_photo("data:image/svg+xml;base64,PHN2Zy8+").is_err());
        assert!(sanitize_photo("data:image/jpeg;base64,bad!").is_err());
        assert!(sanitize_photo(&"x".repeat(5_600_001)).is_err());
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(20, 20)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        assert!(sanitize_photo(&format!(
            "data:image/png;base64,{}",
            STANDARD.encode(bytes.into_inner())
        ))
        .is_err());
    }
}
