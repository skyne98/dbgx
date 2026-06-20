#include <stdio.h>
#include <unistd.h>
int main(void) {
    for (int i = 0; i < 1000; i++) {
        printf("tick %d\n", i);
        fflush(stdout);
        sleep(1);
    }
    return 0;
}
