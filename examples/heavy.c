#include <stdio.h>
int main(void) {
    for (int i = 0; i < 200; i++) printf("line %03d: data=%d\n", i, i*i);
    fflush(stdout);
    return 0;
}
