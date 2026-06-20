// A deliberately complex Rust program to exercise dbgx:
//  - threads + channels
//  - trait objects + dynamic dispatch
//  - generics
//  - enums with data (pattern matching)
//  - iterators / closures
//  - error handling (Result / Option chaining)
//  - recursion with a memoization cache
//  - a shared mutable cache behind a Mutex

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

// ---- Trait + dynamic dispatch ----
trait Shape: Send + Sync {
    fn area(&self) -> f64;
    fn name(&self) -> &str;
}

struct Circle { radius: f64 }
struct Rectangle { w: f64, h: f64 }

impl Shape for Circle {
    fn area(&self) -> f64 { std::f64::consts::PI * self.radius * self.radius }
    fn name(&self) -> &str { "circle" }
}
impl Shape for Rectangle {
    fn area(&self) -> f64 { self.w * self.h }
    fn name(&self) -> &str { "rectangle" }
}

// ---- Generic ----
fn sum<T: Into<i64> + Copy>(items: &[T]) -> i64 {
    items.iter().map(|x| (*x).into()).fold(0i64, |acc, v| acc + v)
}

// ---- Enum with data ----
#[derive(Debug)]
enum TaskResult {
    Done { value: u64, duration_ms: u128 },
    Failed(String),
    Skipped,
}

// ---- Memoized recursive fib behind a Mutex ----
struct Cache {
    memo: Mutex<HashMap<u64, u64>>,
}

impl Cache {
    fn new() -> Self { Cache { memo: Mutex::new(HashMap::from([(0, 0), (1, 1)])) } }

    fn fib(&self, n: u64) -> u64 {
        // fast path: already cached
        if let Some(v) = self.memo.lock().unwrap().get(&n).copied() {
            return v;
        }
        let v = self.fib(n - 1) + self.fib(n - 2); // recursion
        self.memo.lock().unwrap().insert(n, v);
        v
    }
}

// ---- Worker over a shared (locked) channel ----
fn worker(id: usize, rx: Arc<Mutex<mpsc::Receiver<u64>>>, cache: Arc<Cache>, tx: mpsc::Sender<TaskResult>) {
    loop {
        let next = rx.lock().unwrap().recv();
        let Ok(n) = next else { break }; // sender dropped → done
        if n > 92 {
            let _ = tx.send(TaskResult::Failed(format!("n={} too large", n)));
            continue;
        }
        let start = std::time::Instant::now();
        let value = cache.fib(n);
        let elapsed = start.elapsed().as_millis();
        let _ = tx.send(TaskResult::Done { value, duration_ms: elapsed });
    }
}

// ---- Option/Result chaining ----
fn parse_pair(line: &str) -> Option<(i32, i32)> {
    let mut it = line.split(',');
    let a = it.next()?.trim().parse().ok()?;
    let b = it.next()?.trim().parse().ok()?;
    Some((a, b))
}

fn main() {
    // 1. shapes (trait objects)
    let shapes: Vec<Box<dyn Shape>> = vec![
        Box::new(Circle { radius: 2.0 }),
        Box::new(Rectangle { w: 3.0, h: 4.0 }),
    ];
    let total_area: f64 = shapes.iter().map(|s| s.area()).sum();

    // 2. generic sum
    let nums: Vec<i32> = (1..=10).collect();
    let s = sum(&nums);

    // 3. memoized fib (single-threaded first)
    let cache = Arc::new(Cache::new());
    let fib_20 = cache.fib(20);

    // 4. spawn worker pool + channels
    let (work_tx, work_rx) = mpsc::channel::<u64>();
    let work_rx = Arc::new(Mutex::new(work_rx));
    let (result_tx, result_rx) = mpsc::channel::<TaskResult>();

    let mut handles = vec![];
    for id in 0..4 {
        let rx = Arc::clone(&work_rx);
        let cache = Arc::clone(&cache);
        let tx = result_tx.clone();
        let h = thread::spawn(move || worker(id, rx, cache, tx));
        handles.push(h);
    }
    drop(result_tx); // close so result_rx ends when workers finish

    // hand out work
    for n in [5u64, 10, 15, 20, 25, 30, 35, 40] {
        work_tx.send(n).unwrap();
        thread::sleep(Duration::from_millis(5));
    }
    drop(work_tx);

    // collect results
    let mut results: Vec<TaskResult> = result_rx.iter().collect();

    // 5. option chaining
    let pairs: Vec<(i32, i32)> = ["1,2", "3,4", "x,y", "5,6"]
        .iter()
        .filter_map(|l| parse_pair(l))
        .collect();
    let pair_sum: i32 = pairs.iter().map(|(a, b)| a + b).sum();

    // 6. sorting the results by value
    results.sort_by_key(|r| match r {
        TaskResult::Done { value, .. } => *value,
        _ => 0,
    });

    // 7. closure capturing the cache
    let fib_cached = |n: u64| cache.fib(n);
    let fib_25 = fib_cached(25);

    println!("total_area={}", total_area);
    println!("sum(1..=10)={}", s);
    println!("fib(20)={}", fib_20);
    println!("fib(25)={}", fib_25);
    println!("pairs={:?} pair_sum={}", pairs, pair_sum);
    println!("results: {} tasks completed", results.len());
    for (i, r) in results.iter().enumerate() {
        println!("  [{}] {:?}", i, r);
    }

    // wait for threads
    for h in handles {
        let _ = h.join();
    }
}
