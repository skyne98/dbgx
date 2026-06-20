#include <stdio.h>
#include <stdlib.h>

long fib(long n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
}

int main(int argc, char **argv) {
    long n = (argc > 1) ? atol(argv[1]) : 10;
    long r = fib(n);
    printf("fib(%ld) = %ld\n", n, r);
    return 0;
}
