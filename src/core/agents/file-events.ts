import { FILE_EXTENSIONS_REGEX, FILE_TAG_REGEX } from "@/core/config";
import type { UnifiedEvent } from "@/core/types";

/** Yield `file` events for [FILE:...] tags and bare extension-matched paths in `text`. */
export function* extractFileEvents(text: string, source: string): Generator<UnifiedEvent> {
  const tagRegex = new RegExp(FILE_TAG_REGEX.source, "gi");
  let match: RegExpExecArray | null = tagRegex.exec(text);
  while (match !== null) {
    yield { type: "file", path: match[1], source, origin: "tag" };
    match = tagRegex.exec(text);
  }

  const pathRegex = new RegExp(FILE_EXTENSIONS_REGEX.source, "gi");
  const pathMatches = text.match(pathRegex);
  if (pathMatches) {
    for (const p of [...new Set(pathMatches)]) {
      yield { type: "file", path: p, source, origin: "extension" };
    }
  }
}
