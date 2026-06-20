#include <stdexcept>
#include <iostream>
int divide(int a, int b) {
    if (b == 0) throw std::runtime_error("divide by zero");
    return a / b;
}
int main() {
    for (int i = -2; i <= 2; i++) {
        try {
            std::cout << "divide(10, " << i << ") = " << divide(10, i) << std::endl;
        } catch (const std::exception& e) {
            std::cout << "caught: " << e.what() << std::endl;
        }
    }
    return 0;
}
