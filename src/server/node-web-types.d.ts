// Effect 4's Channel declarations refer to the Web TextDecoderOptions name.
// Node 24 exposes the identical options in node:util, without the full DOM lib.
export {};
declare global {
  type TextDecoderOptions = NonNullable<ConstructorParameters<typeof import("node:util").TextDecoder>[1]>;
}
