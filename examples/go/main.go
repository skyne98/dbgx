package main

import "fmt"

func fib(n int) int {
	if n <= 1 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

func main() {
	for i := 0; i <= 5; i++ {
		result := fib(i)
		fmt.Printf("fib(%d) = %d\n", i, result)
	}
}
