// Compile-time assertion helpers. A failed assertion is a tsc error, so type drift fails the build.

export type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;

// Mutual assignability, for pairs where Equal is too literal about how a type was written.
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type Expect<T extends true> = T;

export type KeysEqual<A, B> = Equal<keyof A, keyof B>;
