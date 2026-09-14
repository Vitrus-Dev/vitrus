import { describe, expect, test } from "bun:test";
import { checkCausality, extractNumbers, guardProse } from "../src/insight/guard.ts";

const bundle = { allowedNumbers: [0, 3.2, 12, 12.3, 18, 100, 247, 1234] };

describe("extractNumbers", () => {
  test("reads percentages and decimals", () => {
    const toks = extractNumbers("The rate was 12.3% and 247 sessions were counted.");
    expect(toks.map((t) => t.candidates[0])).toEqual([12.3, 247]);
  });

  test("does not count evidence citations or dates as numbers", () => {
    expect(extractNumbers("Visitors rose [e1, e2] on 2026-09-12.")).toHaveLength(0);
  });

  test("does not count a digit that follows a letter (GPT-4, e12)", () => {
    expect(extractNumbers("GPT-4 and evidence e12")).toHaveLength(0);
  });

  test("produces both readings when grouping and decimal are ambiguous", () => {
    const [tok] = extractNumbers("1.234 visitors");
    expect(tok?.ambiguous).toBe(true);
    expect(tok?.candidates.sort()).toEqual([1.234, 1234]);
  });

  test("with two separators, the last one is the decimal", () => {
    expect(extractNumbers("1.234,5")[0]?.candidates).toEqual([1234.5]);
    expect(extractNumbers("1,234.5")[0]?.candidates).toEqual([1234.5]);
  });
});

describe("guardProse", () => {
  test("a sentence backed by evidence passes", () => {
    const r = guardProse("Visitors reached 247. The rate was 12.3%.", bundle);
    expect(r.ok).toBe(true);
    expect(r.kept).toHaveLength(2);
  });

  test("a sentence with an INVENTED number is DROPPED (fail-closed)", () => {
    const r = guardProse("Visitors reached 247. Conversion rose 41.7%.", bundle);
    expect(r.ok).toBe(false);
    expect(r.kept).toEqual(["Visitors reached 247."]);
    expect(r.dropped[0]?.numbers).toEqual(["41.7"]);
  });

  test("a sentence with no numbers is always allowed", () => {
    const r = guardProse("Search stands out among the traffic sources.", bundle);
    expect(r.ok).toBe(true);
  });

  test("0 and 100 are always free", () => {
    expect(guardProse("No signups at all: 0. The rate is 100%.", bundle).ok).toBe(true);
  });

  test("causal language is locked — a 'caused' sentence is dropped", () => {
    const r = guardProse("This commit caused the drop.", bundle, { strictCausality: true });
    expect(r.ok).toBe(false);
    expect(r.causalityViolations).toHaveLength(1);
  });

  test("'coincides with' language is allowed", () => {
    const r = guardProse("The drop coincides with the last deploy.", bundle, { strictCausality: true });
    expect(r.ok).toBe(true);
  });

  test("the causality lock only applies in a correlation context", () => {
    // "because of" does NOT drop a sentence when there is no commit/deploy context.
    expect(checkCausality("Traffic changed because of the campaign.")).toHaveLength(0);
    expect(checkCausality("Traffic changed because of the deploy.")).toHaveLength(1);
  });
});
