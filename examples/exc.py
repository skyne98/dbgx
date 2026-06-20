def risky(x):
    if x < 0:
        raise ValueError(f"negative value: {x}")  # line 3
    if x == 0:
        raise ZeroDivisionError("zero not allowed")  # line 5
    return 100 // x

def main():
    for v in [10, 5, 0, -3, 2]:  # line 10
        try:
            print(f"risky({v}) = {risky(v)}")
        except Exception as e:
            print(f"caught: {e}")

if __name__ == "__main__":
    main()
