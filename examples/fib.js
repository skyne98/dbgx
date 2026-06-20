function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}
const result = fib(7);
console.log("fib(7) =", result);
for (let i = 0; i < result; i++) {
  console.log(`iter ${i}`);
}
