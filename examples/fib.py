import sys
import os

class Counter:
    def __init__(self, start=0):
        self.count = start
        self.history = []
    def bump(self):
        self.count += 1
        self.history.append(self.count)
        return self.count

def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)  # line 14

def main():
    name = os.environ.get("DBGX_NAME", "world")
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    c = Counter()
    c.bump()
    c.bump()
    result = fib(n)
    print(f"hello {name}: fib({n}) = {result}, counter = {c.count}")
    return result

if __name__ == "__main__":
    main()
