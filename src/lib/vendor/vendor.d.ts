declare module "@/lib/vendor/three.module.min.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const THREE: any;
  export = THREE;
}

declare module "@/lib/vendor/OrbitControls.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class OrbitControls {
    constructor(object: any, domElement?: HTMLElement);
    enabled: boolean;
    target: { set(x: number, y: number, z: number): void };
    enableDamping: boolean;
    dampingFactor: number;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    update(): boolean;
    dispose(): void;
  }
}
