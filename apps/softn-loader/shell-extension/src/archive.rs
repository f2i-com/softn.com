//! A bundle's ZIP, read as SoftN's runtime reads it (`@softn/bundle-format`'s
//! zip.ts), so the icon in a thumbnail is the icon the app has.
//!
//! This reader used to take the last end-of-archive signature anywhere in
//! the file, the first of two entries with one name, and an entry's sizes and
//! method from its local header. Each of those can be another file than the
//! one the runtime reads, and a ZIP where readers disagree has no single
//! meaning. Whatever the runtime refuses is refused here, and a refusal is no
//! thumbnail, never a different one.

use std::collections::HashMap;
use std::io::Read;

use flate2::read::DeflateDecoder;

/// The runtime's limits (zip.ts).
const MAX_INPUT_BYTES: usize = 200 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
const MAX_FILE_BYTES: u32 = 50 * 1024 * 1024;

const EOCD: u32 = 0x0605_4b50;
const EOCD64_LOCATOR: u32 = 0x0706_4b50;
const CEN: u32 = 0x0201_4b50;
const LFH: u32 = 0x0403_4b50;
const STORED: u16 = 0;
const DEFLATE: u16 = 8;

/// One file of the archive, as its central directory describes it.
pub struct Entry {
    method: u16,
    compressed: usize,
    size: u32,
    crc: u32,
    data: usize,
}

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(bytes);
    crc.sum()
}

/// A name no file inside a bundle can have: the runtime drops these (zip.ts
/// `isUnsafeEntryName`), so nothing here may find one.
fn is_unsafe(name: &str) -> bool {
    let bytes = name.as_bytes();
    name.starts_with('/')
        || name.contains("..")
        || name.contains('\0')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || name.split('/').any(|segment| segment == "." || segment.is_empty())
}

/// The name an Info-ZIP Unicode Path field (0x7075) gives an entry, when it is
/// one a reader acts on: version 1, written for this very header name.
fn unicode_path(extra: &[u8], header_name: &[u8]) -> Option<String> {
    let mut at = 0;
    while at + 4 <= extra.len() {
        let id = u16_at(extra, at)?;
        let length = u16_at(extra, at + 2)? as usize;
        let field = extra.get(at + 4..at + 4 + length)?;
        if id == 0x7075 && length >= 5 {
            if field[0] != 1 || u32_at(field, 1)? != crc32(header_name) {
                return None;
            }
            return Some(String::from_utf8_lossy(&field[5..]).replace('\\', "/"));
        }
        at += 4 + length;
    }
    None
}

/// The files of the archive by name, or nothing when the runtime would
/// refuse to open it.
pub fn entries(data: &[u8]) -> Option<HashMap<String, Entry>> {
    if data.len() > MAX_INPUT_BYTES || data.len() < 22 {
        return None;
    }
    // The end record: the last whose directory fits before it. Another that
    // names a directory of entries is a second archive in the one file.
    let lowest = data.len().saturating_sub(22 + 0xffff);
    let mut eocd = None;
    for i in (lowest..=data.len() - 22).rev() {
        if u32_at(data, i)? != EOCD {
            continue;
        }
        let size = u32_at(data, i + 12)? as usize;
        let offset = u32_at(data, i + 16)? as usize;
        if offset + size > i {
            continue;
        }
        if eocd.is_none() {
            eocd = Some(i);
            continue;
        }
        if u16_at(data, i + 10)? > 0 && offset + 4 <= i && u32_at(data, offset)? == CEN {
            return None;
        }
    }
    let eocd = eocd?;
    if eocd >= 20 && u32_at(data, eocd - 20)? == EOCD64_LOCATOR {
        return None;
    }
    let count = u16_at(data, eocd + 8)?;
    if count != u16_at(data, eocd + 10)? || count as usize > MAX_ENTRIES {
        return None;
    }
    let directory = u32_at(data, eocd + 16)? as usize;
    let directory_end = directory + u32_at(data, eocd + 12)? as usize;
    if directory_end != eocd {
        return None;
    }

    let mut files = HashMap::new();
    let mut names = std::collections::HashSet::new();
    let mut headers = std::collections::HashSet::new();
    let (mut compressed_total, mut size_total) = (0u64, 0u64);
    let mut at = directory;
    for _ in 0..count {
        if at + 46 > directory_end || u32_at(data, at)? != CEN {
            return None;
        }
        let flags = u16_at(data, at + 8)?;
        let method = u16_at(data, at + 10)?;
        let crc = u32_at(data, at + 16)?;
        let compressed = u32_at(data, at + 20)?;
        let size = u32_at(data, at + 24)?;
        let name_len = u16_at(data, at + 28)? as usize;
        let extra_len = u16_at(data, at + 30)? as usize;
        let comment_len = u16_at(data, at + 32)? as usize;
        let header = u32_at(data, at + 42)? as usize;
        let record_end = at + 46 + name_len + extra_len + comment_len;
        if record_end > directory_end
            || compressed == u32::MAX
            || size == u32::MAX
            || flags & 1 != 0
            || (method != STORED && method != DEFLATE)
            || (method == STORED && compressed != size)
            || size > MAX_FILE_BYTES
            || !headers.insert(header)
        {
            return None;
        }
        compressed_total += compressed as u64;
        size_total += size as u64;
        if compressed_total > data.len() as u64 || size_total > MAX_TOTAL_BYTES {
            return None;
        }
        // The data is found through the local header, whose name and extra
        // field may be longer or shorter than the directory's copy; its sizes
        // and method are not read.
        if u32_at(data, header)? != LFH || u16_at(data, header + 6)? & 1 != 0 {
            return None;
        }
        let start = header + 30 + u16_at(data, header + 26)? as usize + u16_at(data, header + 28)? as usize;
        if start + compressed as usize > data.len() {
            return None;
        }
        let name_bytes = &data[at + 46..at + 46 + name_len];
        let name = String::from_utf8_lossy(name_bytes).replace('\\', "/");
        let extra = &data[at + 46 + name_len..at + 46 + name_len + extra_len];
        if unicode_path(extra, name_bytes).is_some_and(|other| other != name) || !names.insert(name.clone()) {
            return None;
        }
        if !name.ends_with('/') && !is_unsafe(&name) {
            files.insert(name, Entry { method, compressed: compressed as usize, size, crc, data: start });
        }
        at = record_end;
    }
    if at != directory_end {
        return None;
    }
    Some(files)
}

/// An entry's bytes, when they are what its entry declares (its size and its
/// checksum) and no more than `max`.
pub fn read(data: &[u8], entry: &Entry, max: u64) -> Option<Vec<u8>> {
    if entry.size as u64 > max {
        return None;
    }
    let packed = data.get(entry.data..entry.data + entry.compressed)?;
    let bytes = match entry.method {
        STORED => packed.to_vec(),
        _ => {
            let mut out = Vec::new();
            DeflateDecoder::new(packed).take(entry.size as u64 + 1).read_to_end(&mut out).ok()?;
            out
        }
    };
    (bytes.len() == entry.size as usize && crc32(&bytes) == entry.crc).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_zip::{file, stored, zip, zip_with};

    fn icon_of(data: &[u8]) -> Option<Vec<u8>> {
        let files = entries(data)?;
        read(data, files.get("icon.png")?, 8 * 1024 * 1024)
    }

    #[test]
    fn a_well_formed_bundle_is_read() {
        let data = zip(&[file("manifest.json", b"{\"icon\":\"icon.png\"}"), stored("icon.png", b"PNG bytes")]);
        assert_eq!(icon_of(&data).as_deref(), Some(&b"PNG bytes"[..]));
    }

    #[test]
    fn two_entries_of_one_name_are_refused_not_chosen_between() {
        // The first won here and the last in the runtime.
        let data = zip(&[file("icon.png", b"first"), file("icon.png", b"second")]);
        assert!(entries(&data).is_none());
        // By the runtime's spelling of names too.
        let data = zip(&[file("assets/icon.png", b"a"), file("assets\\icon.png", b"b")]);
        assert!(entries(&data).is_none());
    }

    #[test]
    fn a_second_archive_behind_the_first_is_refused() {
        let first = zip(&[file("icon.png", b"shown here")]);
        let mut both = zip(&[file("icon.png", b"run there")]);
        // Two archives in one file, each end record naming a directory of its
        // own: this reader took the last, other readers the first.
        let shift = both.len() as u32;
        let mut second = first.clone();
        let eocd = second.len() - 22;
        let directory = u32_at(&second, eocd + 16).unwrap() + shift;
        second[eocd + 16..eocd + 20].copy_from_slice(&directory.to_le_bytes());
        // The second archive's records point at its own headers, past the first.
        let mut at = directory as usize - shift as usize;
        while u32_at(&second, at) == Some(CEN) {
            let header = u32_at(&second, at + 42).unwrap() + shift;
            second[at + 42..at + 46].copy_from_slice(&header.to_le_bytes());
            at += 46 + u16_at(&second, at + 28).unwrap() as usize;
        }
        both.extend_from_slice(&second);
        assert!(entries(&both).is_none());
    }

    #[test]
    fn a_directory_that_does_not_end_at_the_end_record_or_disagrees_is_refused() {
        let mut data = zip(&[file("icon.png", b"x")]);
        let eocd = data.len() - 22;
        // One byte between the directory and its end record.
        data.insert(eocd, 0);
        assert!(entries(&data).is_none());
        // Entry counts that disagree.
        let mut data = zip(&[file("icon.png", b"x")]);
        let eocd = data.len() - 22;
        data[eocd + 8] = 2;
        assert!(entries(&data).is_none());
        // A ZIP64 locator in front of the end record.
        let mut data = zip(&[file("icon.png", b"x")]);
        let eocd = data.len() - 22;
        let mut locator = EOCD64_LOCATOR.to_le_bytes().to_vec();
        locator.extend_from_slice(&[0; 16]);
        data.splice(eocd..eocd, locator);
        let eocd = data.len() - 22;
        let size = u32_at(&data, eocd + 12).unwrap() + 20;
        data[eocd + 12..eocd + 16].copy_from_slice(&size.to_le_bytes());
        assert!(entries(&data).is_none());
    }

    #[test]
    fn the_directory_not_the_local_header_says_what_an_entry_holds() {
        // A local header that declares another size: read by the directory's.
        let mut data = zip(&[stored("icon.png", b"exactly this")]);
        data[22..26].copy_from_slice(&3u32.to_le_bytes());
        data[18..22].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(icon_of(&data).as_deref(), Some(&b"exactly this"[..]));
        // Bytes that are not what the entry's checksum says are no icon.
        let mut data = zip(&[stored("icon.png", b"exactly this")]);
        let at = 30 + "icon.png".len();
        data[at] ^= 0xff;
        assert_eq!(icon_of(&data), None);
        // Nor is a stored entry whose two sizes differ, nor an encrypted one.
        let stored_sizes = zip_with(&[stored("icon.png", b"abc")], |_, record| record[24..28].copy_from_slice(&4u32.to_le_bytes()));
        assert!(entries(&stored_sizes).is_none());
        let encrypted = zip_with(&[file("icon.png", b"abc")], |_, record| record[8] |= 1);
        assert!(entries(&encrypted).is_none());
    }

    #[test]
    fn a_name_no_bundle_file_can_have_is_never_found() {
        for name in ["../icon.png", "/icon.png", "C:icon.png", "./icon.png", "a//icon.png"] {
            let data = zip(&[file(name, b"x")]);
            let files = entries(&data).expect(name);
            assert!(files.is_empty(), "{name} was indexed");
        }
    }

    #[test]
    fn a_unicode_path_naming_another_file_is_refused() {
        let data = zip_with(&[file("readme.txt", b"x")], |_, record| {
            let header_name = b"readme.txt";
            let mut field = vec![1u8];
            field.extend_from_slice(&crc32(header_name).to_le_bytes());
            field.extend_from_slice(b"icon.png");
            let mut extra = 0x7075u16.to_le_bytes().to_vec();
            extra.extend_from_slice(&(field.len() as u16).to_le_bytes());
            extra.extend_from_slice(&field);
            record[30..32].copy_from_slice(&(extra.len() as u16).to_le_bytes());
            record.extend_from_slice(&extra);
        });
        assert!(entries(&data).is_none());
    }

    #[test]
    fn an_entry_inflates_no_further_than_asked() {
        let data = zip(&[file("icon.png", &vec![0u8; 1024 * 1024])]);
        let files = entries(&data).unwrap();
        assert_eq!(read(&data, &files["icon.png"], 8 * 1024 * 1024).map(|d| d.len()), Some(1024 * 1024));
        assert!(read(&data, &files["icon.png"], 1024).is_none());
    }
}
