declare module 'bwip-js' {
  interface BwipOptions {
    bcid: string;
    text: string;
    scale?: number;
    height?: number;
    includetext?: boolean;
    textxalign?: string;
    padding?: number;
    backgroundcolor?: string;
    [key: string]: unknown;
  }
  function toCanvas(canvas: HTMLCanvasElement, options: BwipOptions): HTMLCanvasElement;
  export { toCanvas };
  export default { toCanvas };
}
