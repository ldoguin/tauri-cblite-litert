/**
 * text-stats skill — counts words, characters, sentences, and estimates reading time.
 */
import type { Tool } from "../tools";

export const textStatsTool: Tool = {
  id: "text_stats",
  name: "Text Statistics",
  description:
    "Analyses a block of text and returns word count, character count, sentence count, " +
    "paragraph count, unique word count, and estimated reading / speaking time.",
  requiresNetwork: false,
  params: [
    { name: "text", type: "string", description: "The text to analyse",                                        required: true  },
    { name: "wpm",  type: "number", description: "Reading speed in words per minute (default 200, silent reading)", required: false },
    { name: "spm",  type: "number", description: "Speaking speed in words per minute (default 130, average speech)", required: false },
  ],
  async run({ text, wpm, spm }) {
    if (typeof text !== "string" || !text) return "Error: text is required";
    const t = String(text);

    const words = t.trim() === "" ? [] : t.trim().split(/\s+/);
    const wordCount     = words.length;
    const charCount     = t.length;
    const charNoSpace   = t.replace(/\s/g, "").length;
    const sentenceCount = (t.match(/[^.!?]*[.!?]+/g) ?? []).length;
    const paraCount     = t.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
    const uniqueWords   = new Set(words.map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ""))).size;

    const readSpeed  = typeof wpm === "number" && wpm > 0 ? wpm : 200;
    const speakSpeed = typeof spm === "number" && spm > 0 ? spm : 130;

    function formatTime(seconds: number): string {
      const m = Math.floor(seconds / 60);
      const s = Math.ceil(seconds % 60);
      return m > 0 ? `${m} min ${s} sec` : `${s} sec`;
    }

    const readTime  = formatTime((wordCount / readSpeed)  * 60);
    const speakTime = formatTime((wordCount / speakSpeed) * 60);

    return [
      `Words:             ${wordCount.toLocaleString()}`,
      `Unique words:      ${uniqueWords.toLocaleString()}`,
      `Characters:        ${charCount.toLocaleString()}`,
      `Characters (no sp):${charNoSpace.toLocaleString()}`,
      `Sentences:         ${sentenceCount.toLocaleString()}`,
      `Paragraphs:        ${paraCount.toLocaleString()}`,
      ``,
      `Reading time:      ${readTime} (@ ${readSpeed} wpm)`,
      `Speaking time:     ${speakTime} (@ ${speakSpeed} wpm)`,
    ].join("\n");
  },
};
