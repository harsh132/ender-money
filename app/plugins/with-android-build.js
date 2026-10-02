/**
 * Android build tweaks that survive `expo prebuild --clean`.
 *
 * 1. Gradle memory: the default 512 MB metaspace runs out on this project.
 *
 * 2. Sign debug and release builds with our own key (credentials/, gitignored).
 *
 * Passkeys for ender.money are bound to this key's fingerprint through
 * https://ender.money/.well-known/assetlinks.json. The stock React Native debug
 * keystore is public, so any app signed with it could ask for Ender passkeys
 * and derive the user's wallet key. Without credentials/ the build keeps the
 * stock key and passkeys simply won't work.
 */
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

const SIGNING = `
def enderProps = new Properties()
def enderPropsFile = rootProject.file('../credentials/keystore.properties')
if (enderPropsFile.exists()) enderPropsFile.withInputStream { enderProps.load(it) }
`;

const withMemory = (config) =>
  withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((p) => !(p.type === 'property' && p.key === 'org.gradle.jvmargs'));
    cfg.modResults.push({ type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx4g -XX:MaxMetaspaceSize=1g' });
    return cfg;
  });

const withSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (gradle.includes('enderProps')) return cfg;
    gradle = gradle.replace(/^android \{/m, `${SIGNING}\nandroid {`);
    gradle = gradle.replace(
      /signingConfigs \{/,
      `signingConfigs {
        ender {
            if (enderPropsFile.exists()) {
                storeFile rootProject.file('../credentials/' + enderProps['storeFile'])
                storePassword enderProps['storePassword']
                keyAlias enderProps['keyAlias']
                keyPassword enderProps['keyPassword']
            }
        }`,
    );
    gradle = gradle.replace(/signingConfig signingConfigs\.debug/g, 'signingConfig (enderPropsFile.exists() ? signingConfigs.ender : signingConfigs.debug)');
    cfg.modResults.contents = gradle;
    return cfg;
  });

module.exports = (config) => withSigning(withMemory(config));
