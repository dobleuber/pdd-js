import { arb, forAll, law } from "pdd";
// @ts-expect-error -- plain JS fixture without type declarations
import { double, offset } from "../src/m.js";

const n = arb.integer({ min: -1000, max: 1000 });

law("double is x + x", forAll(n, (x) => double(x) === x + x + offset));
law("double is even", forAll(n, (x) => double(x) % 2 === 0));
