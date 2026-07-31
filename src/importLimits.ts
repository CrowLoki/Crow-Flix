export const MAX_PLAYLIST_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_XMLTV_IMPORT_BYTES = 128 * 1024 * 1024;

export function assertImportFileSize(
  file: Pick<File, "name" | "size">,
  kind: "playlist" | "programme guide",
  maximumBytes: number,
): void {
  if (file.size <= maximumBytes) return;

  const maximumMiB = maximumBytes / (1024 * 1024);
  throw new Error(
    `${file.name} is too large for a ${kind} import. The limit is ${maximumMiB.toLocaleString()} MiB.`,
  );
}
