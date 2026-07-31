import { describe, expect, it } from "vitest";
import {
  assertImportFileSize,
  MAX_PLAYLIST_IMPORT_BYTES,
  MAX_XMLTV_IMPORT_BYTES,
} from "./importLimits";

describe("import file limits", () => {
  it("accepts files exactly at each limit", () => {
    expect(() =>
      assertImportFileSize(
        { name: "channels.m3u", size: MAX_PLAYLIST_IMPORT_BYTES },
        "playlist",
        MAX_PLAYLIST_IMPORT_BYTES,
      )
    ).not.toThrow();
    expect(() =>
      assertImportFileSize(
        { name: "guide.xml", size: MAX_XMLTV_IMPORT_BYTES },
        "programme guide",
        MAX_XMLTV_IMPORT_BYTES,
      )
    ).not.toThrow();
  });

  it("rejects a file one byte over the limit with useful context", () => {
    expect(() =>
      assertImportFileSize(
        { name: "channels.m3u", size: MAX_PLAYLIST_IMPORT_BYTES + 1 },
        "playlist",
        MAX_PLAYLIST_IMPORT_BYTES,
      )
    ).toThrow(/channels\.m3u.*playlist.*16 MiB/i);
    expect(() =>
      assertImportFileSize(
        { name: "guide.xml", size: MAX_XMLTV_IMPORT_BYTES + 1 },
        "programme guide",
        MAX_XMLTV_IMPORT_BYTES,
      )
    ).toThrow(/guide\.xml.*programme guide.*128 MiB/i);
  });
});
