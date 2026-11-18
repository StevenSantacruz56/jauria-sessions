#[path = "../src/app_settings.rs"]
mod app_settings;

use anyhow::Result;
use app_settings::AppSettings;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::{Arc, Barrier, atomic::{AtomicBool, AtomicU64, Ordering}},
    thread,
};

// No profile, HOME, provider configuration, or model discovery in these fixtures.
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Profile(PathBuf);
impl Profile {
    fn new() -> Result<Self> {
        let base = std::env::temp_dir().canonicalize()?;
        loop {
            let path = base.join(format!("aw-settings-test-{}-{}", std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)));
            match fs::DirBuilder::new().create(&path) {
                Ok(()) => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
                    return Ok(Self(path));
                },
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
    fn path(&self) -> &Path { &self.0 }
    fn file(&self) -> PathBuf { self.0.join("app-settings.json") }
    fn seed(&self, bytes: &[u8]) -> Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(self.file())?;
        file.write_all(bytes)?;
        fs::set_permissions(self.file(), fs::Permissions::from_mode(0o600))?;
        Ok(())
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn first_launch_default_without_any_writes() -> Result<()> {
    let p = Profile::new()?;
    let before = fs::metadata(p.path())?;
    let settings = AppSettings::open(p.path())?;
    assert_eq!(settings.limit(), 2);
    assert_eq!(settings.snapshot(), json!({"schemaVersion":2,"maxConcurrentSessions":2,
        "maxSupportedSessions":8,"pulsoAutoAccess":true,"warning":null}));
    assert_eq!(fs::read_dir(p.path())?.count(), 0);
    assert_eq!(fs::metadata(p.path())?.modified()?, before.modified()?);
    Ok(())
}

#[test]
fn persists_only_schema_and_limit_and_reopens_at_both_boundaries() -> Result<()> {
    let p = Profile::new()?;
    let settings = AppSettings::open(p.path())?;
    for limit in [1, 8, 2] {
        assert_eq!(settings.set_limit(limit)?["maxConcurrentSessions"], limit);
        assert_eq!(AppSettings::open(p.path())?.limit(), limit);
        let value: Value = serde_json::from_slice(&fs::read(p.file())?)?;
        assert_eq!(value, json!({"schemaVersion":2,"maxConcurrentSessions":limit,"pulsoAutoAccess":true}));
        let metadata = fs::metadata(p.file())?;
        assert_eq!(metadata.mode() & 0o7777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        assert_eq!(fs::read_dir(p.path())?.count(), 1);
    }
    let before = fs::read(p.file())?;
    for limit in [0, 9, usize::MAX] {
        assert!(settings.set_limit(limit).is_err());
        assert_eq!(settings.limit(), 2);
        assert_eq!(fs::read(p.file())?, before);
    }
    Ok(())
}

#[test]
fn bad_json_uses_defaults_with_generic_warning_and_preserves_bytes() -> Result<()> {
    let invalid = [
        "broken secret content", "null", "[]", "{}",
        r#"{"schemaVersion":2,"maxConcurrentSessions":3}"#,
        r#"{"schemaVersion":1.0,"maxConcurrentSessions":3}"#,
        r#"{"schemaVersion":1,"maxConcurrentSessions":0}"#,
        r#"{"schemaVersion":1,"maxConcurrentSessions":9}"#,
        r#"{"schemaVersion":1,"maxConcurrentSessions":2.5}"#,
        r#"{"schemaVersion":1,"maxConcurrentSessions":2.0}"#,
        r#"{"schemaVersion":1,"maxConcurrentSessions":-1}"#,
        r#"{"schemaVersion":1,"maxConcurrentSessions":"2"}"#,
        r#"{"schemaVersion":1,"maxConcurrentSessions":true}"#,
        r#"{"schemaVersion":1,"maxConcurrentSessions":2,"unknown":"secret"}"#,
    ];
    let mut warning = None;
    for bytes in invalid.iter().map(|s| s.as_bytes().to_vec()).chain([
        vec![b' '; 16 * 1024 + 1], vec![0xff],
    ]) {
        let p = Profile::new()?;
        p.seed(&bytes)?;
        let settings = AppSettings::open(p.path())?;
        assert_eq!(settings.limit(), 2);
        let current = settings.snapshot()["warning"].clone();
        assert!(current.is_string());
        assert!(!current.as_str().unwrap().contains("secret"));
        if let Some(ref previous) = warning { assert_eq!(&current, previous); }
        warning = Some(current);
        assert_eq!(fs::read(p.file())?, bytes);
        assert!(settings.set_limit(0).is_err());
        assert_eq!(fs::read(p.file())?, bytes);
        settings.set_limit(3)?;
        assert!(settings.snapshot()["warning"].is_null());
        assert_eq!(AppSettings::open(p.path())?.limit(), 3);
    }
    Ok(())
}

#[test]
fn accepts_json_at_exact_byte_bound() -> Result<()> {
    let p = Profile::new()?;
    let mut bytes = br#"{"schemaVersion":1,"maxConcurrentSessions":8}"#.to_vec();
    bytes.resize(16 * 1024, b' ');
    p.seed(&bytes)?;
    assert_eq!(AppSettings::open(p.path())?.limit(), 8);
    Ok(())
}

#[test]
fn unsafe_targets_are_preserved_and_can_be_repaired_explicitly() -> Result<()> {
    for kind in ["symlink", "dangling", "hardlink", "mode", "directory", "fifo"] {
        let p = Profile::new()?;
        let outside = Profile::new()?;
        outside.seed(br#"{"schemaVersion":1,"maxConcurrentSessions":7}"#)?;
        let original = fs::read(outside.file())?;
        match kind {
            "symlink" => symlink(outside.file(), p.file())?,
            "dangling" => symlink(outside.path().join("missing"), p.file())?,
            "hardlink" => fs::hard_link(outside.file(), p.file())?,
            "mode" => {
                p.seed(&original)?;
                fs::set_permissions(p.file(), fs::Permissions::from_mode(0o644))?;
            },
            "directory" => fs::create_dir(p.file())?,
            "fifo" => {
                use std::{ffi::CString, os::unix::ffi::OsStrExt};
                let name = CString::new(p.file().as_os_str().as_bytes())?;
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            },
            _ => unreachable!(),
        }
        let settings = AppSettings::open(p.path())?;
        assert_eq!(settings.limit(), 2, "{kind}");
        assert!(settings.snapshot()["warning"].is_string());
        assert!(settings.set_limit(4).is_err(), "{kind}");
        assert_eq!(settings.limit(), 2);
        assert_eq!(fs::read(outside.file())?, original);
        assert!(!outside.path().join("missing").exists());
        if kind == "directory" { fs::remove_dir(p.file())?; }
        else { fs::remove_file(p.file())?; }
        settings.set_limit(4)?;
        assert_eq!(AppSettings::open(p.path())?.limit(), 4);
        assert_eq!(fs::read_dir(p.path())?.count(), 1);
    }
    Ok(())
}

#[test]
fn absolute_private_profile_required_and_replacement_rejected() -> Result<()> {
    assert!(AppSettings::open(Path::new("relative-profile")).is_err());
    let p = Profile::new()?;
    let settings = AppSettings::open(p.path())?;
    settings.set_limit(6)?;
    let disk = fs::read(p.file())?;
    for mode in [0o755, 0o770, 0o1700] {
        fs::set_permissions(p.path(), fs::Permissions::from_mode(mode))?;
        assert!(AppSettings::open(p.path()).is_err());
        assert!(settings.set_limit(3).is_err());
        assert_eq!(settings.limit(), 6);
        assert_eq!(fs::read(p.file())?, disk);
    }
    fs::set_permissions(p.path(), fs::Permissions::from_mode(0o700))?;
    let alias = Profile::new()?;
    symlink(p.path(), alias.path().join("alias"))?;
    assert!(AppSettings::open(&alias.path().join("alias")).is_err());
    assert!(AppSettings::open(&alias.path().join("alias/child")).is_err());
    assert!(AppSettings::open(&p.path().join("../elsewhere")).is_err());
    let replacement = Profile::new()?;
    let moved = replacement.path().join("moved");
    fs::rename(p.path(), &moved)?;
    fs::create_dir(p.path())?;
    fs::set_permissions(p.path(), fs::Permissions::from_mode(0o700))?;
    assert!(settings.set_limit(3).is_err());
    assert_eq!(settings.limit(), 6);
    assert_eq!(fs::read(moved.join("app-settings.json"))?, disk);
    assert_eq!(fs::read_dir(p.path())?.count(), 0);
    Ok(())
}

#[test]
fn failed_save_preserves_memory_disk_and_other_profile_files() -> Result<()> {
    let p = Profile::new()?;
    fs::write(p.path().join("unrelated"), b"untouched")?;
    let settings = AppSettings::open(p.path())?;
    settings.set_limit(5)?;
    let before = fs::read(p.file())?;
    let snapshot = settings.snapshot();
    settings.fail_before_rename.store(true, Ordering::Relaxed);
    assert!(settings.set_limit(7).is_err());
    assert_eq!(settings.snapshot(), snapshot);
    assert_eq!(fs::read(p.file())?, before);
    assert_eq!(fs::read_dir(p.path())?.count(), 2); // failed save cleaned its temp
    // Force a deterministic precommit failure without changing global resources.
    fs::set_permissions(p.file(), fs::Permissions::from_mode(0o400))?;
    assert!(settings.set_limit(7).is_err());
    assert_eq!(settings.limit(), 5);
    assert_eq!(fs::read(p.file())?, before);
    assert_eq!(fs::read_dir(p.path())?.count(), 2);
    assert_eq!(fs::read(p.path().join("unrelated"))?, b"untouched");
    fs::set_permissions(p.file(), fs::Permissions::from_mode(0o600))?;
    settings.set_limit(1)?;
    assert_eq!(fs::read(p.path().join("unrelated"))?, b"untouched");
    Ok(())
}

#[test]
fn directory_fsync_failure_returns_committed_snapshot_with_warning() -> Result<()> {
    let p = Profile::new()?;
    let settings = AppSettings::open(p.path())?;
    settings.set_limit(3)?;
    settings.fail_directory_sync.store(true, Ordering::Relaxed);
    let committed = settings.set_limit(8)?;
    assert_eq!(committed["maxConcurrentSessions"], 8);
    assert!(committed["warning"].as_str().unwrap().contains("persistencia"));
    assert_eq!(settings.limit(), 8);
    assert_eq!(settings.snapshot(), committed);
    assert_eq!(AppSettings::open(p.path())?.limit(), 8);
    assert_eq!(fs::read_dir(p.path())?.count(), 1);
    assert!(settings.set_limit(8)?["warning"].is_null());
    Ok(())
}

#[test]
fn concurrent_readers_and_writers_observe_complete_settings() -> Result<()> {
    let p = Profile::new()?;
    let settings = Arc::new(AppSettings::open(p.path())?);
    settings.set_limit(2)?;
    let done = Arc::new(AtomicBool::new(false));
    let observer = {
        let path = p.file();
        let done = done.clone();
        thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                assert_eq!(value.as_object().unwrap().len(), 3);
                assert_eq!(value["schemaVersion"], 2);
                assert_eq!(value["pulsoAutoAccess"], true);
                assert!((1..=8).contains(&value["maxConcurrentSessions"].as_u64().unwrap()));
            }
        })
    };
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (1..=8).map(|limit| {
        let settings = settings.clone();
        let barrier = barrier.clone();
        thread::spawn(move || {
            barrier.wait();
            for _ in 0..12 {
                assert_eq!(settings.set_limit(limit).unwrap()["maxConcurrentSessions"], limit);
                assert!((1..=8).contains(&settings.limit()));
                assert!(settings.snapshot()["warning"].is_null());
            }
        })
    }).collect();
    for worker in workers { worker.join().unwrap(); }
    done.store(true, Ordering::Release);
    observer.join().unwrap();
    assert_eq!(settings.limit(), AppSettings::open(p.path())?.limit());
    assert_eq!(fs::read_dir(p.path())?.count(), 1);
    Ok(())
}

#[test]
fn migrates_old_settings_and_persists_pulso_preference() -> Result<()> {
    let p = Profile::new()?;
    p.seed(br#"{"schemaVersion":1,"maxConcurrentSessions":4}"#)?;
    let settings = AppSettings::open(p.path())?;
    assert_eq!(settings.limit(), 4);
    assert!(settings.pulso_auto_access());
    let saved = settings.update(None, Some(false))?;
    assert_eq!(saved["pulsoAutoAccess"], false);
    assert_eq!(saved["maxConcurrentSessions"], 4);
    let reopened = AppSettings::open(p.path())?;
    assert!(!reopened.pulso_auto_access());
    assert_eq!(reopened.limit(), 4);
    assert_eq!(reopened.update(Some(5), Some(true))?["pulsoAutoAccess"], true);
    assert_eq!(AppSettings::open(p.path())?.limit(), 5);
    Ok(())
}
