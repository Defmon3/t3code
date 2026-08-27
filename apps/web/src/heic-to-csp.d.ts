declare module "heic-to/csp" {
  export function heicTo(input: {
    readonly blob: Blob;
    readonly type: string;
    readonly quality: number;
  }): Promise<Blob>;
}
