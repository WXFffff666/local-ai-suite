/**
 * Ambient typings for the MIT png-chunks trio (pre-landed deps, CJS, no
 * @types). Only the surface gallery/parameters.ts uses is declared.
 */

declare module 'png-chunks-extract' {
  type PngChunk = { name: string; data: Uint8Array }
  function extractChunks(png: Uint8Array): PngChunk[]
  export = extractChunks
}

declare module 'png-chunks-encode' {
  type PngChunk = { name: string; data: Uint8Array }
  function encodeChunks(chunks: PngChunk[]): Uint8Array
  export = encodeChunks
}

declare module 'png-chunk-text' {
  type TextChunk = { name: 'tEXt'; data: Uint8Array }
  function encode(keyword: string, text: string): TextChunk
  function decode(data: Uint8Array): { keyword: string; text: string }
  export { encode, decode }
}

declare module 'png-chunk-text/encode' {
  function encode(keyword: string, text: string): { name: 'tEXt'; data: Uint8Array }
  export = encode
}

declare module 'png-chunk-text/decode' {
  function decode(data: Uint8Array): { keyword: string; text: string }
  export = decode
}
