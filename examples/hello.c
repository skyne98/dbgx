#include <stdio.h>

int sum(int n) {
    int total = 0;
    for (int i = 1; i <= n; i++) {
        total += i;            /* breakpoint here */
    }
    return total;
}

int main(int argc, char **argv) {
    int n = 10;
    int result = sum(n);
    printf("sum(1..%d) = %d\n", n, result);
    return 0;
}
