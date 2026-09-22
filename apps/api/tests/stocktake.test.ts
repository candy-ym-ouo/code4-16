import { describe, expect, it } from "vitest";
import {
  computeVariance,
  stocktakeCountSchema,
  stocktakeCreateSchema,
  stocktakeSubmitSchema
} from "@handcraft/contracts";

describe("stocktake variance reconciliation", () => {
  it("flags a gain when counted exceeds book", () => {
    expect(computeVariance("100.000000", "130.5")).toEqual({ direction: "GAIN", variance: "30.500000" });
  });

  it("flags a loss when counted is below book", () => {
    expect(computeVariance("100.000000", "80")).toEqual({ direction: "LOSS", variance: "20.000000" });
  });

  it("treats equal values as a match", () => {
    expect(computeVariance("100.000000", "100.0")).toEqual({ direction: "MATCH", variance: "0.000000" });
  });

  it("uses six-decimal precision for tiny variances", () => {
    expect(computeVariance("1.000001", "1.000000")).toEqual({ direction: "LOSS", variance: "0.000001" });
  });
});

describe("stocktake input contracts", () => {
  it("accepts a create payload", () => {
    const parsed = stocktakeCreateSchema.parse({ locationId: "00000000-0000-0000-0000-000000000001" });
    expect(parsed.locationId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("rejects a count batch with duplicated batches", () => {
    const result = stocktakeCountSchema.safeParse({
      version: 1,
      items: [
        { batchId: "00000000-0000-0000-0000-000000000001", countedQuantity: "10" },
        { batchId: "00000000-0000-0000-0000-000000000001", countedQuantity: "12" }
      ]
    });
    expect(result.success).toBe(false);
  });

  it("accepts zero as a counted quantity but rejects negatives", () => {
    expect(stocktakeCountSchema.safeParse({ version: 1, items: [{ batchId: "00000000-0000-0000-0000-000000000001", countedQuantity: "0" }] }).success).toBe(true);
    expect(stocktakeCountSchema.safeParse({ version: 1, items: [{ batchId: "00000000-0000-0000-0000-000000000001", countedQuantity: "-1" }] }).success).toBe(false);
  });

  it("requires a positive version for submit", () => {
    expect(stocktakeSubmitSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(stocktakeSubmitSchema.safeParse({ version: 3 }).success).toBe(true);
  });
});
