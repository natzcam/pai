// app.json, plus one thing a static config can't say: the iOS addons are
// linked from the Podfile itself, as CocoaPods reads it. react-native-bare-
// kit's podspecs pick up ios/addons/*.xcframework when `pod install` runs,
// and on EAS the post-install hook (eas-build-post-install) runs too late
// for that (lahar shipped an iOS build with no addons that way).
const { withPodfile } = require('expo/config-plugins')

const MARKER = "# pai: link the worklet's iOS addons"

function withLinkedAddons (config) {
  return withPodfile(config, (podfile) => {
    if (podfile.modResults.contents.includes(MARKER)) return podfile
    podfile.modResults.contents = `${MARKER} (app.config.js)\nsystem("node", File.join(__dir__, "..", "scripts", "link-addons.mjs"), "--platform", "ios") or raise "link-addons.mjs failed"\n\n` + podfile.modResults.contents
    return podfile
  })
}

module.exports = ({ config }) => withLinkedAddons(config)
