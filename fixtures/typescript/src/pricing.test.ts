import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "./clamp.js";
import { discount } from "./pricing.ts";

test("large order gets discount", () => assert.equal(discount(200), 180));
test("small order pays full price", () => assert.equal(discount(50), 50));
test("clamp stays in range", () => assert.equal(clamp(15, 0, 10), 10));
