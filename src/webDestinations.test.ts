import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_DESTINATIONS,
  MAX_WEB_DESTINATIONS,
  WEB_DESTINATION_SCHEMA,
  WEB_DESTINATION_STORAGE_KEY,
  WEB_DESTINATION_VERSION,
  approvedWebDestinationArtwork,
  filterWebDestinations,
  loadWebDestinations,
  mergeWebDestinations,
  normalizeExternalHttpUrl,
  normalizeWebDestination,
  parseWebDestinationImport,
  saveWebDestinations,
  serializeWebDestinations,
  upsertWebDestination,
  webDestinationArtworkApprovalKey,
} from "./webDestinations";

describe("web destination URLs", () => {
  it.each([
    ["https://example.com", "https://example.com/"],
    [
      "https://example.com/watch?q=one#now",
      "https://example.com/watch?q=one#now",
    ],
    ["http://example.com:8080/live", "http://example.com:8080/live"],
  ])("accepts and canonicalizes %s", (input, expected) => {
    expect(normalizeExternalHttpUrl(input)).toBe(expected);
  });

  it.each([
    "",
    " https://example.com",
    "https://example.com\n",
    "https://",
    "//example.com/watch",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///C:/Windows",
    "ftp://example.com/file",
    "mailto:test@example.com",
    "https://user:password@example.com/",
  ])("rejects %s", (input) => {
    expect(() => normalizeExternalHttpUrl(input)).toThrow();
  });

  it("validates optional artwork and source-page URLs", () => {
    expect(() =>
      normalizeWebDestination({
        title: "Example",
        url: "https://example.com",
        artwork: "file:///C:/secret.png",
      }),
    ).toThrow();
    expect(() =>
      normalizeWebDestination({
        title: "Example",
        url: "https://example.com",
        sourcePage: "javascript:alert(1)",
      }),
    ).toThrow();
  });

  it("keeps imported remote artwork dormant until explicitly approved", () => {
    const item = normalizeWebDestination({
      title: "Example",
      url: "https://example.com",
      artwork: "https://images.example.com/poster.jpg",
    });

    const approvalKey = webDestinationArtworkApprovalKey(item);
    expect(approvalKey).toBeTruthy();
    expect(approvedWebDestinationArtwork(item, new Set())).toBeUndefined();
    expect(approvedWebDestinationArtwork(item, new Set([approvalKey!]))).toBe(
      "https://images.example.com/poster.jpg",
    );

    const changedArtwork = normalizeWebDestination({
      ...item,
      artwork: "https://other-images.example.com/poster.jpg",
    });
    expect(
      approvedWebDestinationArtwork(changedArtwork, new Set([approvalKey!])),
    ).toBeUndefined();
  });
});

describe("web destination backup format", () => {
  it("round-trips the versioned CrowFlix envelope", () => {
    const serialized = serializeWebDestinations(DEFAULT_WEB_DESTINATIONS);
    const parsed = parseWebDestinationImport(serialized);

    expect(parsed).toEqual(DEFAULT_WEB_DESTINATIONS);
    expect(JSON.parse(serialized)).toMatchObject({
      schema: WEB_DESTINATION_SCHEMA,
      version: WEB_DESTINATION_VERSION,
    });
  });

  it("accepts a bare array for simple imports", () => {
    expect(
      parseWebDestinationImport(
        JSON.stringify([
          {
            title: "Example",
            url: "https://example.com",
            category: "Movies",
          },
        ]),
      ),
    ).toEqual([
      expect.objectContaining({
        title: "Example",
        url: "https://example.com/",
        category: "Movies",
      }),
    ]);
  });

  it("rejects malformed and unsupported backups", () => {
    expect(() => parseWebDestinationImport("{")).toThrow("valid JSON");
    expect(() =>
      parseWebDestinationImport(
        JSON.stringify({
          schema: WEB_DESTINATION_SCHEMA,
          version: 99,
          items: [],
        }),
      ),
    ).toThrow("version");
    expect(() =>
      parseWebDestinationImport(
        JSON.stringify({ schema: "another-app", version: 1, items: [] }),
      ),
    ).toThrow("CrowFlix");
  });

  it("reports the exact invalid imported entry", () => {
    expect(() =>
      parseWebDestinationImport(
        JSON.stringify([
          { title: "Good", url: "https://example.com" },
          { title: "Bad", url: "file:///C:/Windows" },
        ]),
      ),
    ).toThrow("Website entry 2");
  });

  it("bounds per-entry and total category counts before rendering", () => {
    expect(() =>
      normalizeWebDestination({
        title: "Too many categories",
        url: "https://categories.example/",
        categories: Array.from(
          { length: 13 },
          (_, index) => `Category ${index}`,
        ),
      }),
    ).toThrow("at most 12");

    const categoryHeavy = Array.from({ length: 17 }, (_, entryIndex) =>
      normalizeWebDestination({
        title: `Website ${entryIndex}`,
        url: `https://categories-${entryIndex}.example/`,
        category: `Category ${entryIndex}-0`,
        categories: Array.from(
          { length: 11 },
          (_, categoryIndex) =>
            `Category ${entryIndex}-${categoryIndex + 1}`,
        ),
      }),
    );
    expect(() => mergeWebDestinations([], categoryHeavy)).toThrow(
      "at most 200 categories",
    );
    expect(() => serializeWebDestinations(categoryHeavy)).toThrow(
      "at most 200 categories",
    );
    expect(() =>
      parseWebDestinationImport(JSON.stringify(categoryHeavy)),
    ).toThrow("at most 200 categories");
  });

  it("deduplicates imported URLs before they can become render keys", () => {
    const duplicate = {
      title: "Example",
      url: "https://duplicate.example/",
      category: "Movies",
    };
    expect(
      parseWebDestinationImport(JSON.stringify([
        duplicate,
        { ...duplicate, title: "Duplicate label" },
      ])),
    ).toHaveLength(1);
  });
});

describe("web destination library behavior", () => {
  it("merges without replacing existing metadata and deduplicates by URL", () => {
    const existing = [
      normalizeWebDestination({
        title: "My title",
        url: "https://example.com",
        category: "Saved",
      }),
    ];
    const incoming = [
      normalizeWebDestination({
        title: "Imported title",
        url: "https://example.com/",
        category: "Import",
      }),
      normalizeWebDestination({
        title: "New site",
        url: "https://new.example.com",
        category: "Import",
      }),
    ];

    expect(mergeWebDestinations(existing, incoming)).toEqual([
      existing[0],
      incoming[1],
    ]);
  });

  it("uses the collision-free canonical URL as the entry identity", () => {
    const first = normalizeWebDestination({
      title: "First",
      url: "https://example.com/first",
    });
    const second = normalizeWebDestination({
      title: "Second",
      url: "https://example.com/second",
    });

    expect(first.id).toBe(first.url);
    expect(second.id).toBe(second.url);
    expect(first.id).not.toBe(second.id);
  });

  it("rejects duplicate adds and edits without removing either entry", () => {
    const first = normalizeWebDestination({
      title: "First",
      url: "https://example.com/first",
    });
    const second = normalizeWebDestination({
      title: "Second",
      url: "https://example.com/second",
    });

    expect(() => upsertWebDestination([first, second], first)).toThrow(
      "already",
    );
    expect(() =>
      upsertWebDestination(
        [first, second],
        normalizeWebDestination({
          title: "First renamed",
          url: second.url,
        }),
        first.id,
      ),
    ).toThrow("already");
  });

  it("enforces the same maximum across merge, save, and reload", () => {
    const maximumLibrary = Array.from(
      { length: MAX_WEB_DESTINATIONS },
      (_, index) =>
        normalizeWebDestination({
          title: `Website ${index}`,
          url: `https://site-${index}.example/`,
        }),
    );

    const backup = serializeWebDestinations(maximumLibrary);
    expect(parseWebDestinationImport(backup)).toHaveLength(
      MAX_WEB_DESTINATIONS,
    );
    expect(() =>
      mergeWebDestinations(DEFAULT_WEB_DESTINATIONS, maximumLibrary),
    ).toThrow("at most");
    expect(() =>
      serializeWebDestinations([
        ...maximumLibrary,
        normalizeWebDestination({
          title: "One too many",
          url: "https://overflow.example/",
        }),
      ]),
    ).toThrow("at most");
  });

  it("rejects a library too large to reload before replacing saved data", () => {
    const longPath = "a".repeat(8_000);
    const oversized = Array.from({ length: 150 }, (_, index) =>
      normalizeWebDestination({
        title: `Large website ${index}`,
        url: `https://site-${index}.example/${longPath}`,
        artwork: `https://images-${index}.example/${longPath}`,
      }),
    );
    let storedValue = "last known good backup";

    const error = saveWebDestinations(
      {
        setItem: (_key, value) => {
          storedValue = value;
        },
      },
      oversized,
    );

    expect(error).toContain("larger than 2 MB");
    expect(storedValue).toBe("last known good backup");
    expect(() => mergeWebDestinations([], oversized)).toThrow(
      "larger than 2 MB",
    );
  });

  it("searches titles, categories, directory names, and hostnames", () => {
    expect(DEFAULT_WEB_DESTINATIONS).toHaveLength(8);
    expect(
      new Set(DEFAULT_WEB_DESTINATIONS.map((item) => item.url)).size,
    ).toBe(DEFAULT_WEB_DESTINATIONS.length);
    expect(
      parseWebDestinationImport(
        serializeWebDestinations(DEFAULT_WEB_DESTINATIONS),
      ),
    ).toEqual(DEFAULT_WEB_DESTINATIONS);
    expect(
      filterWebDestinations(DEFAULT_WEB_DESTINATIONS, "ahoylist"),
    ).toHaveLength(4);
    expect(
      filterWebDestinations(DEFAULT_WEB_DESTINATIONS, "", "Live TV"),
    ).toHaveLength(2);
    expect(
      filterWebDestinations(DEFAULT_WEB_DESTINATIONS, "", "Live Sports"),
    ).toHaveLength(2);
    expect(
      filterWebDestinations(DEFAULT_WEB_DESTINATIONS, "yarrlist.net"),
    ).toHaveLength(4);
    expect(filterWebDestinations(
      DEFAULT_WEB_DESTINATIONS,
      "",
      "Live TV",
    ).every((item) => item.note?.includes("directory"))).toBe(true);
  });

  it("seeds directory pages without copying provider entries", () => {
    expect(
      DEFAULT_WEB_DESTINATIONS.find(
        (item) => item.title === "YarrList Movies & TV",
      )?.url,
    ).toBe("https://yarrlist.net/movies-and-tv-shows");
    expect(
      DEFAULT_WEB_DESTINATIONS.find(
        (item) => item.title === "AhoyList Live Sports",
      )?.url,
    ).toBe("https://ahoylist.net/live-sports");
    expect(DEFAULT_WEB_DESTINATIONS.some(
      (item) => item.sourceDirectory === "YarrList + AhoyList",
    )).toBe(false);
  });

  it("uses defaults when storage is empty or corrupt", () => {
    expect(
      loadWebDestinations({ getItem: () => null }).items,
    ).toEqual(DEFAULT_WEB_DESTINATIONS);

    const corrupt = loadWebDestinations({ getItem: () => "not json" });
    expect(corrupt.items).toEqual(DEFAULT_WEB_DESTINATIONS);
    expect(corrupt.error).toContain("valid JSON");
  });

  it("stores the versioned backup and reports quota errors", () => {
    let storedKey = "";
    let storedValue = "";
    expect(
      saveWebDestinations(
        {
          setItem: (key, value) => {
            storedKey = key;
            storedValue = value;
          },
        },
        DEFAULT_WEB_DESTINATIONS,
      ),
    ).toBeNull();
    expect(storedKey).toBe(WEB_DESTINATION_STORAGE_KEY);
    expect(parseWebDestinationImport(storedValue)).toEqual(
      DEFAULT_WEB_DESTINATIONS,
    );

    expect(
      saveWebDestinations(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        DEFAULT_WEB_DESTINATIONS,
      ),
    ).toBe("quota");
  });
});
