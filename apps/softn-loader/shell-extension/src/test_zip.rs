//! ZIPs for the tests, written byte by byte so that each can be made to lie.

use std::io::Write;

pub const LFH: u32 = 0x0403_4b50;
pub const CEN: u32 = 0x0201_4b50;
pub const EOCD: u32 = 0x0605_4b50;

pub struct Item<'a> {
    pub name: &'a str,
    pub bytes: Vec<u8>,
    pub deflate: bool,
}

pub fn file<'a>(name: &'a str, bytes: &[u8]) -> Item<'a> {
    Item { name, bytes: bytes.to_vec(), deflate: true }
}

pub fn stored<'a>(name: &'a str, bytes: &[u8]) -> Item<'a> {
    Item { name, bytes: bytes.to_vec(), deflate: false }
}

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(bytes);
    crc.sum()
}

/// A ZIP of `items`, with `tweak` given each central record before it is written.
pub fn zip_with(items: &[Item], tweak: impl Fn(usize, &mut Vec<u8>)) -> Vec<u8> {
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for (n, item) in items.iter().enumerate() {
        let packed = if item.deflate {
            let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&item.bytes).unwrap();
            encoder.finish().unwrap()
        } else {
            item.bytes.clone()
        };
        let method: u16 = if item.deflate { 8 } else { 0 };
        let crc = crc32(&item.bytes);
        let header = out.len() as u32;
        out.extend_from_slice(&LFH.to_le_bytes());
        out.extend_from_slice(&[20, 0, 0, 0]);
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(item.bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(&(item.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(item.name.as_bytes());
        out.extend_from_slice(&packed);
        let mut record = Vec::new();
        record.extend_from_slice(&CEN.to_le_bytes());
        record.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
        record.extend_from_slice(&method.to_le_bytes());
        record.extend_from_slice(&[0; 4]);
        record.extend_from_slice(&crc.to_le_bytes());
        record.extend_from_slice(&(packed.len() as u32).to_le_bytes());
        record.extend_from_slice(&(item.bytes.len() as u32).to_le_bytes());
        record.extend_from_slice(&(item.name.len() as u16).to_le_bytes());
        record.extend_from_slice(&[0; 12]);
        record.extend_from_slice(&header.to_le_bytes());
        record.extend_from_slice(item.name.as_bytes());
        tweak(n, &mut record);
        directory.extend_from_slice(&record);
    }
    let offset = out.len() as u32;
    out.extend_from_slice(&directory);
    out.extend_from_slice(&EOCD.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(items.len() as u16).to_le_bytes());
    out.extend_from_slice(&(items.len() as u16).to_le_bytes());
    out.extend_from_slice(&(directory.len() as u32).to_le_bytes());
    out.extend_from_slice(&offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

pub fn zip(items: &[Item]) -> Vec<u8> {
    zip_with(items, |_, _| {})
}
