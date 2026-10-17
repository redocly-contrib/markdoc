// Typings for the packages the parser shares with markdown-it.

declare module 'entities/lib/maps/entities.json' {
  const entities: Record<string, string>;
  export default entities;
}

declare module 'uc.micro/categories/P/regex' {
  const regex: RegExp;
  export default regex;
}

declare module 'punycode' {
  const punycode: {
    toASCII(input: string): string;
    toUnicode(input: string): string;
  };
  export default punycode;
}

declare module 'mdurl' {
  type Url = {
    protocol: string | null;
    slashes: boolean;
    auth: string | null;
    port: string | null;
    hostname: string | null;
    hash: string | null;
    search: string | null;
    pathname: string | null;
  };
  type Decode = ((input: string, exclude?: string) => string) & {
    defaultChars: string;
    componentChars: string;
  };
  const mdurl: {
    parse(url: string, slashesDenoteHost?: boolean): Url;
    format(url: Url): string;
    encode(input: string, exclude?: string, keepEscaped?: boolean): string;
    decode: Decode;
  };
  export default mdurl;
}
