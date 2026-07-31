export const WEB_DESTINATION_SCHEMA = "crowflix-web-destinations";
export const WEB_DESTINATION_VERSION = 1;
export const WEB_DESTINATION_STORAGE_KEY = "crowflix:web-destinations:v1";

export const MAX_WEB_DESTINATION_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_WEB_DESTINATIONS = 1_000;
export const MAX_WEB_DESTINATION_CATEGORIES = 12;
export const MAX_WEB_LIBRARY_CATEGORIES = 200;
const MAX_URL_LENGTH = 8_192;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type WebDestination = {
  id: string;
  title: string;
  url: string;
  category: string;
  categories?: string[];
  artwork?: string;
  note?: string;
  sourceDirectory?: string;
  sourcePage?: string;
};

export type WebDestinationDraft = Omit<WebDestination, "id"> & {
  id?: string;
};

export type WebDestinationLoadResult = {
  items: WebDestination[];
  error?: string;
};

type WebDestinationEnvelope = {
  schema: typeof WEB_DESTINATION_SCHEMA;
  version: typeof WEB_DESTINATION_VERSION;
  items: WebDestination[];
};

const directorySeedDrafts: WebDestinationDraft[] = [
  {
    title: "YarrList Movies & TV",
    url: "https://yarrlist.net/movies-and-tv-shows",
    category: "Movies & TV",
    note: "Website directory",
    sourceDirectory: "YarrList",
    sourcePage: "https://github.com/yarrlist/YarrList",
  },
  {
    title: "YarrList Anime",
    url: "https://yarrlist.net/anime-list",
    category: "Anime",
    note: "Website directory",
    sourceDirectory: "YarrList",
    sourcePage: "https://github.com/yarrlist/YarrList",
  },
  {
    title: "YarrList Live Sports",
    url: "https://yarrlist.net/sports-live-streaming",
    category: "Live Sports",
    note: "Website directory",
    sourceDirectory: "YarrList",
    sourcePage: "https://github.com/yarrlist/YarrList",
  },
  {
    title: "YarrList Live TV",
    url: "https://yarrlist.net/live-tv-list",
    category: "Live TV",
    note: "Website directory",
    sourceDirectory: "YarrList",
    sourcePage: "https://github.com/yarrlist/YarrList",
  },
  {
    title: "AhoyList Movies & TV",
    url: "https://ahoylist.net/movies-and-tv-shows",
    category: "Movies & TV",
    note: "Alternative website directory",
    sourceDirectory: "AhoyList",
    sourcePage: "https://github.com/yarrlist/AhoyList",
  },
  {
    title: "AhoyList Anime",
    url: "https://ahoylist.net/anime-list",
    category: "Anime",
    note: "Alternative website directory",
    sourceDirectory: "AhoyList",
    sourcePage: "https://github.com/yarrlist/AhoyList",
  },
  {
    title: "AhoyList Live Sports",
    url: "https://ahoylist.net/live-sports",
    category: "Live Sports",
    note: "Alternative website directory",
    sourceDirectory: "AhoyList",
    sourcePage: "https://github.com/yarrlist/AhoyList",
  },
  {
    title: "AhoyList Live TV",
    url: "https://ahoylist.net/live-tv-list",
    category: "Live TV",
    note: "Alternative website directory",
    sourceDirectory: "AhoyList",
    sourcePage: "https://github.com/yarrlist/AhoyList",
  },
];

// These are links to the directory pages themselves. CrowFlix does not copy or
// redistribute the unlicensed provider lists published on those pages.
const seedDrafts: WebDestinationDraft[] = directorySeedDrafts;

export const DEFAULT_WEB_DESTINATIONS = mergeWebDestinations(
  [],
  seedDrafts.map((item) => normalizeWebDestination(item)),
);

export function normalizeExternalHttpUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error("Enter a complete HTTP or HTTPS website address.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Enter a complete HTTP or HTTPS website address.");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("Only normal HTTP and HTTPS website addresses are supported.");
  }

  return parsed.href;
}

export function normalizeWebDestination(value: unknown): WebDestination {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Each website entry must be an object.");
  }

  const draft = value as Record<string, unknown>;
  const title = normalizeRequiredText(draft.title, "Website title", 160);
  const url = normalizeExternalHttpUrl(normalizeUrlInput(draft.url));
  const category = normalizeOptionalText(draft.category, 80) || "Other";
  let additionalCategories: string[] = [];
  if (draft.categories !== undefined) {
    if (!Array.isArray(draft.categories)) {
      throw new Error("Website categories must be a list of text values.");
    }
    if (draft.categories.length > MAX_WEB_DESTINATION_CATEGORIES) {
      throw new Error(
        `A website can have at most ${MAX_WEB_DESTINATION_CATEGORIES} categories.`,
      );
    }
    additionalCategories = draft.categories
      .map((item) => normalizeOptionalText(item, 80))
      .filter((item): item is string => Boolean(item));
  }
  const categories = [...new Set([category, ...additionalCategories])];
  if (categories.length > MAX_WEB_DESTINATION_CATEGORIES) {
    throw new Error(
      `A website can have at most ${MAX_WEB_DESTINATION_CATEGORIES} categories.`,
    );
  }
  const artworkInput = normalizeOptionalText(draft.artwork, MAX_URL_LENGTH);
  const note = normalizeOptionalText(draft.note, 500);
  const sourceDirectory = normalizeOptionalText(draft.sourceDirectory, 120);
  const sourcePageInput = normalizeOptionalText(draft.sourcePage, MAX_URL_LENGTH);

  return {
    // The canonical URL is the operation identity. Unlike a short hash, it
    // cannot collide with another destination and remove or edit the wrong one.
    id: url,
    title,
    url,
    category,
    categories,
    ...(artworkInput
      ? { artwork: normalizeExternalHttpUrl(artworkInput) }
      : {}),
    ...(note ? { note } : {}),
    ...(sourceDirectory ? { sourceDirectory } : {}),
    ...(sourcePageInput
      ? { sourcePage: normalizeExternalHttpUrl(sourcePageInput) }
      : {}),
  };
}

export function parseWebDestinationImport(text: string): WebDestination[] {
  if (
    new TextEncoder().encode(text).byteLength >
    MAX_WEB_DESTINATION_IMPORT_BYTES
  ) {
    throw new Error("That website backup is larger than 2 MB.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }

  let items: unknown;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === "object") {
    const envelope = parsed as Record<string, unknown>;
    if (envelope.schema !== WEB_DESTINATION_SCHEMA) {
      throw new Error("That file is not a CrowFlix website backup.");
    }
    if (envelope.version !== WEB_DESTINATION_VERSION) {
      throw new Error("That CrowFlix website backup version is not supported.");
    }
    items = envelope.items;
  }

  if (!Array.isArray(items)) {
    throw new Error("That website backup does not contain a list of entries.");
  }
  if (items.length > MAX_WEB_DESTINATIONS) {
    throw new Error(
      `A website backup can contain at most ${MAX_WEB_DESTINATIONS} entries.`,
    );
  }

  const normalized = normalizeWebDestinationCollection(items, true);
  // Canonicalization adds the normalized ID/category fields. Confirm that
  // canonical form remains within every save/load invariant too.
  serializeWebDestinations(normalized);
  return normalized;
}

export function mergeWebDestinations(
  existing: readonly WebDestination[],
  incoming: readonly WebDestination[],
): WebDestination[] {
  const merged = normalizeWebDestinationCollection(
    [...existing, ...incoming],
    true,
  );
  // Enforce the same byte ceiling used when this library is loaded again.
  // This prevents accepting in-memory state that cannot survive a restart.
  serializeWebDestinations(merged);
  return merged;
}

export function upsertWebDestination(
  existing: readonly WebDestination[],
  item: WebDestination,
  previousId?: string,
): WebDestination[] {
  const normalized = normalizeWebDestination(item);
  const withoutPrevious = previousId
    ? existing.filter((entry) => entry.id !== previousId)
    : [...existing];

  if (withoutPrevious.some((entry) => entry.url === normalized.url)) {
    throw new Error("That website is already in the Web Library.");
  }

  return mergeWebDestinations(withoutPrevious, [normalized]);
}

export function serializeWebDestinations(
  items: readonly WebDestination[],
): string {
  const normalizedItems = normalizeWebDestinationCollection(items, false);
  const envelope: WebDestinationEnvelope = {
    schema: WEB_DESTINATION_SCHEMA,
    version: WEB_DESTINATION_VERSION,
    items: normalizedItems,
  };
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_WEB_DESTINATION_IMPORT_BYTES
  ) {
    throw new Error("The Web Library backup would be larger than 2 MB.");
  }
  return serialized;
}

export function loadWebDestinations(
  storage: Pick<Storage, "getItem">,
  fallback: readonly WebDestination[] = DEFAULT_WEB_DESTINATIONS,
): WebDestinationLoadResult {
  const raw = storage.getItem(WEB_DESTINATION_STORAGE_KEY);
  if (raw === null) return { items: [...fallback] };

  try {
    return { items: parseWebDestinationImport(raw) };
  } catch (error) {
    return {
      items: [...fallback],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function saveWebDestinations(
  storage: Pick<Storage, "setItem">,
  items: readonly WebDestination[],
): string | null {
  try {
    storage.setItem(
      WEB_DESTINATION_STORAGE_KEY,
      serializeWebDestinations(items),
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function filterWebDestinations(
  items: readonly WebDestination[],
  query: string,
  category = "all",
): WebDestination[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const categories = item.categories?.length
      ? item.categories
      : [item.category];
    if (category !== "all" && !categories.includes(category)) return false;
    if (!needle) return true;
    const hostname = new URL(item.url).hostname;
    return [
      item.title,
      item.category,
      ...categories,
      item.note,
      item.sourceDirectory,
      hostname,
    ].some((value) => value?.toLocaleLowerCase().includes(needle));
  });
}

export function webDestinationHostname(item: WebDestination): string {
  return new URL(item.url).hostname.replace(/^www\./i, "");
}

export function approvedWebDestinationArtwork(
  item: WebDestination,
  approvalKeys: ReadonlySet<string>,
): string | undefined {
  const key = webDestinationArtworkApprovalKey(item);
  return key && approvalKeys.has(key) ? item.artwork : undefined;
}

export function webDestinationArtworkApprovalKey(
  item: WebDestination,
): string | undefined {
  return item.artwork ? `${item.id}\n${item.artwork}` : undefined;
}

function normalizeWebDestinationCollection(
  items: readonly unknown[],
  deduplicate: boolean,
): WebDestination[] {
  const normalizedItems: WebDestination[] = [];
  const seenUrls = new Set<string>();
  const categories = new Set<string>();

  for (const [index, item] of items.entries()) {
    let normalized: WebDestination;
    try {
      normalized = normalizeWebDestination(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Website entry ${index + 1}: ${message}`);
    }

    if (seenUrls.has(normalized.url)) {
      if (deduplicate) continue;
      throw new Error(`Website entry ${index + 1}: duplicate website URL.`);
    }
    if (normalizedItems.length >= MAX_WEB_DESTINATIONS) {
      throw new Error(
        `The Web Library can contain at most ${MAX_WEB_DESTINATIONS} destinations.`,
      );
    }

    for (const category of normalized.categories?.length
      ? normalized.categories
      : [normalized.category]) {
      categories.add(category);
      if (categories.size > MAX_WEB_LIBRARY_CATEGORIES) {
        throw new Error(
          `The Web Library can contain at most ${MAX_WEB_LIBRARY_CATEGORIES} categories.`,
        );
      }
    }

    seenUrls.add(normalized.url);
    normalizedItems.push(normalized);
  }

  return normalizedItems;
}

function normalizeRequiredText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const normalized = normalizeOptionalText(value, maximum);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Website text fields must be text.");
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (CONTROL_CHARACTER.test(normalized) || normalized.length > maximum) {
    throw new Error("A website text field is invalid or too long.");
  }
  return normalized;
}

function normalizeUrlInput(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}
