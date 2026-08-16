// Minimal ambient declaration: the repo has no @types/node, and the relay
// tests only need gzipSync to build gzip fixtures.
declare module "node:zlib" {
  export function gzipSync(input: string | Uint8Array): Uint8Array;
}
