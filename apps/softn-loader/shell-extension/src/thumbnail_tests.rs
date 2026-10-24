//! The icon a thumbnail draws, found the way the shell asks for it.

use crate::test_zip::{stored, zip, zip_with};
use crate::SoftNThumbnailProvider;

fn icon(data: &[u8]) -> Option<Vec<u8>> {
    SoftNThumbnailProvider::new().find_icon_with_name_in_zip(data).map(|(bytes, _)| bytes)
}

const MANIFEST: &[u8] = br#"{"name":"App","icon":"icon.png"}"#;

/// Two entries of one name: the thumbnail took the first, the runtime the
/// last. The runtime refuses such a bundle now, and so the thumbnail is none.
#[test]
fn a_bundle_with_two_icons_of_one_name_has_no_thumbnail() {
    let data = zip(&[stored("manifest.json", MANIFEST), stored("icon.png", b"shown here"), stored("icon.png", b"the app's")]);
    assert_eq!(icon(&data), None);
}

/// An entry's local header that declares fewer bytes than its directory
/// record: the thumbnail read the local header's figure, the runtime the
/// directory's.
#[test]
fn the_icon_is_the_bytes_the_runtime_reads() {
    let data = zip(&[stored("manifest.json", MANIFEST), stored("icon.png", b"the whole icon")]);
    let header = data.windows(4).rposition(|w| w == crate::test_zip::LFH.to_le_bytes()).unwrap();
    let mut lying = data.clone();
    lying[header + 18..header + 22].copy_from_slice(&3u32.to_le_bytes());
    lying[header + 22..header + 26].copy_from_slice(&3u32.to_le_bytes());
    assert_eq!(icon(&lying).as_deref(), Some(&b"the whole icon"[..]));
}

/// An icon whose bytes are not what its entry's checksum says is no icon.
#[test]
fn an_icon_that_fails_its_checksum_is_no_icon() {
    let data = zip_with(&[stored("manifest.json", MANIFEST), stored("icon.png", b"the whole icon")], |n, record| {
        if n == 1 {
            record[16] ^= 0xff;
        }
    });
    assert_eq!(icon(&data), None);
}
