//! What a WebGL draw may read, worked out with no OpenGL in it.
//!
//! `webgl.rs` is built only for Android and needs a GL context, so nothing in
//! it runs under `cargo test`. OpenGL ES takes a draw call on trust: an index
//! past the end of a vertex buffer is read from whatever lies after it, and
//! the context is made without robust buffer access. What stands between a
//! page and that read is arithmetic, and the arithmetic is here, in plain
//! functions over plain values, where the host's tests run it:
//!
//! - the largest index a `drawElements` reads ([`max_index`], over the copy
//!   of each element array buffer that [`IndexBuffers`] keeps),
//! - how many elements a vertex buffer holds for an attribute's layout
//!   ([`elements_in_buffer`]),
//! - which enabled arrays a draw has to be checked against
//!   ([`range_checked`], from what [`ProgramReads`] says the program in use
//!   reads), and
//! - the decision itself ([`validate_draw`]).
//!
//! `webgl.rs` gathers what the page set and asks; it decides nothing.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

// OpenGL's names for what is judged here, as `glow` has them (`webgl.rs`
// asserts that they agree; `glow` is not a dependency of a host build).
pub(crate) const BYTE: u32 = 0x1400;
pub(crate) const UNSIGNED_BYTE: u32 = 0x1401;
pub(crate) const SHORT: u32 = 0x1402;
pub(crate) const UNSIGNED_SHORT: u32 = 0x1403;
pub(crate) const INT: u32 = 0x1404;
pub(crate) const UNSIGNED_INT: u32 = 0x1405;
pub(crate) const FLOAT: u32 = 0x1406;
pub(crate) const HALF_FLOAT: u32 = 0x140B;
pub(crate) const UNSIGNED_INT_2_10_10_10_REV: u32 = 0x8368;
pub(crate) const INT_2_10_10_10_REV: u32 = 0x8D9F;

pub(crate) const ELEMENT_ARRAY_BUFFER: u32 = 0x8893;
pub(crate) const COPY_READ_BUFFER: u32 = 0x8F36;
pub(crate) const COPY_WRITE_BUFFER: u32 = 0x8F37;

pub(crate) const STREAM_DRAW: u32 = 0x88E0;
pub(crate) const STREAM_READ: u32 = 0x88E1;
pub(crate) const STREAM_COPY: u32 = 0x88E2;
pub(crate) const STATIC_DRAW: u32 = 0x88E4;
pub(crate) const STATIC_READ: u32 = 0x88E5;
pub(crate) const STATIC_COPY: u32 = 0x88E6;
pub(crate) const DYNAMIC_DRAW: u32 = 0x88E8;
pub(crate) const DYNAMIC_READ: u32 = 0x88E9;
pub(crate) const DYNAMIC_COPY: u32 = 0x88EA;

pub(crate) const FLOAT_MAT2: u32 = 0x8B5A;
pub(crate) const FLOAT_MAT3: u32 = 0x8B5B;
pub(crate) const FLOAT_MAT4: u32 = 0x8B5C;
pub(crate) const FLOAT_MAT2X3: u32 = 0x8B65;
pub(crate) const FLOAT_MAT2X4: u32 = 0x8B66;
pub(crate) const FLOAT_MAT3X2: u32 = 0x8B67;
pub(crate) const FLOAT_MAT3X4: u32 = 0x8B68;
pub(crate) const FLOAT_MAT4X2: u32 = 0x8B69;
pub(crate) const FLOAT_MAT4X3: u32 = 0x8B6A;

/// The most ranges of one index buffer whose largest index is remembered.
/// A page drawing more distinct ranges than this has them counted again.
const MAX_CACHED_RANGES: usize = 64;

/// Bytes in one index of `index_type`, or None for a type that is not one.
pub(crate) fn index_bytes(index_type: u32) -> Option<usize> {
    match index_type {
        UNSIGNED_BYTE => Some(1),
        UNSIGNED_SHORT => Some(2),
        UNSIGNED_INT => Some(4),
        _ => None,
    }
}

/// The largest of the `count` indices of `index_type` that start `offset`
/// bytes into `data`: the highest vertex a `drawElements` over them reads.
/// None when they read none; an error where the driver would be handed a
/// type it does not have, an offset that is not a whole number of indices,
/// or a range that is not all inside `data`.
///
/// With `restart` (every WebGL 2 context the host can switch it on for), the
/// largest value of the index type (`0xFF`, `0xFFFF`, `0xFFFFFFFF`) ends a
/// primitive and names no vertex, so it is left out, and a range of nothing
/// else reads no vertex at all. Without it (WebGL 1), every value counts, the
/// largest of its type included: the driver reads vertex 65535 for a `0xFFFF`
/// like any other.
pub(crate) fn largest_index(
    data: &[u8],
    index_type: u32,
    offset: usize,
    count: usize,
    restart: bool,
) -> Result<Option<u32>, String> {
    let width = index_bytes(index_type)
        .ok_or_else(|| format!("InvalidEnumError: invalid drawElements index type {index_type:#x}"))?;
    if offset % width != 0 {
        return Err("InvalidOperationError: drawElements offset must be aligned to index type size".into());
    }
    let end = count
        .checked_mul(width)
        .and_then(|bytes| bytes.checked_add(offset))
        .ok_or_else(|| "InvalidValueError: drawElements range overflow".to_string())?;
    let indices = data
        .get(offset..end)
        .ok_or_else(|| "InvalidOperationError: drawElements index range exceeds ELEMENT_ARRAY_BUFFER size".to_string())?;
    // The driver reads them in the machine's byte order, as the page wrote them.
    let restart_index = match width {
        1 => u32::from(u8::MAX),
        2 => u32::from(u16::MAX),
        _ => u32::MAX,
    };
    let vertex = |value: &u32| !restart || *value != restart_index;
    Ok(match width {
        1 => indices.iter().map(|&i| u32::from(i)).filter(vertex).max(),
        2 => indices.chunks_exact(2).map(|i| u32::from(u16::from_ne_bytes([i[0], i[1]]))).filter(vertex).max(),
        _ => indices.chunks_exact(4).map(|i| u32::from_ne_bytes([i[0], i[1], i[2], i[3]])).filter(vertex).max(),
    })
}

/// Bytes in one element of a vertex attribute of `size` components of `ty`,
/// or None for what `vertexAttribPointer` does not take.
pub(crate) fn attrib_element_bytes(size: i32, ty: u32) -> Option<usize> {
    if !(1..=4).contains(&size) {
        return None;
    }
    if ty == INT_2_10_10_10_REV || ty == UNSIGNED_INT_2_10_10_10_REV {
        return if size == 4 { Some(4) } else { None };
    }
    let component = match ty {
        BYTE | UNSIGNED_BYTE => 1usize,
        SHORT | UNSIGNED_SHORT | HALF_FLOAT => 2usize,
        INT | UNSIGNED_INT | FLOAT => 4usize,
        _ => return None,
    };
    Some((size as usize) * component)
}

/// Whether the driver takes a `vertexAttribPointer` (`integer`: a
/// `vertexAttribIPointer`) with these arguments on an OpenGL ES 3 context
/// (`es3`) or an ES 2 one.
///
/// The host remembers the pointer it was asked for and checks draws against
/// that. A call the driver refuses leaves the driver on the pointer it had,
/// into whichever buffer that was, so one the driver would refuse must not be
/// remembered: `vertexAttribIPointer` with a float type is such a call, and
/// so are an ES 3 type on ES 2 and a stride past WebGL's 255 (newer drivers
/// have a limit of their own).
pub(crate) fn attrib_pointer_ok(size: i32, ty: u32, stride: i32, offset: i32, integer: bool, es3: bool) -> bool {
    if attrib_element_bytes(size, ty).is_none() || !(0..=255).contains(&stride) || offset < 0 {
        return false;
    }
    let small_integer = matches!(ty, BYTE | UNSIGNED_BYTE | SHORT | UNSIGNED_SHORT);
    if integer {
        es3 && (small_integer || matches!(ty, INT | UNSIGNED_INT))
    } else {
        es3 || small_integer || ty == FLOAT
    }
}

/// How a vertex attribute reads its buffer, as `vertexAttribPointer` and
/// `vertexAttribDivisor` set it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct AttribLayout {
    pub size: i32,
    pub ty: u32,
    pub stride: i32,
    pub offset: i32,
    pub divisor: u32,
}

/// How many elements of `layout` a buffer of `buffer_len` bytes holds: the
/// driver reads element `n` from `offset + n * stride`, a whole element at a
/// time, so the last one has to end inside the buffer. None for a layout
/// that is not one.
pub(crate) fn elements_in_buffer(buffer_len: usize, layout: &AttribLayout) -> Option<u64> {
    let element = attrib_element_bytes(layout.size, layout.ty)? as u64;
    if layout.stride < 0 || layout.offset < 0 {
        return None;
    }
    let stride = if layout.stride == 0 { element } else { layout.stride as u64 };
    let Some(after_first) = (buffer_len as u64).checked_sub(layout.offset as u64 + element) else {
        return Some(0);
    };
    Some(after_first / stride + 1)
}

/// What an enabled vertex attribute array is pointed at.
#[derive(Clone, Copy, Debug)]
pub(crate) enum AttribSource {
    /// `vertexAttribPointer` was never called for it.
    NoPointer,
    /// Its buffer was deleted, or it only ever had a divisor set.
    NoBuffer,
    /// A buffer of `len` bytes (None: one that was never given storage).
    Buffer { len: Option<usize>, layout: AttribLayout },
}

/// One enabled vertex attribute array of the vertex array a draw uses.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EnabledAttrib {
    pub index: u32,
    pub source: AttribSource,
}

/// A draw call's arguments, as the page gave them.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DrawCall {
    pub first: i32,
    pub count: i32,
    /// None for a draw that is not instanced.
    pub instances: Option<i32>,
    /// `drawElements`: the index type, and the byte offset of the first
    /// index in the element array buffer.
    pub indexed: Option<(u32, i32)>,
}

/// Whether a draw has to check the enabled array at `index` against its
/// buffer: every one when what the program reads is not known (`reads` is
/// None), and otherwise the ones the program reads.
///
/// An enabled array the program in use does not read is not fetched, and
/// WebGL does not hold a draw to it: a page that leaves the last mesh's
/// arrays enabled may draw the next one, larger, with a program that reads
/// fewer.
pub(crate) fn range_checked(index: u32, reads: Option<&HashSet<u32>>) -> bool {
    reads.is_none_or(|reads| reads.contains(&index))
}

/// Whether the driver may run `call`: every enabled array has a buffer, and
/// each one the program reads ([`range_checked`]) holds the last element the
/// draw reads from it. For `drawElements` that is the largest index among
/// the ones drawn, from the copy of `element_buffer` in `index`; for an
/// instanced array, the last instance over its divisor.
///
/// An enabled array with no pointer or no buffer is an error whether the
/// program reads it or not, as it is in WebGL.
pub(crate) fn validate_draw<K: Copy + Eq + Hash>(
    index: &mut IndexBuffers<K>,
    element_buffer: Option<K>,
    call: &DrawCall,
    attribs: impl IntoIterator<Item = EnabledAttrib>,
    reads: Option<&HashSet<u32>>,
) -> Result<(), String> {
    if call.first < 0 || call.count < 0 || call.instances.is_some_and(|n| n < 0) {
        return Err("InvalidValueError: draw argument out of range".into());
    }
    if call.count == 0 || call.instances == Some(0) {
        return Ok(());
    }
    let last_vertex = match call.indexed {
        Some((index_type, offset)) => {
            let buffer = element_buffer
                .ok_or_else(|| "InvalidOperationError: drawElements requires a bound ELEMENT_ARRAY_BUFFER".to_string())?;
            if offset < 0 {
                return Err("InvalidValueError: drawElements offset out of range".into());
            }
            match index.max_index(buffer, index_type, offset as usize, call.count as usize)? {
                Some(max) => u64::from(max),
                None => return Ok(()),
            }
        }
        None => call.first as u64 + (call.count as u64 - 1),
    };
    let last_instance = call.instances.map_or(0, |n| n as u64 - 1);
    for attrib in attribs {
        let idx = attrib.index;
        let (len, layout) = match attrib.source {
            AttribSource::NoPointer => {
                return Err(format!(
                    "InvalidOperationError: enabled vertex attribute {idx} has no ARRAY_BUFFER pointer"
                ));
            }
            AttribSource::NoBuffer => {
                return Err(format!(
                    "InvalidOperationError: enabled vertex attribute {idx} references a deleted or unbound ARRAY_BUFFER"
                ));
            }
            AttribSource::Buffer { len, layout } => (len, layout),
        };
        if !range_checked(idx, reads) {
            continue;
        }
        let Some(len) = len else {
            return Err(format!(
                "InvalidOperationError: enabled vertex attribute {idx} has no allocated ARRAY_BUFFER storage"
            ));
        };
        let held = elements_in_buffer(len, &layout)
            .ok_or_else(|| format!("InvalidOperationError: invalid vertex attribute {idx} format"))?;
        let last = if layout.divisor > 0 { last_instance / u64::from(layout.divisor) } else { last_vertex };
        if last >= held {
            return Err(format!(
                "InvalidOperationError: vertex attribute {idx} reads element {last}, and its ARRAY_BUFFER ({len} B) holds {held}"
            ));
        }
    }
    Ok(())
}

/// The locations an active attribute of type `atype` at `location` takes:
/// one, or one for each column of a matrix (times `size`, for an array of
/// them, which OpenGL ES does not have but a driver may report).
pub(crate) fn attrib_locations(location: u32, atype: u32, size: i32) -> std::ops::Range<u32> {
    let columns = match atype {
        FLOAT_MAT2 | FLOAT_MAT2X3 | FLOAT_MAT2X4 => 2,
        FLOAT_MAT3 | FLOAT_MAT3X2 | FLOAT_MAT3X4 => 3,
        FLOAT_MAT4 | FLOAT_MAT4X2 | FLOAT_MAT4X3 => 4,
        _ => 1u32,
    };
    location..location.saturating_add(columns.saturating_mul(size.max(1) as u32))
}

/// The attribute locations read by the program a draw runs: what each
/// program read when it was last linked, and what the executable in use
/// reads, which is not always the same thing.
///
/// OpenGL keeps running a program's old executable after a link of it fails,
/// until another is put in use, and a `useProgram` it refuses changes
/// nothing. So this follows the driver, not the page: `webgl.rs` reports each
/// link as it turned out and, after each `useProgram`, the program the driver
/// says is current. Where the answer is not known for certain it is None,
/// and every enabled array is checked.
pub(crate) struct ProgramReads<P> {
    linked: HashMap<P, Option<HashSet<u32>>>,
    current: Option<P>,
    in_use: Option<HashSet<u32>>,
}

impl<P: Copy + Eq + Hash> ProgramReads<P> {
    pub(crate) fn new() -> Self {
        ProgramReads { linked: HashMap::new(), current: None, in_use: None }
    }

    /// `program` linked, and reads the attributes at `reads` (None: they
    /// could not all be found). Linking the program in use puts its new
    /// executable in use at once.
    pub(crate) fn linked(&mut self, program: P, reads: Option<HashSet<u32>>) {
        if self.current == Some(program) {
            self.in_use.clone_from(&reads);
        }
        self.linked.insert(program, reads);
    }

    /// A link of `program` failed: it cannot be put in use until one
    /// succeeds, and if it is in use its old executable stays.
    pub(crate) fn link_failed(&mut self, program: P) {
        self.linked.remove(&program);
    }

    /// The driver's current program after a `useProgram`. The same one as
    /// before is the same executable (the call was refused, or changed
    /// nothing); another is that program as it last linked.
    pub(crate) fn used(&mut self, current: Option<P>) {
        if current == self.current {
            return;
        }
        self.current = current;
        self.in_use = current.and_then(|program| self.linked.get(&program).cloned().flatten());
    }

    /// `program` was deleted. If it is in use the driver keeps it until
    /// another is, and so does this.
    pub(crate) fn deleted(&mut self, program: P) {
        self.linked.remove(&program);
    }

    /// The locations the executable in use reads, if that is known.
    pub(crate) fn in_use(&self) -> Option<&HashSet<u32>> {
        self.in_use.as_ref()
    }
}

/// Which of WebGL's two kinds a buffer is, from the first target it was
/// bound to. WebGL holds a buffer to its kind so that index data cannot be
/// written by anything that does not say so: not as vertex data, not by a
/// transform feedback or a `readPixels` into it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BufferKind {
    Element,
    Other,
}

/// A buffer's bytes as the host accounts for them: an element array buffer
/// twice over, once for the driver's and once for the copy kept here.
pub(crate) fn tracked_bytes(len: usize, kind_is_element: bool) -> usize {
    if kind_is_element { len.saturating_mul(2) } else { len }
}

/// Whether `usage` is one `bufferData` takes on this context. With one it
/// does not take, the driver keeps the buffer it had, which is not the
/// buffer the host would then believe it has.
pub(crate) fn buffer_usage_ok(usage: u32, es3: bool) -> bool {
    matches!(usage, STREAM_DRAW | STATIC_DRAW | DYNAMIC_DRAW)
        || (es3 && matches!(usage, STREAM_READ | STREAM_COPY | STATIC_READ | STATIC_COPY | DYNAMIC_READ | DYNAMIC_COPY))
}

/// Where a `bufferSubData` of `len` bytes at `offset` starts in a buffer of
/// `buffer_len`, or the error the driver would answer it with.
pub(crate) fn sub_data_start(buffer_len: usize, offset: i32, len: usize) -> Result<usize, String> {
    let start = usize::try_from(offset).map_err(|_| "InvalidValueError: bufferSubData offset is negative".to_string())?;
    match start.checked_add(len) {
        Some(end) if end <= buffer_len => Ok(start),
        _ => Err(format!(
            "InvalidValueError: bufferSubData of {len} B at {start} is outside the buffer ({buffer_len} B)"
        )),
    }
}

/// A `copyBufferSubData`'s read offset, write offset and length, checked
/// against the two buffers' sizes (and against each other, when the two are
/// one buffer), or the error the driver would answer it with.
pub(crate) fn copy_ranges(
    read_len: usize,
    write_len: usize,
    read_offset: i32,
    write_offset: i32,
    size: i32,
    same_buffer: bool,
) -> Result<(usize, usize, usize), String> {
    let (Ok(from), Ok(to), Ok(len)) = (usize::try_from(read_offset), usize::try_from(write_offset), usize::try_from(size))
    else {
        return Err("InvalidValueError: copyBufferSubData offset or size is negative".into());
    };
    // No overflow: each is at most i32::MAX.
    if from + len > read_len || to + len > write_len {
        return Err("InvalidValueError: copyBufferSubData range is outside a buffer".into());
    }
    if same_buffer && from < to + len && to < from + len {
        return Err("InvalidValueError: copyBufferSubData ranges overlap".into());
    }
    Ok((from, to, len))
}

struct IndexData {
    bytes: Vec<u8>,
    /// The largest index of ranges already drawn, by (type, offset, count).
    /// Emptied by every write to the buffer.
    ranges: HashMap<(u32, usize, usize), u32>,
}

/// Every buffer's kind, and a copy of what each element array buffer holds:
/// what the driver will read as indices, to be looked through before it does.
///
/// The copy is right only if every write to such a buffer comes through
/// here. `bufferData`, `bufferSubData` and `copyBufferSubData` do; the
/// writes that would not (transform feedback, `readPixels` into a buffer,
/// uploads as vertex data) cannot reach one, because [`IndexBuffers::bind`]
/// keeps a buffer to its kind.
pub(crate) struct IndexBuffers<K> {
    kinds: HashMap<K, BufferKind>,
    data: HashMap<K, IndexData>,
    /// Whether the context restarts primitives ([`largest_index`]): fixed
    /// for its life, so the largest indices remembered need not say.
    restart: bool,
}

impl<K: Copy + Eq + Hash> IndexBuffers<K> {
    pub(crate) fn new(restart: bool) -> Self {
        IndexBuffers { kinds: HashMap::new(), data: HashMap::new(), restart }
    }

    /// `buffer` is being bound to `target`: it takes that target's kind if
    /// it has none, and is refused if it has the other. The two copy
    /// targets take either kind, and make a buffer with none an ordinary
    /// one, as in WebGL 2.
    pub(crate) fn bind(&mut self, buffer: K, target: u32) -> Result<(), String> {
        let wanted = match target {
            ELEMENT_ARRAY_BUFFER => BufferKind::Element,
            COPY_READ_BUFFER | COPY_WRITE_BUFFER => match self.kinds.get(&buffer) {
                Some(_) => return Ok(()),
                None => BufferKind::Other,
            },
            _ => BufferKind::Other,
        };
        match self.kinds.get(&buffer) {
            Some(&kind) if kind != wanted => Err(format!(
                "InvalidOperationError: a buffer bound as {} cannot be bound to target {target:#x}",
                if kind == BufferKind::Element { "ELEMENT_ARRAY_BUFFER" } else { "vertex or other data" }
            )),
            Some(_) => Ok(()),
            None => {
                self.kinds.insert(buffer, wanted);
                Ok(())
            }
        }
    }

    pub(crate) fn is_element(&self, buffer: K) -> bool {
        self.kinds.get(&buffer) == Some(&BufferKind::Element)
    }

    /// `bufferData`: `buffer` now holds `bytes` and nothing else.
    pub(crate) fn set_data(&mut self, buffer: K, bytes: &[u8]) {
        if self.is_element(buffer) {
            self.data.insert(buffer, IndexData { bytes: bytes.to_vec(), ranges: HashMap::new() });
        }
    }

    /// `bufferSubData`: `bytes` written `offset` bytes into `buffer`. An
    /// error, and nothing written, if an element array buffer's copy has no
    /// such range: the driver must not be given the write either.
    pub(crate) fn write(&mut self, buffer: K, offset: usize, bytes: &[u8]) -> Result<(), String> {
        if !self.is_element(buffer) {
            return Ok(());
        }
        let range = offset.checked_add(bytes.len()).map(|end| offset..end);
        let Some(into) = range.and_then(|range| self.data.get_mut(&buffer)?.bytes.get_mut(range)) else {
            return Err("InvalidValueError: bufferSubData range is outside the ELEMENT_ARRAY_BUFFER".into());
        };
        into.copy_from_slice(bytes);
        self.forget_ranges(buffer);
        Ok(())
    }

    /// `copyBufferSubData`: `len` bytes from `read_offset` in `read` to
    /// `write_offset` in `write`. WebGL 2 refuses a copy between the two
    /// kinds, which is what keeps vertex data (and so anything a transform
    /// feedback wrote) out of an index buffer.
    pub(crate) fn copy(&mut self, read: K, write: K, read_offset: usize, write_offset: usize, len: usize) -> Result<(), String> {
        let (Some(&from_kind), Some(&to_kind)) = (self.kinds.get(&read), self.kinds.get(&write)) else {
            return Err("InvalidOperationError: copyBufferSubData requires two bound buffers".into());
        };
        if from_kind != to_kind {
            return Err(
                "InvalidOperationError: copyBufferSubData between an ELEMENT_ARRAY_BUFFER and another kind of buffer".into(),
            );
        }
        if to_kind != BufferKind::Element {
            return Ok(());
        }
        let outside = || "InvalidValueError: copyBufferSubData range is outside an ELEMENT_ARRAY_BUFFER".to_string();
        let (from_end, to_end) = (
            read_offset.checked_add(len).ok_or_else(outside)?,
            write_offset.checked_add(len).ok_or_else(outside)?,
        );
        if read == write {
            let data = self.data.get_mut(&write).ok_or_else(outside)?;
            if from_end > data.bytes.len() || to_end > data.bytes.len() {
                return Err(outside());
            }
            if read_offset < to_end && write_offset < from_end {
                return Err("InvalidValueError: copyBufferSubData ranges overlap".into());
            }
            data.bytes.copy_within(read_offset..from_end, write_offset);
        } else {
            let copied = self
                .data
                .get(&read)
                .and_then(|data| data.bytes.get(read_offset..from_end))
                .ok_or_else(outside)?
                .to_vec();
            self.data
                .get_mut(&write)
                .and_then(|data| data.bytes.get_mut(write_offset..to_end))
                .ok_or_else(outside)?
                .copy_from_slice(&copied);
        }
        self.forget_ranges(write);
        Ok(())
    }

    pub(crate) fn delete(&mut self, buffer: K) {
        self.kinds.remove(&buffer);
        self.data.remove(&buffer);
    }

    /// [`largest_index`] over `buffer`'s copy, remembered until the buffer is
    /// next written. A buffer with no copy (never given data, or not an
    /// element array buffer) holds no indices to draw.
    pub(crate) fn max_index(&mut self, buffer: K, index_type: u32, offset: usize, count: usize) -> Result<Option<u32>, String> {
        let Some(data) = self.data.get_mut(&buffer) else {
            return largest_index(&[], index_type, offset, count, self.restart);
        };
        let range = (index_type, offset, count);
        if let Some(&max) = data.ranges.get(&range) {
            return Ok(Some(max));
        }
        let max = largest_index(&data.bytes, index_type, offset, count, self.restart)?;
        if let Some(max) = max {
            if data.ranges.len() >= MAX_CACHED_RANGES {
                data.ranges.clear();
            }
            data.ranges.insert(range, max);
        }
        Ok(max)
    }

    fn forget_ranges(&mut self, buffer: K) {
        if let Some(data) = self.data.get_mut(&buffer) {
            data.ranges.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`largest_index`] of a context with no primitive restart.
    fn max_index(data: &[u8], index_type: u32, offset: usize, count: usize) -> Result<Option<u32>, String> {
        largest_index(data, index_type, offset, count, false)
    }

    const ARRAY_BUFFER: u32 = 0x8892;
    const TRANSFORM_FEEDBACK_BUFFER: u32 = 0x8C8E;
    const PIXEL_PACK_BUFFER: u32 = 0x88EB;

    fn u16s(indices: &[u16]) -> Vec<u8> {
        indices.iter().flat_map(|i| i.to_ne_bytes()).collect()
    }

    fn u32s(indices: &[u32]) -> Vec<u8> {
        indices.iter().flat_map(|i| i.to_ne_bytes()).collect()
    }

    /// Three floats a vertex, tightly packed, from the start of the buffer.
    fn vec3(divisor: u32) -> AttribLayout {
        AttribLayout { size: 3, ty: FLOAT, stride: 0, offset: 0, divisor }
    }

    fn array(index: u32, len: usize, layout: AttribLayout) -> EnabledAttrib {
        EnabledAttrib { index, source: AttribSource::Buffer { len: Some(len), layout } }
    }

    /// An element array buffer `1` holding `bytes`.
    fn indices(bytes: &[u8]) -> IndexBuffers<u32> {
        let mut index = IndexBuffers::new(false);
        index.bind(1, ELEMENT_ARRAY_BUFFER).unwrap();
        index.set_data(1, bytes);
        index
    }

    fn elements(index_type: u32, offset: i32, count: i32) -> DrawCall {
        DrawCall { first: 0, count, instances: None, indexed: Some((index_type, offset)) }
    }

    #[test]
    fn max_index_reads_each_index_type_over_the_range_drawn() {
        assert_eq!(max_index(&[3, 9, 200, 4], UNSIGNED_BYTE, 0, 4), Ok(Some(200)));
        assert_eq!(max_index(&[3, 9, 200, 4], UNSIGNED_BYTE, 3, 1), Ok(Some(4)));
        assert_eq!(max_index(&[3, 9, 200, 4], UNSIGNED_BYTE, 0, 2), Ok(Some(9)));

        let shorts = u16s(&[1, 0x0100, 2, 0xFFFF, 7]);
        assert_eq!(max_index(&shorts, UNSIGNED_SHORT, 0, 3), Ok(Some(0x0100)), "two bytes an index, not one");
        assert_eq!(max_index(&shorts, UNSIGNED_SHORT, 0, 5), Ok(Some(0xFFFF)), "the largest value is an index too");
        assert_eq!(max_index(&shorts, UNSIGNED_SHORT, 8, 1), Ok(Some(7)));

        let ints = u32s(&[5, 70_000, 0xFFFF_FFFF, 2]);
        assert_eq!(max_index(&ints, UNSIGNED_INT, 0, 2), Ok(Some(70_000)));
        assert_eq!(max_index(&ints, UNSIGNED_INT, 0, 4), Ok(Some(0xFFFF_FFFF)));
        assert_eq!(max_index(&ints, UNSIGNED_INT, 12, 1), Ok(Some(2)));

        assert_eq!(max_index(&ints, UNSIGNED_INT, 0, 0), Ok(None), "no indices, no largest");
    }

    #[test]
    fn with_primitive_restart_the_largest_value_of_a_type_names_no_vertex() {
        // A WebGL 2 context restarts a strip at 0xFF / 0xFFFF / 0xFFFFFFFF: those are not vertices.
        assert_eq!(largest_index(&[3, 0xFF, 9], UNSIGNED_BYTE, 0, 3, true), Ok(Some(9)));
        let shorts = u16s(&[1, 0xFFFF, 7, 0xFFFE]);
        assert_eq!(largest_index(&shorts, UNSIGNED_SHORT, 0, 3, true), Ok(Some(7)));
        assert_eq!(largest_index(&shorts, UNSIGNED_SHORT, 0, 4, true), Ok(Some(0xFFFE)), "only the largest value restarts");
        let ints = u32s(&[5, 0xFFFF_FFFF, 0xFFFF, 2]);
        assert_eq!(largest_index(&ints, UNSIGNED_INT, 0, 4, true), Ok(Some(0xFFFF)), "0xFFFF is a vertex in a 32-bit range");
        // A range of nothing but restarts reads no vertex.
        assert_eq!(largest_index(&u16s(&[0xFFFF, 0xFFFF]), UNSIGNED_SHORT, 0, 2, true), Ok(None));
        // Without restart (WebGL 1, or a context that cannot switch it on) each is a vertex like any other.
        assert_eq!(largest_index(&shorts, UNSIGNED_SHORT, 0, 3, false), Ok(Some(0xFFFF)));
        // The same refusals either way.
        assert!(largest_index(&shorts, UNSIGNED_SHORT, 1, 1, true).is_err(), "misaligned");
        assert!(largest_index(&shorts, UNSIGNED_SHORT, 0, 5, true).is_err(), "past the end");
    }

    #[test]
    fn a_restarting_strip_is_drawn_and_an_index_past_the_vertices_is_still_refused() {
        // Two strips of three vertices, split by the restart index, over three vertices' worth of data.
        let strips = u16s(&[0, 1, 2, 0xFFFF, 2, 1, 0]);
        let three_vertices = [array(0, 36, vec3(0))];
        let restarting = |bytes: &[u8]| {
            let mut index = IndexBuffers::new(true);
            index.bind(1, ELEMENT_ARRAY_BUFFER).unwrap();
            index.set_data(1, bytes);
            index
        };
        let mut index = restarting(&strips);
        assert_eq!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 0, 7), three_vertices, None), Ok(()));
        // Where the context does not restart, 0xFFFF is vertex 65535, which those arrays do not hold.
        let mut plain = indices(&strips);
        let error = validate_draw(&mut plain, Some(1), &elements(UNSIGNED_SHORT, 0, 7), three_vertices, None).unwrap_err();
        assert!(error.contains("reads element 65535"), "{error}");
        // Restart excuses only the restart index: a real index past the end is refused as before.
        let mut index = restarting(&u16s(&[0, 1, 0xFFFF, 3]));
        let error = validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 0, 4), three_vertices, None).unwrap_err();
        assert!(error.contains("reads element 3"), "{error}");
        // A draw of nothing but restarts reads no vertex.
        let mut index = restarting(&u16s(&[0xFFFF, 0xFFFF, 0xFFFF]));
        assert_eq!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 0, 3), three_vertices, None), Ok(()));
    }

    #[test]
    fn max_index_refuses_what_is_not_a_range_of_indices() {
        let shorts = u16s(&[1, 2, 3]);
        assert!(max_index(&shorts, UNSIGNED_SHORT, 0, 4).unwrap_err().contains("exceeds ELEMENT_ARRAY_BUFFER"));
        assert!(max_index(&shorts, UNSIGNED_SHORT, 6, 1).unwrap_err().contains("exceeds ELEMENT_ARRAY_BUFFER"));
        assert!(max_index(&shorts, UNSIGNED_SHORT, 1, 1).unwrap_err().contains("aligned"));
        assert!(max_index(&shorts, UNSIGNED_INT, 2, 1).unwrap_err().contains("aligned"));
        assert!(max_index(&shorts, UNSIGNED_INT, 4, 1).unwrap_err().contains("exceeds"), "half an index is not one");
        assert!(max_index(&shorts, FLOAT, 0, 1).unwrap_err().contains("index type"));
        assert!(max_index(&shorts, SHORT, 0, 1).unwrap_err().contains("index type"));
        assert!(max_index(&shorts, UNSIGNED_INT, 4, usize::MAX).unwrap_err().contains("overflow"));
        assert!(max_index(&shorts, UNSIGNED_BYTE, usize::MAX, 2).unwrap_err().contains("overflow"));
    }

    #[test]
    fn a_buffer_holds_the_elements_that_end_inside_it() {
        // Tightly packed vec3 of floats: twelve bytes each.
        assert_eq!(elements_in_buffer(36, &vec3(0)), Some(3));
        assert_eq!(elements_in_buffer(35, &vec3(0)), Some(2), "a part of an element is not one");
        assert_eq!(elements_in_buffer(11, &vec3(0)), Some(0));
        assert_eq!(elements_in_buffer(0, &vec3(0)), Some(0));

        // Interleaved: a vec2 of floats 12 bytes into each 20-byte vertex.
        let interleaved = AttribLayout { size: 2, ty: FLOAT, stride: 20, offset: 12, divisor: 0 };
        assert_eq!(elements_in_buffer(60, &interleaved), Some(3));
        assert_eq!(elements_in_buffer(59, &interleaved), Some(2));
        assert_eq!(elements_in_buffer(20, &interleaved), Some(1), "the last vertex need not be padded out");
        assert_eq!(elements_in_buffer(19, &interleaved), Some(0));
        assert_eq!(elements_in_buffer(12, &interleaved), Some(0), "an offset at the end leaves nothing");
        assert_eq!(elements_in_buffer(4, &interleaved), Some(0), "an offset past the end leaves nothing");

        // A stride shorter than the element: they overlap, and the last still has to fit.
        let overlapping = AttribLayout { size: 4, ty: UNSIGNED_SHORT, stride: 2, offset: 0, divisor: 0 };
        assert_eq!(elements_in_buffer(8, &overlapping), Some(1));
        assert_eq!(elements_in_buffer(12, &overlapping), Some(3));

        let bytes = AttribLayout { size: 4, ty: UNSIGNED_BYTE, stride: 0, offset: 0, divisor: 0 };
        assert_eq!(elements_in_buffer(8, &bytes), Some(2));
        let packed = AttribLayout { size: 4, ty: INT_2_10_10_10_REV, stride: 0, offset: 0, divisor: 0 };
        assert_eq!(elements_in_buffer(9, &packed), Some(2), "four components in four bytes");

        for bad in [
            AttribLayout { size: 5, ty: FLOAT, stride: 0, offset: 0, divisor: 0 },
            AttribLayout { size: 0, ty: FLOAT, stride: 0, offset: 0, divisor: 0 },
            AttribLayout { size: 3, ty: INT_2_10_10_10_REV, stride: 0, offset: 0, divisor: 0 },
            AttribLayout { size: 3, ty: 0x1234, stride: 0, offset: 0, divisor: 0 },
            AttribLayout { size: 3, ty: FLOAT, stride: -4, offset: 0, divisor: 0 },
            AttribLayout { size: 3, ty: FLOAT, stride: 0, offset: -1, divisor: 0 },
        ] {
            assert_eq!(elements_in_buffer(1 << 20, &bad), None, "{bad:?}");
        }
    }

    /// The finding: `drawElements` was checked as if its largest index were
    /// 0, so any index went to the driver against any vertex buffer.
    #[test]
    fn an_indexed_draw_past_the_vertex_buffer_is_refused() {
        // Three vertices; the third index names the 70001st.
        let mut index = indices(&u32s(&[0, 1, 70_000]));
        let three_vertices = [array(0, 36, vec3(0))];
        let error = validate_draw(&mut index, Some(1), &elements(UNSIGNED_INT, 0, 3), three_vertices, None).unwrap_err();
        assert!(error.contains("vertex attribute 0 reads element 70000"), "{error}");

        // The same buffer drawn over the two indices that are in range.
        assert_eq!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_INT, 0, 2), three_vertices, None), Ok(()));

        // One past the end is past the end; the last vertex is not.
        let mut index = indices(&u16s(&[0, 1, 2, 2, 1, 3]));
        assert_eq!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 0, 5), three_vertices, None), Ok(()));
        let error = validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 0, 6), three_vertices, None).unwrap_err();
        assert!(error.contains("reads element 3") && error.contains("holds 3"), "{error}");
        // By offset: only the range drawn is looked at.
        assert_eq!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 2, 4), three_vertices, None), Ok(()));
        assert!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 4, 4), three_vertices, None).is_err());

        // Every array the draw reads has to hold the vertex, not only the first.
        let mut index = indices(&[0, 1, 2]);
        let short_second = [array(0, 36, vec3(0)), array(3, 24, vec3(0))];
        let error = validate_draw(&mut index, Some(1), &elements(UNSIGNED_BYTE, 0, 3), short_second, None).unwrap_err();
        assert!(error.contains("vertex attribute 3 reads element 2"), "{error}");

        // Instanced: the per-vertex arrays by index, the per-instance ones by instance.
        let instanced = DrawCall { first: 0, count: 3, instances: Some(4), indexed: Some((UNSIGNED_BYTE, 0)) };
        let per_instance = |len| [array(0, 36, vec3(0)), array(1, len, vec3(1))];
        assert_eq!(validate_draw(&mut index, Some(1), &instanced, per_instance(48), None), Ok(()));
        assert!(validate_draw(&mut index, Some(1), &instanced, per_instance(36), None).is_err());
        let mut index = indices(&[0, 1, 9]);
        let error = validate_draw(&mut index, Some(1), &instanced, per_instance(48), None).unwrap_err();
        assert!(error.contains("vertex attribute 0 reads element 9"), "{error}");
    }

    #[test]
    fn an_indexed_draw_needs_indices_it_can_be_checked_by() {
        let vertices = [array(0, 1 << 20, vec3(0))];
        let call = elements(UNSIGNED_SHORT, 0, 3);

        let mut index: IndexBuffers<u32> = IndexBuffers::new(false);
        let error = validate_draw(&mut index, None, &call, vertices, None).unwrap_err();
        assert!(error.contains("requires a bound ELEMENT_ARRAY_BUFFER"), "{error}");

        // Bound, and never given data.
        index.bind(1, ELEMENT_ARRAY_BUFFER).unwrap();
        let error = validate_draw(&mut index, Some(1), &call, vertices, None).unwrap_err();
        assert!(error.contains("exceeds ELEMENT_ARRAY_BUFFER size"), "{error}");

        // A buffer that is not an element array buffer has no indices, whatever it holds.
        index.bind(2, ARRAY_BUFFER).unwrap();
        index.set_data(2, &u16s(&[0, 1, 2]));
        assert!(validate_draw(&mut index, Some(2), &call, vertices, None).is_err());

        index.set_data(1, &u16s(&[0, 1, 2]));
        assert_eq!(validate_draw(&mut index, Some(1), &call, vertices, None), Ok(()));
        assert!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 2, 3), vertices, None).is_err());
        assert!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 1, 2), vertices, None).is_err());
        assert!(validate_draw(&mut index, Some(1), &elements(FLOAT, 0, 1), vertices, None).is_err());
        assert!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, -2, 1), vertices, None).is_err());
        assert!(validate_draw(&mut index, Some(1), &elements(UNSIGNED_SHORT, 0, -1), vertices, None).is_err());
        let negative = DrawCall { first: 0, count: 3, instances: Some(-1), indexed: Some((UNSIGNED_SHORT, 0)) };
        assert!(validate_draw(&mut index, Some(1), &negative, vertices, None).is_err());
        // An array whose layout is not one cannot be measured, so it is not drawn from.
        let bad_layout = [array(0, 1 << 20, AttribLayout { size: 3, ty: 0x1234, stride: 0, offset: 0, divisor: 0 })];
        let error = validate_draw(&mut index, Some(1), &call, bad_layout, None).unwrap_err();
        assert!(error.contains("invalid vertex attribute 0 format"), "{error}");

        // Nothing drawn, nothing read: no error even with nothing to read from.
        assert_eq!(validate_draw(&mut index, None, &elements(UNSIGNED_SHORT, 0, 0), vertices, None), Ok(()));
        let none = DrawCall { first: 0, count: 3, instances: Some(0), indexed: Some((UNSIGNED_SHORT, 0)) };
        assert_eq!(validate_draw(&mut index, None, &none, vertices, None), Ok(()));
    }

    #[test]
    fn an_array_draw_is_checked_by_its_last_vertex() {
        let mut index: IndexBuffers<u32> = IndexBuffers::new(false);
        let arrays = |first, count| DrawCall { first, count, instances: None, indexed: None };
        let three_vertices = [array(0, 36, vec3(0))];
        assert_eq!(validate_draw(&mut index, None, &arrays(0, 3), three_vertices, None), Ok(()));
        assert_eq!(validate_draw(&mut index, None, &arrays(2, 1), three_vertices, None), Ok(()));
        assert!(validate_draw(&mut index, None, &arrays(0, 4), three_vertices, None).is_err());
        assert!(validate_draw(&mut index, None, &arrays(3, 1), three_vertices, None).is_err());
        assert!(validate_draw(&mut index, None, &arrays(-1, 1), three_vertices, None).is_err());
        assert_eq!(validate_draw(&mut index, None, &arrays(i32::MAX, i32::MAX), [], None), Ok(()), "no overflow");
        assert!(validate_draw(&mut index, None, &arrays(i32::MAX, i32::MAX), three_vertices, None).is_err());

        // A per-instance array is read once when the draw is not instanced,
        // and once for every `divisor` instances when it is.
        let with_instances = |len, divisor| [array(0, 36, vec3(0)), array(1, len, vec3(divisor))];
        assert_eq!(validate_draw(&mut index, None, &arrays(0, 3), with_instances(12, 1), None), Ok(()));
        assert!(validate_draw(&mut index, None, &arrays(0, 3), with_instances(11, 1), None).is_err());
        let instanced = |instances| DrawCall { first: 0, count: 3, instances: Some(instances), indexed: None };
        assert_eq!(validate_draw(&mut index, None, &instanced(5), with_instances(60, 1), None), Ok(()));
        assert!(validate_draw(&mut index, None, &instanced(6), with_instances(60, 1), None).is_err());
        assert_eq!(validate_draw(&mut index, None, &instanced(6), with_instances(36, 2), None), Ok(()));
        assert!(validate_draw(&mut index, None, &instanced(7), with_instances(36, 2), None).is_err());
    }

    #[test]
    fn the_largest_index_is_counted_again_after_every_write() {
        let mut index = indices(&u16s(&[0, 1, 2, 0]));
        assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, 4), Ok(Some(2)));

        // bufferSubData over one index.
        index.write(1, 6, &u16s(&[900])).unwrap();
        assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, 4), Ok(Some(900)));
        assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, 3), Ok(Some(2)), "by range");
        // And over the high byte of one, at an odd offset.
        index.write(1, 1, &[0x7F]).unwrap();
        let expected = u16::from_ne_bytes([u16s(&[0])[0], 0x7F]).max(900);
        assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, 4), Ok(Some(u32::from(expected))));

        // A write that is not inside the buffer changes nothing and is an error.
        assert!(index.write(1, 7, &[1, 2]).is_err());
        assert!(index.write(1, usize::MAX, &[1]).is_err());
        assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, 4), Ok(Some(u32::from(expected))));

        // bufferData replaces it all, size included.
        index.set_data(1, &u16s(&[5, 6]));
        assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, 2), Ok(Some(6)));
        assert!(index.max_index(1, UNSIGNED_SHORT, 0, 4).is_err());

        // The same bytes read as another type are another answer.
        index.set_data(1, &u32s(&[0x0001_0000, 3]));
        assert_eq!(index.max_index(1, UNSIGNED_INT, 0, 2), Ok(Some(0x0001_0000)));
        assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, 4), Ok(Some(3)));
        assert_eq!(index.max_index(1, UNSIGNED_BYTE, 0, 8), Ok(Some(3)));

        // More ranges than are remembered are still answered right.
        let many: Vec<u16> = (0..200).collect();
        index.set_data(1, &u16s(&many));
        for count in 1..=200usize {
            assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, count), Ok(Some(count as u32 - 1)));
        }
        index.write(1, 0, &u16s(&[5000])).unwrap();
        for count in 1..=200usize {
            assert_eq!(index.max_index(1, UNSIGNED_SHORT, 0, count), Ok(Some(5000)));
        }

        index.delete(1);
        assert!(index.max_index(1, UNSIGNED_SHORT, 0, 1).is_err());
        assert!(!index.is_element(1));
    }

    #[test]
    fn a_draw_sees_an_index_written_after_the_last_one() {
        let mut index = indices(&u16s(&[0, 1, 2]));
        let three_vertices = [array(0, 36, vec3(0))];
        let call = elements(UNSIGNED_SHORT, 0, 3);
        assert_eq!(validate_draw(&mut index, Some(1), &call, three_vertices, None), Ok(()));
        index.write(1, 2, &u16s(&[3])).unwrap();
        assert!(validate_draw(&mut index, Some(1), &call, three_vertices, None).is_err());

        // From another index buffer, by copyBufferSubData.
        index.write(1, 2, &u16s(&[1])).unwrap();
        assert_eq!(validate_draw(&mut index, Some(1), &call, three_vertices, None), Ok(()));
        index.bind(2, ELEMENT_ARRAY_BUFFER).unwrap();
        index.set_data(2, &u16s(&[40_000]));
        index.copy(2, 1, 0, 4, 2).unwrap();
        let error = validate_draw(&mut index, Some(1), &call, three_vertices, None).unwrap_err();
        assert!(error.contains("reads element 40000"), "{error}");
    }

    #[test]
    fn a_buffer_keeps_the_kind_it_was_first_bound_as() {
        let mut index: IndexBuffers<u32> = IndexBuffers::new(false);
        index.bind(1, ELEMENT_ARRAY_BUFFER).unwrap();
        index.bind(1, ELEMENT_ARRAY_BUFFER).unwrap();
        assert!(index.is_element(1));
        // Nothing that writes without saying so can reach an index buffer.
        for target in [ARRAY_BUFFER, TRANSFORM_FEEDBACK_BUFFER, PIXEL_PACK_BUFFER] {
            let error = index.bind(1, target).unwrap_err();
            assert!(error.contains("InvalidOperationError"), "{error}");
        }
        assert!(index.is_element(1));
        index.bind(1, COPY_WRITE_BUFFER).unwrap();
        index.bind(1, COPY_READ_BUFFER).unwrap();
        assert!(index.is_element(1), "a copy target takes either kind and changes neither");

        index.bind(2, ARRAY_BUFFER).unwrap();
        index.bind(2, TRANSFORM_FEEDBACK_BUFFER).unwrap();
        index.bind(2, COPY_WRITE_BUFFER).unwrap();
        assert!(index.bind(2, ELEMENT_ARRAY_BUFFER).is_err());
        assert!(!index.is_element(2));

        // First bound to a copy target: an ordinary buffer from then on.
        index.bind(3, COPY_WRITE_BUFFER).unwrap();
        assert!(index.bind(3, ELEMENT_ARRAY_BUFFER).is_err());
        index.bind(3, ARRAY_BUFFER).unwrap();

        // A deleted buffer's number may come back as either.
        index.delete(2);
        index.bind(2, ELEMENT_ARRAY_BUFFER).unwrap();
        assert!(index.is_element(2));
    }

    #[test]
    fn index_data_is_copied_only_from_index_data() {
        let mut index: IndexBuffers<u32> = IndexBuffers::new(false);
        index.bind(1, ELEMENT_ARRAY_BUFFER).unwrap();
        index.set_data(1, &[0, 1, 2, 3]);
        index.bind(2, ARRAY_BUFFER).unwrap();
        index.set_data(2, &[250; 4]);
        index.bind(3, ELEMENT_ARRAY_BUFFER).unwrap();
        index.set_data(3, &[9, 8, 7, 6, 5, 4]);

        // Vertex data (which a transform feedback may have written) is not index data.
        assert!(index.copy(2, 1, 0, 0, 4).unwrap_err().contains("another kind"));
        assert!(index.copy(1, 2, 0, 0, 4).unwrap_err().contains("another kind"));
        assert!(index.copy(1, 99, 0, 0, 1).is_err(), "a buffer that was never bound");
        assert_eq!(index.max_index(1, UNSIGNED_BYTE, 0, 4), Ok(Some(3)));
        // Between ordinary buffers nothing is kept, and nothing is refused here.
        index.bind(4, ARRAY_BUFFER).unwrap();
        assert_eq!(index.copy(2, 4, 0, 0, 4), Ok(()));

        index.copy(3, 1, 1, 2, 2).unwrap();
        assert_eq!(index.max_index(1, UNSIGNED_BYTE, 0, 4), Ok(Some(8)));
        assert_eq!(index.max_index(1, UNSIGNED_BYTE, 3, 1), Ok(Some(7)));
        assert!(index.copy(3, 1, 4, 0, 3).is_err(), "past the end of the source");
        assert!(index.copy(3, 1, 0, 2, 3).is_err(), "past the end of the destination");
        assert!(index.copy(3, 1, usize::MAX, 0, 2).is_err());

        // Within one buffer, where the ranges do not overlap.
        index.copy(3, 3, 0, 4, 2).unwrap();
        assert_eq!(index.max_index(3, UNSIGNED_BYTE, 4, 2), Ok(Some(9)));
        assert!(index.copy(3, 3, 0, 1, 2).unwrap_err().contains("overlap"));
        assert!(index.copy(3, 3, 0, 5, 2).is_err());

        // An index buffer that was never given data has nothing to copy from or to.
        index.bind(5, ELEMENT_ARRAY_BUFFER).unwrap();
        assert!(index.copy(5, 1, 0, 0, 1).is_err());
        assert!(index.copy(1, 5, 0, 0, 1).is_err());
    }

    #[test]
    fn buffer_writes_the_driver_would_refuse_are_refused_first() {
        assert_eq!(sub_data_start(16, 0, 16), Ok(0));
        assert_eq!(sub_data_start(16, 12, 4), Ok(12));
        assert_eq!(sub_data_start(16, 16, 0), Ok(16));
        assert!(sub_data_start(16, 13, 4).is_err());
        assert!(sub_data_start(16, 17, 0).is_err());
        assert!(sub_data_start(16, -1, 1).is_err());
        assert!(sub_data_start(0, 0, 1).is_err());
        assert!(sub_data_start(usize::MAX, i32::MAX, usize::MAX).is_err());

        assert_eq!(copy_ranges(8, 8, 0, 4, 4, false), Ok((0, 4, 4)));
        assert!(copy_ranges(8, 8, 5, 0, 4, false).is_err());
        assert!(copy_ranges(8, 8, 0, 5, 4, false).is_err());
        assert!(copy_ranges(8, 8, -1, 0, 1, false).is_err());
        assert!(copy_ranges(8, 8, 0, -1, 1, false).is_err());
        assert!(copy_ranges(8, 8, 0, 0, -1, false).is_err());
        assert!(copy_ranges(usize::MAX, usize::MAX, i32::MAX, i32::MAX, i32::MAX, false).is_ok(), "no overflow");
        assert_eq!(copy_ranges(8, 8, 0, 4, 4, true), Ok((0, 4, 4)));
        assert!(copy_ranges(8, 8, 0, 3, 4, true).is_err());
        assert!(copy_ranges(8, 8, 3, 0, 4, true).is_err());
        assert!(copy_ranges(8, 8, 2, 2, 1, true).is_err());

        for usage in [STREAM_DRAW, STATIC_DRAW, DYNAMIC_DRAW] {
            assert!(buffer_usage_ok(usage, false) && buffer_usage_ok(usage, true));
        }
        for usage in [STREAM_READ, STREAM_COPY, STATIC_READ, STATIC_COPY, DYNAMIC_READ, DYNAMIC_COPY] {
            assert!(buffer_usage_ok(usage, true) && !buffer_usage_ok(usage, false), "{usage:#x}");
        }
        for usage in [0, 0x88E3, 0x88E7, 0x88EB, ELEMENT_ARRAY_BUFFER] {
            assert!(!buffer_usage_ok(usage, true), "{usage:#x}");
        }

        assert_eq!(tracked_bytes(100, false), 100);
        assert_eq!(tracked_bytes(100, true), 200);
        assert_eq!(tracked_bytes(usize::MAX, true), usize::MAX);
    }

    #[test]
    fn a_pointer_the_driver_would_refuse_is_not_remembered() {
        // What WebGL 1 has, on either context.
        for ty in [BYTE, UNSIGNED_BYTE, SHORT, UNSIGNED_SHORT, FLOAT] {
            assert!(attrib_pointer_ok(3, ty, 0, 0, false, false) && attrib_pointer_ok(3, ty, 12, 4, false, true), "{ty:#x}");
        }
        // What only OpenGL ES 3 has.
        for ty in [INT, UNSIGNED_INT, HALF_FLOAT] {
            assert!(attrib_pointer_ok(3, ty, 0, 0, false, true) && !attrib_pointer_ok(3, ty, 0, 0, false, false), "{ty:#x}");
        }
        assert!(attrib_pointer_ok(4, INT_2_10_10_10_REV, 0, 0, false, true));
        assert!(!attrib_pointer_ok(4, INT_2_10_10_10_REV, 0, 0, false, false));
        assert!(!attrib_pointer_ok(3, UNSIGNED_INT_2_10_10_10_REV, 0, 0, false, true));

        // vertexAttribIPointer: integers only, and only on ES 3.
        for ty in [BYTE, UNSIGNED_BYTE, SHORT, UNSIGNED_SHORT, INT, UNSIGNED_INT] {
            assert!(attrib_pointer_ok(2, ty, 0, 0, true, true) && !attrib_pointer_ok(2, ty, 0, 0, true, false), "{ty:#x}");
        }
        for ty in [FLOAT, HALF_FLOAT, INT_2_10_10_10_REV, UNSIGNED_INT_2_10_10_10_REV] {
            assert!(!attrib_pointer_ok(4, ty, 0, 0, true, true), "{ty:#x}");
        }

        assert!(attrib_pointer_ok(3, FLOAT, 255, 0, false, true));
        assert!(!attrib_pointer_ok(3, FLOAT, 256, 0, false, true));
        assert!(!attrib_pointer_ok(3, FLOAT, -1, 0, false, true));
        assert!(!attrib_pointer_ok(3, FLOAT, 0, -1, false, true));
        assert!(!attrib_pointer_ok(5, FLOAT, 0, 0, false, true));
        assert!(!attrib_pointer_ok(0, FLOAT, 0, 0, false, true));
        assert!(!attrib_pointer_ok(3, 0x1234, 0, 0, false, true));
    }

    /// SR-R9: an enabled array the program does not read failed the draw.
    #[test]
    fn an_enabled_array_the_program_does_not_read_is_not_range_checked() {
        let mut index: IndexBuffers<u32> = IndexBuffers::new(false);
        // A 3000-vertex mesh on attribute 0, with attributes 1 and 2 left
        // enabled on a four-vertex quad's buffers.
        let mesh = DrawCall { first: 0, count: 3000, instances: None, indexed: None };
        let stale = [array(0, 36_000, vec3(0)), array(1, 48, vec3(0)), array(2, 48, vec3(0))];
        let reads_0: HashSet<u32> = [0].into();
        assert_eq!(validate_draw(&mut index, None, &mesh, stale, Some(&reads_0)), Ok(()));

        // The ones it does read are checked as before,
        let reads_0_and_2: HashSet<u32> = [0, 2].into();
        let error = validate_draw(&mut index, None, &mesh, stale, Some(&reads_0_and_2)).unwrap_err();
        assert!(error.contains("vertex attribute 2 reads element 2999"), "{error}");
        let reads_1: HashSet<u32> = [1].into();
        assert!(validate_draw(&mut index, None, &mesh, stale, Some(&reads_1)).is_err());
        // and so is every one when what the program reads is not known.
        let error = validate_draw(&mut index, None, &mesh, stale, None).unwrap_err();
        assert!(error.contains("reads element 2999"), "{error}");

        // The same for an indexed draw and for a per-instance array.
        let mut index = indices(&u16s(&[0, 1, 2999]));
        let call = DrawCall { first: 0, count: 3, instances: Some(100), indexed: Some((UNSIGNED_SHORT, 0)) };
        let stale = [array(0, 36_000, vec3(0)), array(1, 48, vec3(0)), array(2, 48, vec3(1))];
        assert_eq!(validate_draw(&mut index, Some(1), &call, stale, Some(&reads_0)), Ok(()));
        assert!(validate_draw(&mut index, Some(1), &call, stale, Some(&reads_0_and_2)).is_err());
        assert!(validate_draw(&mut index, Some(1), &call, stale, None).is_err());

        // A buffer with no storage is only short by all of it.
        let unallocated = [array(0, 36_000, vec3(0)), EnabledAttrib { index: 1, source: AttribSource::Buffer { len: None, layout: vec3(0) } }];
        assert_eq!(validate_draw(&mut index, None, &mesh, unallocated, Some(&reads_0)), Ok(()));
        let error = validate_draw(&mut index, None, &mesh, unallocated, None).unwrap_err();
        assert!(error.contains("no allocated ARRAY_BUFFER storage"), "{error}");

        // An empty program reads nothing: nothing is fetched for it.
        let reads_nothing = HashSet::new();
        assert_eq!(validate_draw(&mut index, None, &mesh, stale, Some(&reads_nothing)), Ok(()));

        assert!(range_checked(4, None));
        assert!(range_checked(4, Some(&[4].into())));
        assert!(!range_checked(4, Some(&[0, 5].into())));
    }

    #[test]
    fn an_enabled_array_with_no_buffer_is_an_error_whatever_the_program_reads() {
        let mut index: IndexBuffers<u32> = IndexBuffers::new(false);
        let call = DrawCall { first: 0, count: 3, instances: None, indexed: None };
        let reads_0: HashSet<u32> = [0].into();
        let fine = array(0, 36, vec3(0));

        let no_pointer = [fine, EnabledAttrib { index: 5, source: AttribSource::NoPointer }];
        for reads in [None, Some(&reads_0)] {
            let error = validate_draw(&mut index, None, &call, no_pointer, reads).unwrap_err();
            assert!(error.contains("enabled vertex attribute 5 has no ARRAY_BUFFER pointer"), "{error}");
        }
        let deleted = [fine, EnabledAttrib { index: 5, source: AttribSource::NoBuffer }];
        for reads in [None, Some(&reads_0)] {
            let error = validate_draw(&mut index, None, &call, deleted, reads).unwrap_err();
            assert!(error.contains("deleted or unbound ARRAY_BUFFER"), "{error}");
        }
    }

    #[test]
    fn a_matrix_attribute_takes_a_location_for_each_column() {
        const FLOAT_VEC3: u32 = 0x8B51;
        assert_eq!(attrib_locations(2, FLOAT, 1), 2..3);
        assert_eq!(attrib_locations(2, FLOAT_VEC3, 1), 2..3);
        assert_eq!(attrib_locations(2, INT, 1), 2..3);
        assert_eq!(attrib_locations(1, FLOAT_MAT2, 1), 1..3);
        assert_eq!(attrib_locations(1, FLOAT_MAT3, 1), 1..4);
        assert_eq!(attrib_locations(1, FLOAT_MAT4, 1), 1..5);
        // Columns by rows: the first number is the columns.
        assert_eq!(attrib_locations(0, FLOAT_MAT2X3, 1), 0..2);
        assert_eq!(attrib_locations(0, FLOAT_MAT2X4, 1), 0..2);
        assert_eq!(attrib_locations(0, FLOAT_MAT3X2, 1), 0..3);
        assert_eq!(attrib_locations(0, FLOAT_MAT3X4, 1), 0..3);
        assert_eq!(attrib_locations(0, FLOAT_MAT4X2, 1), 0..4);
        assert_eq!(attrib_locations(0, FLOAT_MAT4X3, 1), 0..4);
        // An array of them, should a driver report one, and a size that is not one.
        assert_eq!(attrib_locations(4, FLOAT_MAT4, 2), 4..12);
        assert_eq!(attrib_locations(4, FLOAT, 3), 4..7);
        assert_eq!(attrib_locations(4, FLOAT, 0), 4..5);
        assert_eq!(attrib_locations(4, FLOAT, -3), 4..5);
        assert_eq!(attrib_locations(u32::MAX - 1, FLOAT_MAT4, 1), u32::MAX - 1..u32::MAX);
    }

    #[test]
    fn what_a_draw_reads_follows_the_executable_in_use() {
        let set = |locations: &[u32]| -> HashSet<u32> { locations.iter().copied().collect() };
        let mut reads: ProgramReads<u32> = ProgramReads::new();
        assert_eq!(reads.in_use(), None, "no program: nothing is known");

        reads.linked(1, Some(set(&[0, 1])));
        reads.linked(2, Some(set(&[0])));
        assert_eq!(reads.in_use(), None, "linking is not using");
        reads.used(Some(1));
        assert_eq!(reads.in_use(), Some(&set(&[0, 1])));
        reads.used(Some(2));
        assert_eq!(reads.in_use(), Some(&set(&[0])));

        // Linked again while in use: the new executable is the one in use.
        reads.linked(2, Some(set(&[0, 3])));
        assert_eq!(reads.in_use(), Some(&set(&[0, 3])));
        // Another program's link changes nothing for the one in use.
        reads.linked(1, Some(set(&[7])));
        assert_eq!(reads.in_use(), Some(&set(&[0, 3])));

        // A failed link leaves the old executable running,
        reads.link_failed(2);
        assert_eq!(reads.in_use(), Some(&set(&[0, 3])));
        // a useProgram of it is then refused (the driver still says 2),
        reads.used(Some(2));
        assert_eq!(reads.in_use(), Some(&set(&[0, 3])));
        // and once another is in use it cannot come back until it links.
        reads.used(Some(1));
        assert_eq!(reads.in_use(), Some(&set(&[7])));
        reads.used(Some(2));
        assert_eq!(reads.in_use(), None, "the driver would have refused this; nothing is assumed if it did not");
        reads.linked(2, Some(set(&[4])));
        assert_eq!(reads.in_use(), Some(&set(&[4])));

        // A useProgram the driver refused: the current program is who it was.
        reads.used(Some(2));
        assert_eq!(reads.in_use(), Some(&set(&[4])));

        // Linked, but with an attribute that could not be placed: not known.
        reads.linked(2, None);
        assert_eq!(reads.in_use(), None);
        reads.linked(2, Some(set(&[4])));

        // A deleted program stays in use until another is,
        reads.deleted(2);
        assert_eq!(reads.in_use(), Some(&set(&[4])));
        reads.used(None);
        assert_eq!(reads.in_use(), None);
        // and its number, given to a new program, means the new program.
        reads.used(Some(2));
        assert_eq!(reads.in_use(), None, "not linked yet");
        reads.used(None);
        reads.linked(2, Some(set(&[9])));
        reads.used(Some(2));
        assert_eq!(reads.in_use(), Some(&set(&[9])));

        // A program this was never told of.
        reads.used(Some(77));
        assert_eq!(reads.in_use(), None);
    }
}
