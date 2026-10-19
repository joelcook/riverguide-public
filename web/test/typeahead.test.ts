// The typeahead's matching, on a small dictionary and on the one built from the College's pages.
import { describe, expect, test } from "bun:test";
import { createTypeahead } from "../app/typeahead";
import { collegeQuestions } from "../scripts/college";

describe("matching", () => {
  const suggest = createTypeahead([
    { text: "How do I renew my passport?", prior: 0.5 },
    { text: "How do I register to vote?", prior: 0.4 },
    { text: "How do I renew my passport by mail?", prior: 0.3 },
    { text: "How long does it take to get a passport?", prior: 0.2 },
    { text: "Is ENC 1101 (English Composition I) offered online?", prior: 0.1, slot: [1, 6] },
  ]);
  const texts = (text: string) => suggest(text).map((s) => s.text);

  test("completes a question from its start, likeliest first, with different next words first", () => {
    expect(texts("how do i re")).toEqual(["How do I renew my passport?", "How do I register to vote?", "How do I renew my passport by mail?"]);
    expect(suggest("how do i reg")).toEqual([{ text: "How do I register to vote?", typed: [0, 12] }]);
  });

  test("forgives typos, and never offers a question that adds nothing", () => {
    expect(texts("how do i renw my pasport")).toEqual(["How do I renew my passport by mail?"]);
  });

  test("matches from any word once three letters are typed", () => {
    expect(texts("pa")).toEqual([]);
    expect(texts("passport")).toEqual(["How do I renew my passport?", "How do I renew my passport by mail?", "How long does it take to get a passport?"]);
    expect(suggest("passport")[2].typed).toEqual([31, 39]);
  });

  test("offers a course only once its code or title is typed", () => {
    expect(texts("is")).toEqual([]);
    expect(texts("is enc")).toEqual(["Is ENC 1101 (English Composition I) offered online?"]);
    expect(texts("english comp")).toEqual(["Is ENC 1101 (English Composition I) offered online?"]);
  });

  test("leaves numbers and finished questions alone", () => {
    expect(texts("my student id is 123456")).toEqual([]);
    expect(texts("How do I register to vote?")).toEqual([]);
  });
});

describe("the dictionary from the College's pages", async () => {
  const suggest = createTypeahead(await collegeQuestions());
  const texts = (text: string) => suggest(text).map((s) => s.text);

  test("knows the College's FAQs, its courses, and what students ask most", () => {
    expect(texts("where do i")).toContain("Where do I register for classes?");
    expect(texts("how many credits is enc 110")[0]).toBe("How many credits is ENC 1101 (English Composition I)?");
    expect(texts("trnscript")).toEqual(["How do I get my transcript?"]);
  });

  test("keeps up with typing", () => {
    const keystrokes = [..."how do i get my transcript"].map((_, i, all) => all.slice(0, i + 1).join(""));
    const start = performance.now();
    for (const text of keystrokes) suggest(text);
    expect((performance.now() - start) / keystrokes.length).toBeLessThan(5);
  });
});
