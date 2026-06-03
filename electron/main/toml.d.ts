declare module '@iarna/toml' {
  const TOML: {
    parse(input: string): Record<string, unknown>;
    stringify(input: Record<string, unknown>): string;
  };
  export default TOML;
}
