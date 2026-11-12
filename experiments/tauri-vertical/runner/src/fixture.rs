use anyhow::{Result, bail};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub fn run(id: &str) -> Result<()> {
    if unsafe { libc::isatty(0) } != 1 || unsafe { libc::isatty(1) } != 1 {
        bail!("fixture requires a real PTY");
    }
    // Serialize heartbeat and flood so the marker always follows the entire payload.
    let out = Arc::new(Mutex::new(std::io::stdout()));
    {
        let mut out = out.lock().unwrap();
        writeln!(out, "READY {id} isatty=true")?;
        out.flush()?;
    }
    let beat_out = out.clone();
    let beat_id = id.to_owned();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let mut out = beat_out.lock().unwrap();
            if writeln!(out, "HEARTBEAT {beat_id}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    });
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let mut out = out.lock().unwrap();
        match line.trim() {
            "ping" => writeln!(out, "PONG {id}")?,
            "descendant" | "descendant-group" => {
                // Disposable same-group child deliberately survives SIGTERM.
                // stop must kill it while the owned leader still pins its pgid.
                let mut command=std::process::Command::new(std::env::current_exe()?);
                command.arg("--fixture-descendant");
                if line.trim()=="descendant-group" {command.arg("--own-group");}
                let child=command.spawn()?;
                std::thread::spawn(move || { let mut child=child;let _=child.wait(); });
            }
            "querywatch" => {
                let mut term:libc::termios=unsafe {std::mem::zeroed()};
                if unsafe {libc::tcgetattr(0,&mut term)}<0 {return Err(std::io::Error::last_os_error().into());}
                term.c_lflag &= !(libc::ICANON | libc::ECHO);
                term.c_cc[libc::VMIN]=1;term.c_cc[libc::VTIME]=0;
                if unsafe {libc::tcsetattr(0,libc::TCSANOW,&term)}<0 {return Err(std::io::Error::last_os_error().into());}
                write!(out,"QUERY_WATCH_READY {id}\r\n\x1b[6n")?;out.flush()?;
                let mut bytes=[0u8;128];
                loop {
                    // Read from the already-held stdin lock, not stdin() again.
                    let n=unsafe {libc::read(0,bytes.as_mut_ptr().cast(),bytes.len())};
                    if n<0 {
                        if std::io::Error::last_os_error().kind()==std::io::ErrorKind::Interrupted {continue;}
                        return Err(std::io::Error::last_os_error().into());
                    }
                    if n==0 {return Ok(());}
                    let hex:String=bytes[..n as usize].iter().map(|b|format!("{b:02x}")).collect();
                    writeln!(out,"INPUT_HEX {hex}")?;out.flush()?;
                }
            }
            "size" => {
                let mut size: libc::winsize = unsafe { std::mem::zeroed() };
                if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut size) } < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                writeln!(out, "SIZE {id} {} {}", size.ws_row, size.ws_col)?;
            }
            "flood" => {
                writeln!(out, "FLOOD_BEGIN {id}")?;
                let block = [b'X'; 8192];
                for _ in 0..640 {
                    out.write_all(&block)?;
                }
                writeln!(out, "\nFLOOD_END {id}")?;
            }
            "burst" => {
                let block = [b'Y'; 8192];
                for _ in 0..8 { out.write_all(&block)?; }
                writeln!(out, "\nBURST_END {id}")?;
                out.flush()?;
                break;
            }
            "exit" => break,
            text if text.starts_with("echo ") => writeln!(out, "{}", &text[5..])?,
            _ => writeln!(out, "UNKNOWN {id}")?,
        }
        out.flush()?;
    }
    Ok(())
}
