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
    Ok(if image.color().has_alpha() { on_white(image) } else { image })
}

/// A photo with transparency, laid over white: what the PHP host hands a
/// handler for the same upload (it fills its canvas white and draws the photo
/// on it). The JPEG written below has no alpha channel, and dropping the
/// channel instead left whatever colour sat under the transparency, which is
/// black for most files: a logo on a clear background came back on a black
/// one. Done before the photo is made smaller, so that an edge is the average
/// of what is seen and not of what was hidden.
fn on_white(image: DynamicImage) -> DynamicImage {
    let mut pixels = image.into_rgba8();
    for pixel in pixels.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
        pixel[3] = 255;
    }
    DynamicImage::ImageRgba8(pixels)
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
    if !matches!(kind, "data:image/jpeg;base64" | "data:image/png;base64" | "data:image/webp;base64") {
        return Err("Use a still JPEG, PNG or WebP photo".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid photo encoding")?;
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err("Use a photo smaller than 4 MB".into());
    }
    // What the photo is, is what its bytes say, as on the PHP host. The label
    // comes from the browser, which goes by the file's extension: a PNG saved
    // as `photo.jpg` arrives as `image/jpeg`, and used to be refused here for
    // not being what it was called.
    let format = image::guess_format(&bytes).map_err(|_| "Invalid photo")?;
    let input = Cursor::new(&bytes);
    let image = match format {
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
        _ => return Err("Use a still JPEG, PNG or WebP photo".into()),
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
    fn url(mime: &str, bytes: &[u8]) -> String {
        format!("data:image/{mime};base64,{}", STANDARD.encode(bytes))
    }

    fn encoded(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }

    /// What shows through a transparent photo is white, as the PHP host
    /// paints it. The alpha channel used to be dropped, which left whatever
    /// colour lay under the transparency: black, as a rule, so a logo on a
    /// clear background came back on a black one from this host.
    #[test]
    fn transparency_is_painted_white() {
        let mut picture = image::RgbaImage::new(64, 64);
        for (x, _, pixel) in picture.enumerate_pixels_mut() {
            // Left half solid red, right half clear, and a half-clear blue stripe between.
            *pixel = match x {
                0..=27 => image::Rgba([255, 0, 0, 255]),
                28..=35 => image::Rgba([0, 0, 255, 128]),
                _ => image::Rgba([0, 0, 0, 0]),
            };
        }
        let png = encoded(&DynamicImage::ImageRgba8(picture), ImageFormat::Png);
        let result = sanitize_photo(&url("png", &png)).unwrap();
        let jpeg = STANDARD.decode(result["image"].as_str().unwrap().split_once(',').unwrap().1).unwrap();
        let shown = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        let at = |x: u32| shown.get_pixel(x, 32).0;
        assert!(at(52).iter().all(|channel| *channel > 240), "clear came out as {:?}", at(52));
        assert!(at(10)[0] > 200 && at(10)[1] < 60 && at(10)[2] < 60, "solid red came out as {:?}", at(10));
        // Half-clear blue over white: pale blue, not dark blue.
        assert!(at(32)[0] > 90 && at(32)[2] > 200, "half-clear blue came out as {:?}", at(32));
    }

    /// The bytes say what a photo is, as on the PHP host; the label only has
    /// to name one of the three types taken. A PNG a browser labelled
    /// `image/jpeg` (it goes by the file's extension) used to be refused here
    /// and taken there.
    #[test]
    fn the_type_is_read_from_the_bytes_not_the_label() {
        let picture = DynamicImage::new_rgb8(64, 64);
        let png = encoded(&picture, ImageFormat::Png);
        let jpeg = encoded(&picture, ImageFormat::Jpeg);
        assert_eq!(sanitize_photo(&url("jpeg", &png)).unwrap()["sanitized"], true);
        assert_eq!(sanitize_photo(&url("webp", &jpeg)).unwrap()["sanitized"], true);
        assert_eq!(sanitize_photo(&url("png", &jpeg)).unwrap()["sanitized"], true);
        // Still one of the three, in the label and in the bytes.
        assert!(sanitize_photo(&url("gif", &png)).is_err());
        assert!(sanitize_photo(&url("png", b"GIF89a not one of them")).is_err());
        // Animation is read from the PNG's chunks on both hosts: the letters
        // `acTL` in a comment are a comment (the PHP host looked for the four
        // bytes anywhere in the file).
        let comment = b"Comment\0made with an acTL-free tool";
        let mut chunk = (comment.len() as u32).to_be_bytes().to_vec();
        chunk.extend_from_slice(b"tEXt");
        chunk.extend_from_slice(comment);
        chunk.extend_from_slice(&[0, 0, 0, 0]);
        let mut commented = png[..33].to_vec();
        commented.extend_from_slice(&chunk);
        commented.extend_from_slice(&png[33..]);
        assert!(sanitize_photo(&url("png", &commented)).is_ok());
        // And an animated one is refused whatever it is called.
        let animated = include_bytes!("../../tests/fixtures/animated.png");
        assert!(sanitize_photo(&url("jpeg", animated)).unwrap_err().contains("Animated"));
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
