//! Room on a disk, for the pre-upgrade snapshot (`backup_database` in scoped_xdb.rs).
//!
//! A snapshot is a whole copy of an app's database, written beside it, and the page asks for
//! one: before an upgrade, but nothing stops it asking again. Each is kept, since a rollback
//! or a recovery needs the one its record names, so a page asking in a loop filled the disk
//! the databases share, and every app's next write failed with it. A snapshot is now written
//! only while it leaves `SNAPSHOT_FLOOR_BYTES` free.

use std::path::Path;

/// What a snapshot must leave free on its disk.
pub const SNAPSHOT_FLOOR_BYTES: u64 = 512 * 1024 * 1024;

/// Why a snapshot of `size` bytes cannot be written where `free` bytes are free, or nothing.
pub fn snapshot_refusal(free: u64, size: u64) -> Option<String> {
    if free.saturating_sub(size) >= SNAPSHOT_FLOOR_BYTES {
        return None;
    }
    let mb = |bytes: u64| bytes.div_ceil(1024 * 1024);
    Some(format!(
        "the disk has {} MB free, and the backup takes about {} MB and must leave {} MB",
        free / (1024 * 1024),
        mb(size),
        mb(SNAPSHOT_FLOOR_BYTES)
    ))
}

/// The size of the database at `db`, with its write-ahead log: about what a snapshot takes.
pub fn database_size(db: &Path) -> std::io::Result<u64> {
    let mut size = std::fs::metadata(db)?.len();
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    if let Ok(log) = std::fs::metadata(&wal) {
        size += log.len();
    }
    Ok(size)
}

/// The bytes free to this process on the disk that holds `directory`.
#[cfg(windows)]
pub fn free_bytes(directory: &Path) -> std::io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = directory.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut available = 0u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the one out pointer is to a
    // local, and the two the call may skip are null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(available)
}

/// The bytes free to this process on the disk that holds `directory`.
#[cfg(unix)]
pub fn free_bytes(directory: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(directory.as_os_str().as_bytes())?;
    // SAFETY: an all-zero statvfs is a valid value of it, `name` is NUL-terminated, and both
    // outlive the call.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(name.as_ptr(), &mut stat) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // The field types differ by platform (u32 on some, u64 on others).
    #[allow(clippy::unnecessary_cast)]
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB: u64 = 1024 * 1024;

    #[test]
    fn a_snapshot_is_refused_when_it_would_leave_less_than_the_floor() {
        assert_eq!(snapshot_refusal(2048 * MB, 100 * MB), None);
        assert_eq!(snapshot_refusal(612 * MB, 100 * MB), None);
        assert_eq!(
            snapshot_refusal(611 * MB, 100 * MB).as_deref(),
            Some("the disk has 611 MB free, and the backup takes about 100 MB and must leave 512 MB")
        );
        // A database larger than the free space, and a full disk.
        assert!(snapshot_refusal(100 * MB, 4096 * MB).is_some());
        assert!(snapshot_refusal(0, 0).is_some());
    }

    #[test]
    fn the_free_space_of_a_real_folder_is_read() {
        let free = free_bytes(&std::env::temp_dir()).expect("the temp folder's disk");
        assert!(free > 0);
        assert!(free_bytes(Path::new("this folder does not exist/nor this")).is_err());
    }

    #[test]
    fn a_database_is_counted_with_its_write_ahead_log() {
        let dir = std::env::temp_dir().join(format!("softn-loader-disk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("app.sqlite");
        std::fs::write(&db, vec![0u8; 4096]).unwrap();
        assert_eq!(database_size(&db).unwrap(), 4096);
        std::fs::write(dir.join("app.sqlite-wal"), vec![0u8; 1000]).unwrap();
        assert_eq!(database_size(&db).unwrap(), 5096);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
