pragma circom 2.0.0;

// Multiplier — the demo circuit from the zkVerify docs.
// Proves knowledge of two private factors a, b whose product is the
// public output c (33 = 3 * 11). a and b stay private; only c is public.
template Multiplier() {
    signal input a;
    signal input b;
    signal output c;

    c <== a * b;
}

component main = Multiplier();
