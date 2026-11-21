// Optional conversion through the Claude API, used only when the user has entered an API key.

import Anthropic from "@anthropic-ai/sdk";
import { RecipeData } from "./recipe";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Models offered in the import dialog: best results first, cheapest last. */
export const CLAUDE_MODELS: [id: string, name: string][] = [
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
];

const INSTRUCTIONS = `You convert a recipe into a Cooklang recipe note for Obsidian (read by the Cooklang Editor plugin, which uses the cooklang-rs parser). Reply with the complete file and nothing else: no code fences, no commentary.

File layout:
---
recipe: true
title: "<recipe title>"
description: "<one or two sentences, only if the source has a description>"
servings: <number only>
time: <total minutes> minutes      (omit if unknown or clearly wrong)
source: <source URL>      (omit if there is none)
tags: [<tags>]
---

<steps>

Tags, lowercase, hyphens for spaces, only those that apply: the cuisine (italian, mexican, chinese, korean, japanese, thai, indian, french, spanish, greek, middle-eastern...), vegan or vegetarian (only when true; vegetarian only if not vegan), the main protein (chicken, beef, pork, shrimp, fish, tofu, tvp, lentils), and the method when it matters (slow-cooker, instant-pot, air-fryer). Plain desserts and baked goods may have no tags; never tag them vegetarian (vegan is fine). Don't tag american.

Body rules:
- Each step is one paragraph; blank line between steps. Keep the author's wording; drop ads, life stories, "jump to recipe" and similar junk.
- Ingredients: @name{qty%unit} written where the step uses the ingredient, replacing the plain words so the sentence still reads naturally ("Add @garlic{4%cloves}(thinly sliced) to the pan"). Use short, clean names. Prep notes go in parentheses right after the braces. Size words are notes, not units: @onions{2}(large). Units: tsp, tbsp, cup, g, kg, ml, l, oz, lb, cloves, pinch, can... Fractions 1/2, decimals 2.5 and ranges 2-3 are allowed. No amount: @salt{}. Optional: @?pine nuts{2%tbsp}. The same name and unit used twice is added up in the ingredient list.
- Every ingredient in the source list must be marked somewhere. If no step mentions it, work it naturally into the most fitting step.
- Do not mark cookware. Never write # in the body: Obsidian would read it as a tag.
- Timers: ~{10%minutes}, ~{10-14%minutes}, ~{2%hours} for cooking, baking, resting and marinating times in the text.
- Sections: a line "= Section name" before each part when the recipe has parts (dough, filling, sauce).
- Notes: lines starting with "> " for tips, yield ("> Makes 24 cookies.") and nutrition. Put them at the end, with a blank line between notes; back-to-back "> " lines merge into one note.
- Never put "--", "[-", or a stray @ or ~ in prose (write "No. 1", "about"). No Markdown headings, lists, bold or links in the body. A line starting with = is a section and > is a note.`;

/** Checks the key against the API (a free models lookup) and returns a message for the settings screen. */
export async function checkKey(apiKey: string, model: string): Promise<{ ok: boolean; message: string }> {
  if (!apiKey) return { ok: false, message: "No key entered." };
  if (!apiKey.startsWith("sk-ant-")) return { ok: false, message: "That doesn't look like an Anthropic API key (they start with sk-ant-)." };
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 });
  try {
    const m = await client.models.retrieve(model || DEFAULT_MODEL);
    return { ok: true, message: `Key works. ${m.display_name} is available.` };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, message: "The key was not accepted. Check it was copied in full, and that it hasn't been deleted." };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, message: "The key works but isn't allowed to use this model." };
    if (e instanceof Anthropic.NotFoundError) return { ok: false, message: "The key works, but this model isn't available to your account." };
    if (e instanceof Anthropic.RateLimitError) return { ok: true, message: "The key works, but you're being rate limited right now." };
    if (e instanceof Anthropic.APIConnectionError) return { ok: false, message: "Couldn't reach the Anthropic API. Check your internet connection." };
    if (e instanceof Anthropic.APIError) return { ok: false, message: `The API returned an error (${e.status}): ${e.message}` };
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Friendlier wording for errors during an import. */
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.APIUserAbortError) return "Import cancelled.";
  if (e instanceof Anthropic.AuthenticationError) return "Claude rejected the API key. Check it in CooklangPro's settings.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is rate limiting requests. Wait a minute and try again.";
  if (e instanceof Anthropic.BadRequestError && /credit|balance|billing/i.test(e.message)) return "Your Anthropic account is out of credits. Add some under Billing on platform.claude.com.";
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your internet connection.";
  if (e instanceof Anthropic.APIError) return `Claude returned an error (${e.status}): ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export interface ClaudeProgress {
  /** "thinking" until the first words of the answer arrive, then "writing". */
  phase: "thinking" | "writing";
  /** The answer so far. */
  text: string;
}

/** Claude's answer: the recipe note, and the folder it picked if it was asked. */
export interface ClaudeRecipe {
  markdown: string;
  folder: string | null;
}

export async function convertWithClaude(opts: {
  apiKey: string;
  model: string;
  recipe: RecipeData | null;
  url: string;
  pageText?: string;
  /** pageText is a recipe the user pasted, not a web page. */
  pasted?: boolean;
  /** The recipe folders to choose from; Claude names the best fit. */
  folders?: string[];
  onProgress?: (p: ClaudeProgress) => void;
  signal?: AbortSignal;
}): Promise<ClaudeRecipe> {
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
  const source = opts.pasted
    ? `The user pasted this recipe (there is no source URL, so leave out the source line):\n\n${opts.pageText ?? ""}`
    : opts.recipe
    ? `Source URL: ${opts.url}\n\nschema.org Recipe data from the page:\n${JSON.stringify(opts.recipe.raw, null, 1)}`
    : `Source URL: ${opts.url}\n\nThe page had no structured recipe data. Its text:\n${opts.pageText ?? ""}`;
  const folderAsk = opts.folders?.length
    ? `\n\nThe user's recipe folders: ${opts.folders.join(", ")}. After the recipe, add one last line "folder: <name>" with the folder this recipe fits best (by what kind of dish it is: a side dish goes in Sides even if it has vegetables and butter). It is removed before saving.`
    : "";

  // Streamed, so the import dialog can show how far along the conversion is.
  const stream = client.beta.messages.stream(
    {
      model: opts.model || DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: INSTRUCTIONS,
      messages: [{ role: "user", content: source + folderAsk }],
    },
    { signal: opts.signal },
  );
  opts.onProgress?.({ phase: "thinking", text: "" });
  stream.on("text", (_delta, snapshot) => opts.onProgress?.({ phase: "writing", text: snapshot }));
  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to convert this page.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's answer was cut off; try again.");
  }
  const text = response.content
    .map((b: any) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()
    .replace(/^```[a-z]*\n|\n```$/g, "");
  // The folder line, if asked for, comes last; take it off the note.
  const folderLine = /\n+folder:\s*(.+?)\s*$/i.exec(text);
  const folder = folderLine && opts.folders?.includes(folderLine[1]) ? folderLine[1] : null;
  const note = folderLine ? text.slice(0, folderLine.index).trimEnd() : text;
  if (!note.startsWith("---")) throw new Error("Claude's answer was not a recipe file.");
  return { markdown: note + "\n", folder };
}
