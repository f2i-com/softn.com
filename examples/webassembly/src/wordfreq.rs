// A command-line program for softn.wasm.run, built for WASI: it reads text
// on stdin, prints the most used words, says how many there were on stderr,
// and writes every word's count to report.csv.
//
// rustc --target wasm32-wasip1 -C opt-level=z -C panic=abort wordfreq.rs

use std::collections::HashMap;
use std::io::Read;

fn main() {
    let top: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(10);
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("stdin is text");

    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut total = 0;
    for word in text.split(|c: char| !c.is_alphanumeric() && c != '\'').filter(|w| !w.trim_matches('\'').is_empty()) {
        *counts.entry(word.trim_matches('\'').to_lowercase()).or_insert(0) += 1;
        total += 1;
    }

    let mut list: Vec<(String, usize)> = counts.into_iter().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let width = list.iter().take(top).map(|(w, _)| w.chars().count()).max().unwrap_or(0);
    for (word, count) in list.iter().take(top) {
        println!("{:<width$}  {}", word, count, width = width);
    }
    eprintln!("{} words, {} different", total, list.len());

    let mut csv = String::from("word,count\n");
    for (word, count) in &list {
        csv.push_str(word);
        csv.push(',');
        csv.push_str(&count.to_string());
        csv.push('\n');
    }
    std::fs::write("report.csv", csv).expect("report.csv is written");
}
