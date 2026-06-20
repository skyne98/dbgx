struct Point {
    x: i32,
    y: i32,
    data: [i32; 4],
}

fn fib(n: i32) -> i32 {
    if n < 2 {
        n
    } else {
        fib(n - 1) + fib(n - 2)   // line 10
    }
}

fn main() {
    let p = Point { x: 3, y: 4, data: [1, 2, 3, 4] };
    let f = fib(6);
    let s = format!("fib(6)={} point=({},{})", f, p.x, p.y);
    println!("{}", s);
}
