// worklet/app.bundle.{android,ios}.js are made by `npm run build:worklet`
// (scripts/pack-worklet.mjs); Metro picks the platform's.
declare module '*/worklet/app.bundle' {
  const bundleBase64: string
  export default bundleBase64
}
