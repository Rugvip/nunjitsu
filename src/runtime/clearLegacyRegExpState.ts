const legacyRegExpStateResetPattern = /()()()()()()()()()/;

/** Overwrites every host-realm legacy RegExp capture field with an empty value. */
export function clearLegacyRegExpState(): void {
  legacyRegExpStateResetPattern.exec('');
}
