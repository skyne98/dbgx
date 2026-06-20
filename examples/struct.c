#include <pthread.h>
#include <stdio.h>

typedef struct {
    int x;
    int y;
    int data[4];
} Point;

int fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);   /* line 12 */
}

void *worker(void *arg) {
    long id = (long)arg;
    for (int i = 0; i < 3; i++) {
        /* spin */ ;
    }
    return NULL;
}

int main(int argc, char **argv) {
    Point p = { .x = 3, .y = 4, .data = {1, 2, 3, 4} };
    int f = fib(6);
    pthread_t t1, t2;
    pthread_create(&t1, NULL, worker, (void *)1L);
    pthread_create(&t2, NULL, worker, (void *)2L);
    pthread_join(t1, NULL);
    pthread_join(t2, NULL);
    printf("fib(6)=%d point=(%d,%d)\n", f, p.x, p.y);
    return 0;
}
