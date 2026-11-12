//! Local, bounded Git worktree operations. No recovery operation deletes anything.
//! `prepare` pins the initial HEAD; `verify` accepts later commits descending from
//! that base and deliberately ignores working-tree/index dirtiness.
//!
//! Filesystem/config/ref checks are snapshots, not a lock against another writer.
//! The caller must serialize writers and surface errors (including partial adds)
//! for human attention. This module never rolls back a failed add.
//! The caller also owns data-directory placement outside the original checkout.
//! Each public operation shares a 45-second deadline with its nested calls.
//! Each Git invocation also has a 30-second/256-KiB limit (16 MiB for ls-tree).
//! Global/system
//! config is excluded; local filter drivers and
//! conditional includes are rejected before checkout. Filter declarations in
//! exact-base attributes and common info/attributes are also rejected, avoiding
//! silent pointer-file checkouts when an excluded global driver was required.
use anyhow::{Context, Result, bail, ensure};
use std::{
    cell::Cell,
    ffi::OsStr,
    fs,
    io::{Read, ErrorKind},
    os::unix::{fs::OpenOptionsExt, io::AsRawFd, process::CommandExt},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

const MAX_PATH: usize = 4096;
const MAX_BRANCH: usize = 1024;
const OUTPUT_LIMIT: usize = 256 * 1024; // combined stdout + stderr, per invocation
const TREE_OUTPUT_LIMIT: usize = 16 * 1024 * 1024; // only the exact-base ls-tree query
const TIMEOUT: Duration = Duration::from_secs(30);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(45);
const UNSUPPORTED_CONFIG: &str = "^(filter\\.|includeif\\.|core\\.attributesfile$)";

#[derive(Debug)]
struct Busy(String);
impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Git metadata is busy: {}; preserve locks and retry later", self.0)
    }
}
impl std::error::Error for Busy {}

#[derive(Debug)]
struct Deadline(&'static str);
impl std::fmt::Display for Deadline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Git exceeded {} deadline; partial work is preserved", self.0)
    }
}
impl std::error::Error for Deadline {}

/// Classify typed lock/deadline errors through any added anyhow context. Useful
/// for read-only verification: these alone do not establish identity corruption.
/// An apply error can still mean partial effects, even when transient is true;
/// never use this predicate to retry apply or roll back an uncertain add.
pub fn transient(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<Busy>() || cause.is::<Deadline>())
}

thread_local! {
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

// Synchronous operations stay on this thread. Only the outermost guard owns the
// deadline; nested public calls must neither extend nor clear their parent's.
struct Budget { owner: bool }
impl Budget {
    fn begin() -> Result<Self> { Self::with_timeout(OPERATION_TIMEOUT) }

    fn with_timeout(timeout: Duration) -> Result<Self> {
        let owner = DEADLINE.with(|deadline| {
            if deadline.get().is_some() { false } else {
                deadline.set(Some(Instant::now() + timeout));
                true
            }
        });
        let guard = Self { owner };
        remaining()?;
        Ok(guard)
    }
}
impl Drop for Budget {
    fn drop(&mut self) {
        if self.owner { DEADLINE.with(|deadline| deadline.set(None)); }
    }
}

fn remaining() -> Result<Duration> {
    DEADLINE.with(|deadline| match deadline.get() {
        Some(end) => {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() { return Err(Deadline("aggregate").into()); }
            Ok(left)
        }
        None => Ok(TIMEOUT), // Private fixture queries outside a public operation.
    })
}

/// Share one 45-second budget across a synchronous domain operation, including
/// multiple inspect/prepare/verify calls. Nested scopes retain the outer deadline;
/// only its owner clears it on return, error or unwind. Git observes the deadline
/// cooperatively; the closure must not introduce unbounded non-Git blocking work.
pub fn operation<T>(work: impl FnOnce() -> Result<T>) -> Result<T> {
    let _budget = Budget::begin()?;
    work()
}

#[derive(Clone, Debug)]
pub struct Repo {
    pub root: String,
    pub common_dir: String,
    pub head: String,
    pub branch: Option<String>,
}

/// Opaque, single-use plan. Preflight has no Git mutation; persist intent before
/// handing the plan to apply. Hold the caller's workspace gate across both.
#[derive(Debug)]
pub struct Prepared {
    repo: Repo,
    dest: PathBuf,
    branch: String,
    base: String,
}

fn path_text(path: &Path) -> Result<&str> {
    let value = path.to_str().context("Git paths must be UTF-8")?;
    ensure!(!value.is_empty() && value.len() <= MAX_PATH && !value.contains('\0'),
        "Git path is empty, contains NUL, or exceeds {MAX_PATH} bytes");
    Ok(value)
}

fn canonical(path: &Path) -> Result<PathBuf> {
    path_text(path)?;
    let resolved = fs::canonicalize(path).context("canonicalizing Git path")?;
    path_text(&resolved)?;
    Ok(resolved)
}

fn oid(value: &str) -> Result<()> {
    ensure!((value.len() == 40 || value.len() == 64)
        && value.bytes().all(|b| b.is_ascii_hexdigit()), "base must be a full 40- or 64-digit commit SHA");
    Ok(())
}

#[derive(Debug)]
struct Output {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

// Own the process group even on an I/O error; descendants cannot keep the pipes
// open indefinitely. SIGKILL is intentional on timeout/overflow, followed by reap.
struct Running { child: Child, reaped: bool }
impl Running {
    fn exited(&self) -> Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe { libc::waitid(libc::P_PID, self.child.id() as _, &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
        if result == -1 {
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted { return Ok(false); }
            return Err(error).context("observing Git exit without reaping");
        }
        Ok(unsafe { info.si_pid() } != 0)
    }
    fn finish(&mut self) -> Result<ExitStatus> {
        // The owned session leader is still unreaped: its PID/PGID cannot be
        // reused between this signal and wait, including on successful exits.
        unsafe { libc::killpg(self.child.id() as i32, libc::SIGKILL); }
        let status = self.child.wait().context("reaping Git")?;
        self.reaped = true;
        Ok(status)
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if !self.reaped { let _ = self.finish(); }
    }
}

fn nonblocking(fd: i32) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    ensure!(flags != -1 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } != -1,
        "could not make Git output nonblocking");
    Ok(())
}

fn drain(reader: &mut impl Read, into: &mut Vec<u8>, used: &mut usize, limit: usize) -> Result<bool> {
    let mut buf = [0; 8192];
    // Bound each drain too: a continuously writing child must not starve the clock.
    for _ in 0..16 {
        match reader.read(&mut buf) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                ensure!(n <= limit.saturating_sub(*used), "Git output exceeded {limit} bytes; partial work is preserved");
                *used += n;
                into.extend_from_slice(&buf[..n]);
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e).context("reading Git output"),
        }
    }
    Ok(false)
}

fn command(cwd: &Path) -> Command {
    let mut cmd = Command::new("/usr/bin/git");
    cmd.current_dir(cwd).env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C").env("LC_ALL", "C").env("TERM", "dumb")
        .env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "").env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_LFS_SKIP_SMUDGE", "1").env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(home) = std::env::var_os("HOME") { cmd.env("HOME", home); }
    // No inherited GIT_*, loader, shell, XDG, credential, or executable overrides.
    for setting in [
        "core.hooksPath=/dev/null", "core.fsmonitor=false", "submodule.recurse=false",
        "fetch.recurseSubmodules=false", "protocol.allow=never", "credential.helper=",
        "gc.auto=0", "maintenance.auto=false", "core.pager=cat",
    ] { cmd.arg("-c").arg(setting); }
    cmd
}

fn execute(mut cmd: Command, timeout: Duration, limit: usize) -> Result<Output> {
    remaining()?;
    if timeout.is_zero() { return Err(Deadline("invocation").into()); }
    let start = Instant::now();
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 { return Err(std::io::Error::last_os_error()); }
            Ok(())
        });
    }
    let mut child = Running { child: cmd.spawn().context("starting /usr/bin/git")?, reaped: false };
    let mut stdout = child.child.stdout.take().context("missing Git stdout")?;
    let mut stderr = child.child.stderr.take().context("missing Git stderr")?;
    nonblocking(stdout.as_raw_fd())?;
    nonblocking(stderr.as_raw_fd())?;
    let (mut out, mut err, mut used) = (Vec::new(), Vec::new(), 0);
    let (mut out_done, mut err_done) = (false, false);
    loop {
        remaining()?;
        if start.elapsed() >= timeout { return Err(Deadline("invocation").into()); }
        if !out_done { out_done = drain(&mut stdout, &mut out, &mut used, limit)?; }
        if !err_done { err_done = drain(&mut stderr, &mut err, &mut used, limit)?; }
        if child.exited()? && out_done && err_done {
            return Ok(Output { status: child.finish()?, stdout: out, stderr: err });
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn git(cwd: &Path, args: &[&OsStr]) -> Result<Output> {
    git_with_limit(cwd, args, OUTPUT_LIMIT)
}

fn git_with_limit(cwd: &Path, args: &[&OsStr], limit: usize) -> Result<Output> {
    let timeout = TIMEOUT.min(remaining()?);
    let mut cmd = command(cwd);
    cmd.args(args);
    execute(cmd, timeout, limit)
}

fn run(cwd: &Path, args: &[&str]) -> Result<Output> {
    git(cwd, &args.iter().map(OsStr::new).collect::<Vec<_>>())
}

fn checked(output: Output) -> Result<Vec<u8>> {
    ensure!(output.status.success(), "Git failed ({}): {}", output.status,
        String::from_utf8_lossy(&output.stderr));
    Ok(output.stdout)
}

// Remove exactly Git's trailing LF, never trim spaces from a path or branch.
fn line(bytes: Vec<u8>) -> Result<String> {
    let mut value = String::from_utf8(bytes).context("Git returned non-UTF-8 data")?;
    ensure!(value.ends_with('\n'), "Git returned an unterminated response");
    value.pop();
    ensure!(!value.contains('\0'), "Git returned NUL in a response");
    Ok(value)
}
fn query(cwd: &Path, args: &[&str]) -> Result<String> { line(checked(run(cwd, args)?)?) }

/// Inspect an ordinary or linked worktree, including detached HEAD. Reject bare,
/// unborn, missing and non-UTF-8 repositories. All returned paths are canonical.
pub fn inspect(path: &Path) -> Result<Repo> {
    let _budget = Budget::begin()?;
    let path = canonical(path)?;
    ensure!(query(&path, &["rev-parse", "--is-bare-repository"])? == "false", "bare repositories are unsupported");
    ensure!(query(&path, &["rev-parse", "--is-inside-work-tree"])? == "true", "not inside a Git worktree");
    let root = query(&path, &["rev-parse", "--path-format=absolute", "--show-toplevel"])?;
    let common = query(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let root = canonical(Path::new(&root))?;
    let common = canonical(Path::new(&common))?;
    let head = query(&root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    oid(&head)?;
    let symbolic = run(&root, &["symbolic-ref", "--quiet", "HEAD"])?;
    let branch = if symbolic.status.success() {
        let full = line(symbolic.stdout)?;
        let name = full.strip_prefix("refs/heads/").context("HEAD is not a local branch")?;
        ensure!(name.len() <= MAX_BRANCH, "branch name exceeds limit");
        Some(name.to_owned())
    } else {
        ensure!(symbolic.status.code() == Some(1), "reading symbolic HEAD failed: {}", String::from_utf8_lossy(&symbolic.stderr));
        None
    };
    Ok(Repo { root: path_text(&root)?.to_owned(), common_dir: path_text(&common)?.to_owned(), head, branch })
}

fn identity(repo: &Repo) -> Result<Repo> {
    path_text(Path::new(&repo.common_dir))?;
    let now = inspect(Path::new(&repo.root))?;
    ensure!(now.root == repo.root && now.common_dir == repo.common_dir,
        "repository identity changed; refusing worktree operation");
    Ok(now)
}

fn branch_valid(root: &Path, branch: &str) -> Result<()> {
    ensure!(!branch.is_empty() && branch.len() <= MAX_BRANCH && !branch.starts_with('-') && !branch.contains('\0'),
        "invalid or oversized branch name");
    // Validate a literal ref, not check-ref-format --branch (which expands @{-1}).
    checked(run(root, &["check-ref-format", &format!("refs/heads/{branch}")])?)?;
    Ok(())
}

fn commit(root: &Path, base: &str) -> Result<()> {
    oid(base)?;
    ensure!(query(root, &["cat-file", "-t", base])? == "commit", "base must name a commit, not a tag or tree");
    Ok(())
}

fn no_filters(root: &Path) -> Result<()> {
    // Reject *all* configured filter drivers, including required/process/clean.
    // Global/system configs are excluded for every invocation. Worktree-local
    // configs and conditional includes remain visible to this query.
    // Conditional includes could become active only at the destination gitdir.
    // Reject them as well rather than miss a newly activated filter driver.
    let output = run(root, &["config", "--null", "--name-only", "--get-regexp", UNSUPPORTED_CONFIG])?;
    if output.status.success() { bail!("configured Git filters, conditional includes or core.attributesFile are unsupported; checkout was not started"); }
    ensure!(output.status.code() == Some(1), "could not inspect Git filters: {}", String::from_utf8_lossy(&output.stderr));
    Ok(())
}

fn no_configured_filters(repo: &Repo) -> Result<()> {
    let root = Path::new(&repo.root);
    no_filters(root)?;
    // A linked source can inherit main-worktree settings when adding another.
    let config_path = Path::new(&repo.common_dir).join("config.worktree");
    path_text(&config_path)?;
    if config_path.exists() {
        let output = git(root, &[OsStr::new("config"), OsStr::new("--file"), config_path.as_os_str(),
            OsStr::new("--includes"), OsStr::new("--null"), OsStr::new("--name-only"),
            OsStr::new("--get-regexp"), OsStr::new(UNSUPPORTED_CONFIG)])?;
        ensure!(output.status.code() == Some(1), "main worktree config contains unsupported attributes/filters or could not be checked");
    }
    Ok(())
}

fn reject_filter_attributes(bytes: &[u8]) -> Result<()> {
    // Parse only attribute tokens, never evaluate patterns or log file contents.
    // Conservative for macros/quoted patterns: even an unset filter is refused.
    for line in bytes.split(|b| *b == b'\n') {
        let line = line.trim_ascii_start();
        if line.is_empty() || line[0] == b'#' { continue; }
        for token in line.split(|b| b.is_ascii_whitespace()) {
            let token = token.strip_prefix(b"-").or_else(|| token.strip_prefix(b"!")).unwrap_or(token);
            ensure!(token != b"filter" && !token.starts_with(b"filter="),
                "unsupported filter declaration in Git attributes; checkout was not started");
        }
    }
    Ok(())
}

fn no_attribute_filters(root: &Path, common: &str, base: &str) -> Result<()> {
    // Object IDs come from the exact base tree, not the dirty worktree/index.
    // Only this tree listing gets 16 MiB; individual attribute blobs, registry
    // queries and all other invocations retain the 256-KiB combined limit.
    let tree = checked(git_with_limit(root, &[OsStr::new("ls-tree"), OsStr::new("-r"),
        OsStr::new("-z"), OsStr::new("--full-tree"), OsStr::new(base)], TREE_OUTPUT_LIMIT)?)?;
    ensure!(tree.is_empty() || tree.ends_with(&[0]), "unterminated Git tree listing");
    for entry in tree.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        remaining()?;
        let tab = entry.iter().position(|b| *b == b'\t').context("malformed Git tree entry")?;
        let (header, path) = (&entry[..tab], &entry[tab + 1..]);
        let name = std::str::from_utf8(path).context("non-UTF-8 path in base tree")?;
        path_text(Path::new(name))?;
        if Path::new(name).file_name() != Some(OsStr::new(".gitattributes")) { continue; }
        let header = std::str::from_utf8(header).context("invalid Git tree header")?;
        let parts: Vec<_> = header.split(' ').collect();
        ensure!(parts.len() == 3 && matches!(parts[0], "100644" | "100755") && parts[1] == "blob",
            "unsupported non-regular .gitattributes in base tree");
        oid(parts[2])?;
        reject_filter_attributes(&checked(run(root, &["cat-file", "blob", parts[2]])?)?)?;
    }
    no_info_attribute_filters(common)
}

fn no_info_attribute_filters(common: &str) -> Result<()> {
    remaining()?;
    let info = Path::new(common).join("info/attributes");
    path_text(&info)?;
    let file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&info);
    let file = match file {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e).context("reading common info/attributes (symlinks unsupported)"),
    };
    ensure!(file.metadata()?.is_file(), "common info/attributes must be a regular file");
    let mut bytes = Vec::new();
    file.take((OUTPUT_LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= OUTPUT_LIMIT, "common info/attributes exceeds bounded read limit");
    reject_filter_attributes(&bytes)
}

fn metadata_not_busy(root: &Path, common: &str) -> Result<()> {
    let dir = canonical(Path::new(&query(root, &["rev-parse", "--absolute-git-dir"])?))?;
    for path in [dir.join("index.lock"), dir.join("HEAD.lock"), dir.join("locked"),
        Path::new(common).join("index.lock"), Path::new(common).join("packed-refs.lock"),
        Path::new(common).join("shallow.lock")] {
        path_text(&path)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => return Err(Busy(path.display().to_string()).into()),
            Err(e) if e.kind() == ErrorKind::NotFound => {},
            Err(e) => return Err(e).context("checking Git metadata locks"),
        }
    }
    Ok(())
}

fn registered(root: &Path, dest: &Path, branch: &str, head: &str) -> Result<()> {
    let bytes = checked(run(root, &["worktree", "list", "--porcelain", "-z"])?)?;
    let text = std::str::from_utf8(&bytes).context("non-UTF-8 worktree registry")?;
    ensure!(text.ends_with("\0\0"), "malformed worktree registry");
    let expected_path = format!("worktree {}", path_text(dest)?);
    let expected_branch = format!("branch refs/heads/{branch}");
    let expected_head = format!("HEAD {head}");
    let mut matches = 0;
    for record in text.split("\0\0").filter(|s| !s.is_empty()) {
        let fields: Vec<_> = record.split('\0').collect();
        let entry_path = fields.first().and_then(|s| s.strip_prefix("worktree "))
            .context("malformed worktree registry path")?;
        path_text(Path::new(entry_path))?;
        if fields.first().copied() != Some(expected_path.as_str()) { continue; }
        matches += 1;
        ensure!(fields.contains(&expected_branch.as_str()) && fields.contains(&expected_head.as_str()),
            "worktree registry branch/HEAD disagrees with destination");
        if fields.iter().any(|field| *field == "locked" || field.starts_with("locked ")) {
            return Err(Busy(format!("worktree registry lock at {}", dest.display())).into());
        }
        ensure!(!fields.iter().any(|field| *field == "bare" || *field == "detached"
            || *field == "prunable" || field.starts_with("prunable ")),
            "worktree registry reports detached, bare or prunable state; preserve for attention");
    }
    ensure!(matches == 1, "destination must have exactly one matching worktree registry entry");
    Ok(())
}

fn destination(dest: &Path) -> Result<PathBuf> {
    path_text(dest)?;
    ensure!(dest.is_absolute(), "worktree destination must be absolute");
    ensure!(!dest.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)),
        "worktree destination must have a canonical parent");
    let parent = dest.parent().context("destination needs a parent")?;
    let parent_real = canonical(parent)?;
    ensure!(parent == parent_real && parent_real.is_dir(), "destination parent must exist and be canonical");
    let name = dest.file_name().context("destination needs a filename")?;
    let normalized = parent_real.join(name);
    ensure!(dest.as_os_str() == normalized.as_os_str(), "destination must be a canonical absolute path");
    Ok(normalized)
}

fn absent_destination(dest: &Path) -> Result<()> {
    match fs::symlink_metadata(dest) {
        Ok(_) => bail!("destination already exists (including symlinks)"),
        Err(e) if e.kind() == ErrorKind::NotFound => {},
        Err(e) => return Err(e).context("checking destination"),
    }
    Ok(())
}

/// Perform every read-only eligibility check before the caller persists intent.
/// No branch, worktree, directory or lock is created on success or failure.
pub fn preflight(repo: &Repo, dest: &Path, branch: &str, base: &str) -> Result<Prepared> {
    let _budget = Budget::begin()?;
    let repo = identity(repo)?;
    let root = Path::new(&repo.root);
    let dest = destination(dest)?;
    absent_destination(&dest)?;
    branch_valid(root, branch)?;
    let existing = run(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])?;
    ensure!(existing.status.code() == Some(1), "branch exists or could not be checked; refusing overwrite");
    commit(root, base)?;
    metadata_not_busy(root, &repo.common_dir)?;
    no_configured_filters(&repo)?;
    no_attribute_filters(root, &repo.common_dir, base)?;
    Ok(Prepared { repo, dest, branch: branch.to_owned(), base: base.to_owned() })
}

/// Consume a plan only after durable intent. Recheck mutable safety inputs before
/// the add, then verify the initial HEAD. Any error must preserve partial state;
/// the caller must not retry an uncertain apply, including a transient error.
pub fn apply(plan: Prepared) -> Result<()> {
    let _budget = Budget::begin()?;
    let Prepared { repo, dest, branch, base } = plan;
    identity(&repo)?;
    destination(&dest)?;
    absent_destination(&dest)?;
    let root = Path::new(&repo.root);
    metadata_not_busy(root, &repo.common_dir)?;
    no_configured_filters(&repo)?;
    no_info_attribute_filters(&repo.common_dir)?;
    remaining()?;
    // Suppress default HOME/XDG attribute files as well as any system attributes.
    // Effective local core.attributesFile was explicitly rejected above.
    checked(git(root, &[OsStr::new("-c"), OsStr::new("core.attributesFile=/dev/null"),
        OsStr::new("worktree"), OsStr::new("add"), OsStr::new("-b"),
        OsStr::new(&branch), OsStr::new("--"), dest.as_os_str(), OsStr::new(&base)])?)
        .context("adding worktree; any partial state is preserved for attention")?;
    verify(&repo, &dest, &branch, &base)?;
    let created = inspect(&dest)?;
    ensure!(created.head.eq_ignore_ascii_case(&base), "new worktree HEAD differs from exact base; partial state preserved");
    Ok(())
}

/// Convenience wrapper sharing one budget across preflight and apply. Never
/// force, overwrite, remove, prune, clean, reset or delete branches on failure.
pub fn prepare(repo: &Repo, dest: &Path, branch: &str, base: &str) -> Result<()> {
    operation(|| apply(preflight(repo, dest, branch, base)?))
}

/// Validate before first start/restart. Allows dirty files and later commits, but
/// requires the exact branch and the original base to remain an ancestor of HEAD.
/// This is an ancestry check, not proof of unchanged files or of agent provenance.
/// Reset/rebase past the base is an error requiring attention, never an automatic
/// reset or permission to restart a writer. Verification itself is read-only.
pub fn verify(repo: &Repo, dest: &Path, branch: &str, base: &str) -> Result<()> {
    let _budget = Budget::begin()?;
    identity(repo)?;
    let dest = destination(dest)?;
    ensure!(canonical(&dest)? == dest, "destination must itself be canonical (no symlink)");
    let found = inspect(&dest)?;
    ensure!(found.root == path_text(&dest)?, "destination is not the exact worktree root");
    ensure!(found.common_dir == repo.common_dir, "destination belongs to another repository");
    branch_valid(Path::new(&found.root), branch)?;
    ensure!(found.branch.as_deref() == Some(branch), "destination branch changed");
    registered(Path::new(&repo.root), &dest, branch, &found.head)?;
    metadata_not_busy(&dest, &repo.common_dir)?;
    commit(&dest, base)?;
    checked(run(&dest, &["merge-base", "--is-ancestor", base, "HEAD"])?)
        .context("expected base is not an ancestor of worktree HEAD")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use tempfile::TempDir;

    struct Fixture { _temp: TempDir, root: PathBuf, parent: PathBuf, repo: Repo }
    impl Fixture {
        fn new() -> Self {
            Self::with_format("sha1")
        }
        fn with_format(format: &str) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let parent = fs::canonicalize(temp.path()).unwrap();
            let root = parent.join("original repo with spaces");
            fs::create_dir(&root).unwrap();
            checked(run(&root, &["init", "--initial-branch=main", &format!("--object-format={format}")]) .unwrap()).unwrap();
            g(&root, &["config", "user.email", "fixture@example.invalid"]);
            g(&root, &["config", "user.name", "Disposable Fixture"]);
            fs::write(root.join("tracked"), "base\n").unwrap();
            g(&root, &["add", "tracked"]);
            g(&root, &["commit", "-m", "base"]);
            let repo = inspect(&root).unwrap();
            Self { _temp: temp, root, parent, repo }
        }
        fn dest(&self, name: &str) -> PathBuf { self.parent.join(name) }
    }
    fn g(root: &Path, args: &[&str]) -> Vec<u8> { checked(run(root, args).unwrap()).unwrap() }
    fn cfg(root: &Path, name: &str, value: &str) { g(root, &["config", name, value]); }
    fn script(path: &Path, text: &str) {
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn git_worktree_spaces_linked_two_branches_and_original_untouched() {
        let f = Fixture::new();
        fs::write(f.root.join("tracked"), "staged\n").unwrap();
        g(&f.root, &["add", "tracked"]);
        fs::write(f.root.join("tracked"), "unstaged\n").unwrap();
        fs::write(f.root.join("untracked"), "keep me\n").unwrap();
        let index = fs::read(Path::new(&f.repo.common_dir).join("index")).unwrap();
        let before = g(&f.root, &["status", "--porcelain=v1", "-z"]);
        let a = f.dest("task one with spaces");
        let b = f.dest("task two");
        prepare(&f.repo, &a, "task/one", &f.repo.head).unwrap();
        let linked = inspect(&a).unwrap();
        assert_eq!(linked.common_dir, f.repo.common_dir);
        assert_eq!(linked.root, a.to_str().unwrap());
        assert_eq!(linked.branch.as_deref(), Some("task/one"));
        prepare(&linked, &b, "task/two", &f.repo.head).unwrap();
        verify(&f.repo, &b, "task/two", &f.repo.head).unwrap();
        assert_eq!(fs::read(a.join("tracked")).unwrap(), b"base\n");
        assert_eq!(fs::read(b.join("tracked")).unwrap(), b"base\n");
        assert_eq!(g(&f.root, &["status", "--porcelain=v1", "-z"]), before);
        assert_eq!(fs::read(Path::new(&f.repo.common_dir).join("index")).unwrap(), index);
        assert_eq!(fs::read(f.root.join("tracked")).unwrap(), b"unstaged\n");
        assert_eq!(fs::read(f.root.join("untracked")).unwrap(), b"keep me\n");
        let original = inspect(&f.root).unwrap();
        assert_eq!(original.head, f.repo.head);
        assert_eq!(original.branch, f.repo.branch);
    }

    #[test]
    fn git_worktree_refuses_existing_branch_paths_symlinks_without_deleting() {
        let f = Fixture::new();
        let dest = f.dest("exists");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("sentinel"), "keep").unwrap();
        assert!(prepare(&f.repo, &dest, "new", &f.repo.head).is_err());
        assert_eq!(fs::read(dest.join("sentinel")).unwrap(), b"keep");
        let link = f.dest("dangling");
        symlink(f.dest("missing"), &link).unwrap();
        assert!(prepare(&f.repo, &link, "new", &f.repo.head).is_err());
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        let absent = f.dest("absent");
        assert!(prepare(&f.repo, &absent, "main", &f.repo.head).is_err());
        assert!(!absent.exists());
        assert_eq!(query(&f.root, &["rev-parse", "main"]).unwrap(), f.repo.head);
        assert!(prepare(&f.repo, Path::new("relative"), "new", &f.repo.head).is_err());
        assert!(prepare(&f.repo, &f.dest("missing/child"), "new", &f.repo.head).is_err());
        let parent_link = f.dest("parent link");
        symlink(&f.parent, &parent_link).unwrap();
        assert!(prepare(&f.repo, &parent_link.join("child"), "new", &f.repo.head).is_err());
    }

    #[test]
    fn git_worktree_verify_accepts_dirty_and_descendant_commits_rejects_wrong_identity() {
        let f = Fixture::new();
        let dest = f.dest("task");
        prepare(&f.repo, &dest, "task", &f.repo.head).unwrap();
        fs::write(dest.join("tracked"), "agent work\n").unwrap();
        fs::write(dest.join("untracked"), "agent draft").unwrap();
        verify(&f.repo, &dest, "task", &f.repo.head).unwrap();
        g(&dest, &["add", "tracked"]);
        verify(&f.repo, &dest, "task", &f.repo.head).unwrap();
        g(&dest, &["commit", "-m", "agent commit"]);
        verify(&f.repo, &dest, "task", &f.repo.head).unwrap();
        assert!(verify(&f.repo, &dest, "other", &f.repo.head).is_err());
        assert!(verify(&Fixture::new().repo, &dest, "task", &f.repo.head).is_err());
        fs::create_dir(dest.join("subdir")).unwrap();
        assert!(verify(&f.repo, &dest.join("subdir"), "task", &f.repo.head).is_err());
        let link = f.dest("alias");
        symlink(&dest, &link).unwrap();
        assert!(verify(&f.repo, &link, "task", &f.repo.head).is_err());
        let mut stale = f.repo.clone();
        stale.common_dir.push_str("-wrong");
        assert!(verify(&stale, &dest, "task", &f.repo.head).is_err());
        g(&dest, &["checkout", "--detach"]);
        assert!(verify(&f.repo, &dest, "task", &f.repo.head).is_err());
        assert!(inspect(&dest).unwrap().branch.is_none());
    }

    #[test]
    fn git_worktree_hooks_and_fsmonitor_disabled() {
        let f = Fixture::new();
        let sentinel = f.dest("executed");
        let hooks = f.dest("custom hooks");
        fs::create_dir(&hooks).unwrap();
        let text = format!("#!/bin/sh\nprintf executed > '{}'\n", sentinel.display());
        script(&hooks.join("post-checkout"), &text);
        script(&hooks.join("reference-transaction"), &text);
        let monitor = f.dest("fsmonitor");
        script(&monitor, &text);
        cfg(&f.root, "core.hooksPath", hooks.to_str().unwrap());
        cfg(&f.root, "core.fsmonitor", monitor.to_str().unwrap());
        prepare(&f.repo, &f.dest("task"), "task", &f.repo.head).unwrap();
        assert!(!sentinel.exists());
    }

    #[test]
    fn git_worktree_configured_smudge_filters_denied_before_execution() {
        let f = Fixture::new();
        fs::write(f.root.join(".gitattributes"), "tracked filter=hostile\n").unwrap();
        g(&f.root, &["add", ".gitattributes"]);
        g(&f.root, &["commit", "-m", "attribute"]);
        let repo = inspect(&f.root).unwrap();
        let sentinel = f.dest("filter executed");
        let filter = f.dest("filter script");
        script(&filter, &format!("#!/bin/sh\nprintf bad > '{}'\ncat\n", sentinel.display()));
        cfg(&f.root, "filter.hostile.smudge", &format!("'{}'", filter.display()));
        cfg(&f.root, "filter.hostile.required", "true");
        let dest = f.dest("task");
        let err = prepare(&repo, &dest, "task", &repo.head).unwrap_err();
        assert!(err.to_string().contains("filters"));
        assert!(!sentinel.exists());
        assert!(!dest.exists());
        assert!(!run(&f.root, &["show-ref", "--verify", "--quiet", "refs/heads/task"]).unwrap().status.success());
    }

    #[test]
    fn git_worktree_rejects_noncommit_unborn_bare_and_invalid_branches() {
        let f = Fixture::new();
        let empty = f.dest("empty");
        fs::create_dir(&empty).unwrap();
        assert!(inspect(&empty).is_err());
        g(&empty, &["init", "--initial-branch=main"]);
        assert!(inspect(&empty).is_err());
        let bare = f.dest("bare");
        fs::create_dir(&bare).unwrap();
        g(&bare, &["init", "--bare"]);
        assert!(inspect(&bare).is_err());
        for base in ["HEAD", "--help", "0000000000000000000000000000000000000000"] {
            assert!(prepare(&f.repo, &f.dest("bad"), "task", base).is_err());
        }
        let tree = query(&f.root, &["rev-parse", "HEAD^{tree}"]).unwrap();
        assert!(prepare(&f.repo, &f.dest("bad"), "task", &tree).is_err());
        for branch in ["-evil", "@{-1}", "bad..name", "bad\nname"] {
            assert!(prepare(&f.repo, &f.dest("bad"), branch, &f.repo.head).is_err());
        }
        assert!(!f.dest("bad").exists());
    }

    #[test]
    fn git_worktree_execution_bounds() {
        let f = Fixture::new();
        let mut cmd = command(&f.root);
        cmd.arg("--version");
        assert!(execute(cmd, TIMEOUT, 1).unwrap_err().to_string().contains("output exceeded"));
        let mut cmd = command(&f.root);
        cmd.arg("--version");
        assert!(execute(cmd, Duration::ZERO, OUTPUT_LIMIT).unwrap_err().to_string().contains("exceeded"));
    }

    #[test]
    fn git_worktree_aggregate_budget_shared_by_queries_and_nested_public_calls() {
        let f = Fixture::new();
        assert!(DEADLINE.with(Cell::get).is_none());
        {
            let _outer = Budget::with_timeout(Duration::from_millis(500)).unwrap();
            let deadline = DEADLINE.with(Cell::get).unwrap();
            checked(run(&f.root, &["--version"]).unwrap()).unwrap();
            let after_first = remaining().unwrap();
            {
                let _nested = Budget::begin().unwrap();
                assert!(!_nested.owner);
                checked(run(&f.root, &["--version"]).unwrap()).unwrap();
                assert!(remaining().unwrap() < after_first);
                inspect(&f.root).unwrap();
                assert_eq!(DEADLINE.with(Cell::get), Some(deadline));
            }
            assert_eq!(DEADLINE.with(Cell::get), Some(deadline));
            std::thread::sleep(deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(2));
            let error = run(&f.root, &["--version"]).unwrap_err();
            assert!(error.to_string().contains("aggregate deadline"));
            assert!(inspect(&f.root).unwrap_err().to_string().contains("aggregate deadline"));
            assert_eq!(DEADLINE.with(Cell::get), Some(deadline));
        }
        assert!(DEADLINE.with(Cell::get).is_none());
        // An expired/erroring nested call did not leak its deadline into the next
        // independent operation on the same thread.
        inspect(&f.root).unwrap();
        assert!(DEADLINE.with(Cell::get).is_none());
    }

    #[test]
    fn git_worktree_operation_scope_shares_deadline_and_clears_on_error_or_unwind() {
        let f = Fixture::new();
        let value = operation(|| {
            let deadline = DEADLINE.with(Cell::get).unwrap();
            let repo = inspect(&f.root)?;
            operation(|| {
                assert_eq!(DEADLINE.with(Cell::get), Some(deadline));
                prepare(&repo, &f.dest("scoped task"), "task", &repo.head)?;
                verify(&repo, &f.dest("scoped task"), "task", &repo.head)
            })?;
            assert_eq!(DEADLINE.with(Cell::get), Some(deadline));
            Ok(42)
        }).unwrap();
        assert_eq!(value, 42);
        assert!(DEADLINE.with(Cell::get).is_none());
        let error = operation::<()>(|| bail!("fixture error")).unwrap_err();
        assert_eq!(error.to_string(), "fixture error");
        assert!(DEADLINE.with(Cell::get).is_none());
        let panicked = std::panic::catch_unwind(|| {
            let _ = operation::<()>(|| panic!("fixture unwind"));
        });
        assert!(panicked.is_err());
        assert!(DEADLINE.with(Cell::get).is_none());
        {
            let _outer = Budget::with_timeout(Duration::from_millis(2)).unwrap();
            let deadline = DEADLINE.with(Cell::get).unwrap();
            std::thread::sleep(Duration::from_millis(3));
            let called = Cell::new(false);
            assert!(operation(|| { called.set(true); Ok(()) }).is_err());
            assert!(!called.get());
            assert_eq!(DEADLINE.with(Cell::get), Some(deadline));
        }
        assert!(DEADLINE.with(Cell::get).is_none());
    }

    #[test]
    fn git_worktree_5000_tracked_files_prepare_with_tree_specific_limit() {
        let f = Fixture::new();
        for i in 0..5000 {
            fs::write(f.root.join(format!("tracked-file-{i:05}.txt")), format!("file {i}\n")).unwrap();
        }
        g(&f.root, &["add", "."]);
        g(&f.root, &["commit", "--quiet", "-m", "5000 file fixture"]);
        let repo = inspect(&f.root).unwrap();
        // Demonstrate that this tree exceeds the ordinary query cap, which
        // remains unchanged; only preflight's exact-base listing gets 16 MiB.
        let error = run(&f.root, &["ls-tree", "-r", "-z", "--full-tree", &repo.head]).unwrap_err();
        assert!(error.to_string().contains("output exceeded"));
        assert!(!transient(&error));
        let dest = f.dest("large task");
        prepare(&repo, &dest, "large-task", &repo.head).unwrap();
        verify(&repo, &dest, "large-task", &repo.head).unwrap();
        assert_eq!(fs::read(dest.join("tracked-file-04999.txt")).unwrap(), b"file 4999\n");
        assert_eq!(g(&dest, &["ls-files", "-z"]).split(|b| *b == 0).filter(|s| !s.is_empty()).count(), 5001);
    }

    #[test]
    fn git_worktree_preflight_readonly_then_apply_consumes_plan() {
        let f = Fixture::new();
        let dest = f.dest("planned task");
        let index = fs::read(Path::new(&f.repo.common_dir).join("index")).unwrap();
        let registry = g(&f.root, &["worktree", "list", "--porcelain", "-z"]);
        let plan = preflight(&f.repo, &dest, "planned", &f.repo.head).unwrap();
        assert!(!dest.exists());
        assert_eq!(fs::read(Path::new(&f.repo.common_dir).join("index")).unwrap(), index);
        assert_eq!(g(&f.root, &["worktree", "list", "--porcelain", "-z"]), registry);
        assert_eq!(run(&f.root, &["show-ref", "--verify", "--quiet", "refs/heads/planned"]).unwrap().status.code(), Some(1));
        apply(plan).unwrap();
        verify(&f.repo, &dest, "planned", &f.repo.head).unwrap();
        let error = preflight(&f.repo, &f.dest("other"), "planned", &f.repo.head).unwrap_err();
        assert!(!transient(&error));
        assert!(!f.dest("other").exists());
    }

    #[test]
    fn git_worktree_apply_rechecks_changed_destination_and_config_without_overwrite() {
        let f = Fixture::new();
        let dest = f.dest("changed destination");
        let plan = preflight(&f.repo, &dest, "planned", &f.repo.head).unwrap();
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("sentinel"), "keep").unwrap();
        assert!(apply(plan).is_err());
        assert_eq!(fs::read(dest.join("sentinel")).unwrap(), b"keep");
        let dest = f.dest("changed config");
        let plan = preflight(&f.repo, &dest, "planned", &f.repo.head).unwrap();
        cfg(&f.root, "filter.new.smudge", "must-not-execute");
        assert!(apply(plan).is_err());
        assert!(!dest.exists());
        assert_eq!(run(&f.root, &["show-ref", "--verify", "--quiet", "refs/heads/planned"]).unwrap().status.code(), Some(1));
    }

    #[test]
    fn git_worktree_transient_metadata_and_deadlines_preserve_state() {
        let f = Fixture::new();
        let dest = f.dest("task");
        prepare(&f.repo, &dest, "task", &f.repo.head).unwrap();
        let index_path = Path::new(&f.repo.common_dir).join("index");
        let index = fs::read(&index_path).unwrap();
        let lock = Path::new(&f.repo.common_dir).join("index.lock");
        fs::write(&lock, "external owner").unwrap();
        let error = preflight(&f.repo, &f.dest("blocked"), "blocked", &f.repo.head).unwrap_err().context("domain context");
        assert!(transient(&error));
        assert!(transient(&verify(&f.repo, &dest, "task", &f.repo.head).unwrap_err().context("ready verification")));
        assert!(!transient(&verify(&f.repo, &dest, "wrong", &f.repo.head).unwrap_err()));
        assert_eq!(fs::read(&lock).unwrap(), b"external owner");
        assert_eq!(fs::read(&index_path).unwrap(), index);
        assert!(!f.dest("blocked").exists());
        {
            let _budget = Budget::with_timeout(Duration::from_millis(2)).unwrap();
            std::thread::sleep(Duration::from_millis(3));
            let error = preflight(&f.repo, &f.dest("expired"), "expired", &f.repo.head).unwrap_err().context("preflight deadline");
            assert!(transient(&error));
        }
        assert!(!f.dest("expired").exists());
        let mut cmd = command(&f.root);
        cmd.args(["worktree", "add", "-b", "query-expired", "--"]);
        cmd.arg(f.dest("query expired")).arg(&f.repo.head);
        let error = execute(cmd, Duration::ZERO, OUTPUT_LIMIT).unwrap_err().context("invocation deadline");
        assert!(transient(&error));
        assert!(!f.dest("query expired").exists());
        assert_eq!(run(&f.root, &["show-ref", "--verify", "--quiet", "refs/heads/query-expired"]).unwrap().status.code(), Some(1));
        assert_eq!(fs::read(&index_path).unwrap(), index);
    }

    #[test]
    fn git_worktree_success_not_reclassified_after_scope_work_commits() {
        let _budget = Budget::with_timeout(Duration::from_millis(30)).unwrap();
        let committed = Cell::new(false);
        let value = operation(|| {
            committed.set(true); // stand-in for a caller's committed domain effect
            std::thread::sleep(Duration::from_millis(40));
            Ok(42)
        }).unwrap();
        assert_eq!(value, 42);
        assert!(committed.get());
        assert!(transient(&remaining().unwrap_err()));
    }

    #[test]
    fn git_worktree_registry_mismatch_and_missing_path_refused() {
        let f = Fixture::new();
        let dest = f.dest("task");
        prepare(&f.repo, &dest, "task", &f.repo.head).unwrap();
        let admin = query(&dest, &["rev-parse", "--absolute-git-dir"]).unwrap();
        let missing = f.dest("missing");
        fs::write(Path::new(&admin).join("gitdir"), format!("{}/.git\n", missing.display())).unwrap();
        assert!(verify(&f.repo, &dest, "task", &f.repo.head).is_err());
        assert!(verify(&f.repo, &missing, "task", &f.repo.head).is_err());
        assert_eq!(fs::read(dest.join("tracked")).unwrap(), b"base\n");
        assert!(Path::new(&admin).exists());
    }

    #[test]
    fn git_worktree_metadata_locks_preserved_and_ref_conflicts_refused() {
        let f = Fixture::new();
        let lock = Path::new(&f.repo.common_dir).join("index.lock");
        fs::write(&lock, "owned by someone else").unwrap();
        assert!(prepare(&f.repo, &f.dest("blocked"), "blocked", &f.repo.head).is_err());
        assert_eq!(fs::read(&lock).unwrap(), b"owned by someone else");
        assert!(!f.dest("blocked").exists());
        // No lock removal even in the test; use another disposable repo.
        let f = Fixture::new();
        g(&f.root, &["branch", "prefix"]);
        assert!(prepare(&f.repo, &f.dest("conflict"), "prefix/child", &f.repo.head).is_err());
        assert_eq!(query(&f.root, &["rev-parse", "prefix"]).unwrap(), f.repo.head);
        let dest = f.dest("task");
        prepare(&f.repo, &dest, "task", &f.repo.head).unwrap();
        let admin = query(&dest, &["rev-parse", "--absolute-git-dir"]).unwrap();
        let lock = Path::new(&admin).join("index.lock");
        fs::write(&lock, "unfinished operation").unwrap();
        assert!(verify(&f.repo, &dest, "task", &f.repo.head).is_err());
        assert_eq!(fs::read(&lock).unwrap(), b"unfinished operation");
        let f = Fixture::new();
        let dest = f.dest("task");
        prepare(&f.repo, &dest, "task", &f.repo.head).unwrap();
        g(&f.root, &["worktree", "lock", dest.to_str().unwrap()]);
        assert!(verify(&f.repo, &dest, "task", &f.repo.head).is_err());
        assert!(dest.join("tracked").exists());
    }

    #[test]
    fn git_worktree_diverged_base_requires_attention_without_head_changes() {
        let f = Fixture::new();
        let dest = f.dest("task");
        prepare(&f.repo, &dest, "task", &f.repo.head).unwrap();
        let tree = query(&dest, &["rev-parse", "HEAD^{tree}"]).unwrap();
        let unrelated = query(&dest, &["commit-tree", &tree, "-m", "unrelated root"]).unwrap();
        g(&dest, &["update-ref", "refs/heads/task", &unrelated]);
        assert!(verify(&f.repo, &dest, "task", &f.repo.head).is_err());
        assert_eq!(inspect(&dest).unwrap().head, unrelated);
        assert_eq!(fs::read(dest.join("tracked")).unwrap(), b"base\n");
    }

    #[test]
    fn git_worktree_sha256_and_path_bounds() {
        use std::os::unix::ffi::OsStringExt;
        let f = Fixture::with_format("sha256");
        assert_eq!(f.repo.head.len(), 64);
        let dest = f.dest("sha256 task");
        prepare(&f.repo, &dest, "task", &f.repo.head).unwrap();
        verify(&f.repo, &dest, "task", &f.repo.head).unwrap();
        let invalid = f.parent.join(std::ffi::OsString::from_vec(vec![0xff]));
        assert!(inspect(&invalid).is_err());
        assert!(prepare(&f.repo, &invalid, "bad", &f.repo.head).is_err());
        let oversized = PathBuf::from(format!("/{}", "x".repeat(MAX_PATH)));
        assert!(inspect(&oversized).is_err());
        assert!(prepare(&f.repo, &oversized, "bad", &f.repo.head).is_err());
    }

    #[test]
    fn git_worktree_conditional_and_main_worktree_filters_denied() {
        let f = Fixture::new();
        let conditional = f.dest("only-destination-config");
        fs::write(&conditional, "[filter \"hidden\"]\nprocess = should-never-run\n").unwrap();
        cfg(&f.root, "includeIf.gitdir:/impossible/match/.path", conditional.to_str().unwrap());
        assert!(prepare(&f.repo, &f.dest("blocked"), "blocked", &f.repo.head).is_err());
        assert!(!f.dest("blocked").exists());
        let f = Fixture::new();
        let linked = f.dest("linked");
        prepare(&f.repo, &linked, "linked", &f.repo.head).unwrap();
        cfg(&f.root, "extensions.worktreeConfig", "true");
        g(&f.root, &["config", "--worktree", "filter.hostile.clean", "should-never-run"]);
        let linked = inspect(&linked).unwrap();
        assert!(prepare(&linked, &f.dest("blocked"), "blocked", &f.repo.head).is_err());
        assert!(!f.dest("blocked").exists());
    }

    #[test]
    fn git_worktree_exact_base_nested_attributes_rejected_despite_dirty_override() {
        for nested in [false, true] {
            let f = Fixture::new();
            let path = if nested {
                fs::create_dir(f.root.join("nested")).unwrap();
                f.root.join("nested/.gitattributes")
            } else { f.root.join(".gitattributes") };
            fs::write(&path, "*.bin filter=lfs\n").unwrap();
            g(&f.root, &["add", "."]);
            g(&f.root, &["commit", "-m", "base with filter declaration"]);
            let repo = inspect(&f.root).unwrap();
            // A clean-looking dirty/index version must not hide exact-base attrs.
            fs::write(&path, "# dirty attributes have no filter\n").unwrap();
            g(&f.root, &["add", "."]);
            let index = fs::read(Path::new(&repo.common_dir).join("index")).unwrap();
            let dest = f.dest("blocked");
            assert!(prepare(&repo, &dest, "blocked", &repo.head).unwrap_err().to_string().contains("filter declaration"));
            assert!(!dest.exists());
            assert_eq!(fs::read(Path::new(&repo.common_dir).join("index")).unwrap(), index);
            assert_eq!(fs::read(&path).unwrap(), b"# dirty attributes have no filter\n");
            // Conversely, dirty declarations absent from the selected older base
            // do not contaminate its checkout.
            prepare(&repo, &f.dest("older base"), "older-base", &f.repo.head).unwrap();
        }
    }

    #[test]
    fn git_worktree_common_info_attributes_and_configured_attribute_file_denied() {
        let f = Fixture::new();
        let info = Path::new(&f.repo.common_dir).join("info/attributes");
        fs::write(&info, "tracked filter=external\n").unwrap();
        assert!(prepare(&f.repo, &f.dest("blocked"), "blocked", &f.repo.head).is_err());
        assert!(!f.dest("blocked").exists());
        assert_eq!(fs::read(&info).unwrap(), b"tracked filter=external\n");
        let f = Fixture::new();
        let attrs = f.dest("external attributes");
        fs::write(&attrs, "* filter=lfs\n").unwrap();
        cfg(&f.root, "core.attributesFile", attrs.to_str().unwrap());
        assert!(prepare(&f.repo, &f.dest("blocked"), "blocked", &f.repo.head).is_err());
        assert!(!f.dest("blocked").exists());
    }

    #[test]
    fn git_worktree_global_only_lfs_driver_base_attributes_rejected_without_execution() {
        const CHILD: &str = "AW_GIT_ATTR_GLOBAL_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let root = PathBuf::from(std::env::var_os("AW_GIT_ATTR_ROOT").unwrap());
            let repo = inspect(&root).unwrap();
            let dest = root.parent().unwrap().join("blocked");
            let error = prepare(&repo, &dest, "blocked", &repo.head).unwrap_err();
            assert!(error.to_string().contains("filter declaration"), "{error:#}");
            assert!(!dest.exists());
            return;
        }
        let f = Fixture::new();
        fs::write(f.root.join(".gitattributes"), "tracked filter=lfs\n").unwrap();
        g(&f.root, &["add", ".gitattributes"]);
        g(&f.root, &["commit", "-m", "filter without local driver"]);
        let sentinel = f.dest("global filter executed");
        let driver = f.dest("global driver");
        script(&driver, &format!("#!/bin/sh\nprintf bad > '{}'\ncat\n", sentinel.display()));
        let home = f.dest("disposable home");
        fs::create_dir(&home).unwrap();
        let global = home.join(".gitconfig");
        fs::write(&global, format!("[filter \"lfs\"]\nsmudge = '{}'\nrequired = true\n", driver.display())).unwrap();
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["git_worktree_global_only_lfs_driver_base_attributes_rejected_without_execution", "--nocapture"])
            .env(CHILD, "1").env("AW_GIT_ATTR_ROOT", &f.root)
            .env("HOME", &home).env("GIT_CONFIG_GLOBAL", &global).output().unwrap();
        assert!(result.status.success(), "{} {}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        assert!(!sentinel.exists());
        assert!(!f.dest("blocked").exists());
    }

    // Test-only subprocess fixture; never invokes a shell or an agent. The
    // descendant inherits the leader's pipes and group, and self-expires too.
    #[test]
    fn git_worktree_process_group_fixture() {
        match std::env::var("AW_GIT_GROUP_ROLE").as_deref() {
            Ok("leader") => {
                let mut descendant = Command::new(std::env::current_exe().unwrap());
                descendant.args(["git_worktree_process_group_fixture", "--nocapture"])
                    .env("AW_GIT_GROUP_ROLE", "descendant")
                    .stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
                let child = descendant.spawn().unwrap();
                let path = PathBuf::from(std::env::var_os("AW_GIT_GROUP_PID").unwrap());
                fs::write(path, child.id().to_string()).unwrap();
                // Exit first: execute must keep this zombie unreaped while
                // descendant holds the pipes open, then kill the owned group.
            }
            Ok("descendant") => {
                std::thread::sleep(Duration::from_secs(5));
                fs::write(std::env::var_os("AW_GIT_GROUP_SENTINEL").unwrap(), "escaped").unwrap();
            }
            _ => {},
        }
    }

    #[test]
    fn git_worktree_timeout_kills_owned_group_after_leader_exit() {
        let temp = tempfile::tempdir().unwrap();
        let pid_file = temp.path().join("pid");
        let sentinel = temp.path().join("escaped");
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["git_worktree_process_group_fixture", "--nocapture"])
            .env("AW_GIT_GROUP_ROLE", "leader").env("AW_GIT_GROUP_PID", &pid_file)
            .env("AW_GIT_GROUP_SENTINEL", &sentinel)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let started = Instant::now();
        let error = execute(cmd, Duration::from_millis(500), OUTPUT_LIMIT).unwrap_err();
        assert!(transient(&error));
        assert!(error.to_string().contains("exceeded"));
        assert!(started.elapsed() < Duration::from_secs(3));
        let pid: i32 = fs::read_to_string(pid_file).unwrap().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if unsafe { libc::kill(pid, 0) } == -1 {
                assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
                break;
            }
            assert!(Instant::now() < deadline, "owned descendant survived group timeout");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!sentinel.exists());
    }

    // Spawn this same test under poisoned environment; never mutate process-wide
    // environment in Rust's parallel test runner or write user's global config.
    #[test]
    fn git_worktree_environment_poison_ignored() {
        const CHILD: &str = "AW_GIT_WORKTREE_POISON_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let root = PathBuf::from(std::env::var_os("AW_GIT_WORKTREE_ROOT").unwrap());
            let repo = inspect(&root).unwrap();
            assert_eq!(repo.root, root.to_str().unwrap());
            prepare(&repo, &root.parent().unwrap().join("poison task"), "task", &repo.head).unwrap();
            return;
        }
        let f = Fixture::new();
        let sentinel = f.dest("poison ran");
        let filter = f.dest("poison script");
        script(&filter, &format!("#!/bin/sh\ntouch '{}'\n", sentinel.display()));
        let global = f.dest("global config");
        fs::write(&global, format!("[filter \"hostile\"]\n smudge = '{}'\n[core]\n hooksPath = '{}'\n", filter.display(), f.parent.display())).unwrap();
        script(&f.parent.join("post-checkout"), &format!("#!/bin/sh\ntouch '{}'\n", sentinel.display()));
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["git_worktree_environment_poison_ignored", "--nocapture"])
            .env(CHILD, "1").env("AW_GIT_WORKTREE_ROOT", &f.root)
            .env("GIT_DIR", f.dest("not a repo")).env("GIT_WORK_TREE", f.dest("wrong"))
            .env("GIT_COMMON_DIR", f.dest("wrong common")).env("GIT_INDEX_FILE", f.dest("wrong index"))
            .env("GIT_CONFIG_COUNT", "1").env("GIT_CONFIG_KEY_0", "core.bare").env("GIT_CONFIG_VALUE_0", "true")
            .env("GIT_CONFIG_PARAMETERS", "'core.bare=true'")
            .env("GIT_CONFIG_GLOBAL", &global).env("GIT_CONFIG_SYSTEM", &global)
            .env("GIT_EXEC_PATH", &f.parent).env("GIT_TEMPLATE_DIR", &f.parent)
            .env("GIT_OBJECT_DIRECTORY", f.dest("wrong objects")).env("GIT_NAMESPACE", "wrong")
            .env("PATH", "/nonexistent").output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stdout));
        assert!(!sentinel.exists());
    }
}
