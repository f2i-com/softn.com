// A WASI command for softn.wasm.run's tests: what a C or Rust command-line
// program does with WASI, one command per first argument.
// Built by ../build.mjs: rustc --target wasm32-wasip1.

use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or("");
    match command {
        // The arguments it was given, the program's name first.
        "args" => println!("{}", args.join("|")),
        // A variable of its environment.
        "env" => println!("{}", std::env::var(&args[2]).unwrap_or_else(|_| "(unset)".into())),
        // stdin, shouted to stdout; a line to stderr.
        "shout" => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).unwrap();
            print!("{}", text.to_uppercase());
            eprintln!("read {} bytes", text.len());
        }
        // Read a file, write two, list the folder, rename and remove.
        "files" => {
            let input = std::fs::read_to_string("input.txt").unwrap();
            std::fs::create_dir_all("out/deep").unwrap();
            std::fs::write("out/result.txt", input.to_uppercase()).unwrap();
            std::fs::write("out/deep/bytes.bin", [0u8, 1, 2, 255]).unwrap();
            let mut f = std::fs::OpenOptions::new().append(true).open("out/result.txt").unwrap();
            f.write_all(b"!").unwrap();
            std::fs::write("scratch.txt", "gone").unwrap();
            std::fs::rename("scratch.txt", "moved.txt").unwrap();
            std::fs::remove_file("moved.txt").unwrap();
            let mut names: Vec<String> = std::fs::read_dir(".")
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            println!("{}", names.join(","));
            println!("{}", std::fs::metadata("out/result.txt").unwrap().len());
            match std::fs::read_to_string("missing.txt") {
                Ok(_) => println!("missing.txt was there"),
                Err(e) => println!("missing: {:?}", e.kind()),
            }
            match std::fs::read_to_string("../escape.txt") {
                Ok(_) => println!("escaped"),
                Err(_) => println!("stayed inside"),
            }
        }
        // An exit code of its choosing.
        "exit" => std::process::exit(args[2].parse().unwrap()),
        // A Rust panic: a message on stderr, then a trap.
        "panic" => panic!("deliberately"),
        // Never ends: for the time limit.
        "spin" => {
            let mut n: u64 = 0;
            loop {
                n = n.wrapping_add(1);
                if n == u64::MAX {
                    println!("{}", n);
                }
            }
        }
        // Asks for megabytes of memory: for the memory limit.
        "alloc" => {
            let mb: usize = args[2].parse().unwrap();
            let mut kept: Vec<Vec<u8>> = Vec::new();
            for _ in 0..mb {
                let mut block = vec![0u8; 1 << 20];
                block[0] = 1;
                kept.push(block);
            }
            println!("allocated {}", kept.len());
        }
        // The clocks, a short sleep, and a hash keyed by WASI's random numbers
        // (two runs print different ones only if random_get gives randomness).
        "time" => {
            use std::hash::BuildHasher;
            let wall = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            let start = std::time::Instant::now();
            std::thread::sleep(std::time::Duration::from_millis(20));
            let slept = start.elapsed().as_millis();
            let keyed = std::collections::hash_map::RandomState::new().hash_one("softn");
            let no_device = std::fs::File::open("/dev/urandom").is_err();
            println!("{} {} {} {}", wall > 1_700_000_000, slept >= 20, no_device, keyed);
        }
        _ => {
            eprintln!("unknown command {:?}", command);
            std::process::exit(2);
        }
    }
}
